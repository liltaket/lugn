const API_ROOT = '/ui/api';

const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const loginForm = document.getElementById('login-form');
const tokenInput = document.getElementById('api-token');
const tokenHelp = document.getElementById('token-help');
const loginError = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');
const loginTitle = document.getElementById('login-title');
const loginDescription = document.getElementById('login-description');
const loginInitialStatus = document.getElementById('login-initial-status');
const clerkLogin = document.getElementById('clerk-login');
const clerkStatus = document.getElementById('clerk-status');
const clerkSignInTarget = document.getElementById('clerk-sign-in');
const clerkRetry = document.getElementById('clerk-retry');
const logoutButton = document.getElementById('logout-button');
const liveStatus = document.getElementById('live-status');
const liveStatusLabel = document.getElementById('live-status-label');
const updatedAt = document.getElementById('updated-at');
const roomPresence = document.getElementById('room-presence');
const presenceTitle = document.getElementById('presence-title');
const presenceDetail = document.getElementById('presence-detail');
const healthTitle = document.getElementById('health-title');
const healthChip = document.getElementById('health-chip');
const integrationList = document.getElementById('integration-list');
const systemAlert = document.getElementById('system-alert');
const sceneSummary = document.getElementById('scene-summary');
const sceneList = document.getElementById('scene-list');
const reapplyButton = document.getElementById('reapply-button');
const mappingSummary = document.getElementById('mapping-summary');
const musicList = document.getElementById('music-list');
const lightList = document.getElementById('light-list');
const actionStatus = document.getElementById('action-status');

let csrfToken = null;
let tokenRequired = true;
let authProvider = 'token';
let authConfigLoaded = false;
let clerkPublishableKey = null;
let clerkClient = null;
let clerkLoadPromise = null;
let clerkSignInMounted = false;
let clerkListener = null;
let clerkHandshakeReady = false;
let clerkExchangeInProgress = false;
let clerkSessionExchangeSuppressed = false;
let clerkSignOutPending = false;
let clerkAccountRejected = false;
let sessionExpiresAt = null;
let sessionRenewTimer = null;
let sessionRenewInProgress = false;
let sessionRenewDone = null;
let overview = null;
let eventSource = null;
let pollTimer = null;
let actionMessage = '';
let actionTone = 'neutral';
const pendingActions = new Set();

class SessionExpiredError extends Error {}
class ClerkAuthorizationError extends Error {}

tokenHelp.textContent =
  'Öppna tunneln från din dator med ssh -N -L 8787:127.0.0.1:8787 <user>@<host> och besök http://127.0.0.1:8787/ui/. Hämta token på Lugn-värden enligt docs/OPERATIONS.md, i ett privat terminalfönster, och klistra in den bara här.';

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void createSession();
});

logoutButton.addEventListener('click', () => {
  void endSession();
});

clerkRetry.addEventListener('click', () => {
  if (clerkSignOutPending) {
    void retryClerkSignOut();
  } else if (clerkAccountRejected) {
    void switchClerkAccount();
  } else if (clerkClient?.session) {
    void exchangeClerkSession(false);
  } else {
    void restoreSessionOnStartup();
  }
});

reapplyButton.addEventListener('click', () => {
  void invokeCapability('lighting.reapplyScene', {}, 'scene');
});

void restoreSessionOnStartup();

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function setLiveStatus(label, tone = 'neutral') {
  liveStatusLabel.textContent = label;
  liveStatus.dataset.tone = tone;
}

function setLoginError(message) {
  loginError.textContent = message;
  loginError.hidden = !message;
}

function updateLoginPresentation() {
  const isClerk = authProvider === 'clerk';
  loginInitialStatus.hidden = authConfigLoaded;
  loginForm.hidden = !authConfigLoaded || isClerk;
  clerkLogin.hidden = !authConfigLoaded || !isClerk;
  tokenHelp.hidden = isClerk;
  loginTitle.textContent = isClerk ? 'Logga in till Lugn' : 'Anslut till Lugn';
  loginDescription.textContent = isClerk
    ? 'Använd ditt Lugn-konto för att se och styra rummets belysning och musik.'
    : 'Logga in för att se och styra rummets belysning och musik.';
  tokenInput.required = !isClerk && tokenRequired;
}

function setActionMessage(message, tone = 'neutral') {
  actionMessage = message;
  actionTone = tone;
  actionStatus.textContent = message;
  actionStatus.dataset.tone = tone;
}

function clearSessionRenewal() {
  if (sessionRenewTimer !== null) window.clearTimeout(sessionRenewTimer);
  sessionRenewTimer = null;
  sessionExpiresAt = null;
}

function parseSessionExpiry(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function scheduleSessionRenewal(expiresAt) {
  if (sessionRenewTimer !== null) window.clearTimeout(sessionRenewTimer);
  sessionRenewTimer = null;
  sessionExpiresAt = parseSessionExpiry(expiresAt);
  if (authProvider !== 'clerk' || sessionExpiresAt === null) return;

  const renewIn = Math.max(1000, sessionExpiresAt - Date.now() - 20_000);
  sessionRenewTimer = window.setTimeout(() => {
    sessionRenewTimer = null;
    void renewClerkSession();
  }, renewIn);
}

function scheduleRenewalRetry() {
  if (sessionRenewTimer !== null) window.clearTimeout(sessionRenewTimer);
  if (sessionExpiresAt === null) return;
  const untilExpiry = sessionExpiresAt - Date.now();
  const retryIn = Math.max(1000, Math.min(10_000, untilExpiry - 5000));
  sessionRenewTimer = window.setTimeout(() => {
    sessionRenewTimer = null;
    void renewClerkSession();
  }, retryIn);
}

function showLogin(message = '') {
  clearSessionRenewal();
  stopLiveUpdates();
  csrfToken = null;
  overview = null;
  pendingActions.clear();
  dashboardView.hidden = true;
  loginView.hidden = false;
  logoutButton.hidden = true;
  tokenInput.disabled = authProvider === 'clerk';
  loginSubmit.disabled = authProvider === 'clerk';
  loginSubmit.textContent = 'Anslut';
  tokenInput.value = '';
  updateLoginPresentation();
  setLoginError(message);
  if (authProvider === 'clerk') {
    if (clerkSignOutPending) {
      clerkStatus.textContent =
        'Lugn-sessionen är avslutad. Logga ut från Clerk för att slutföra.';
      clerkStatus.hidden = false;
      clerkSignInTarget.hidden = true;
      clerkRetry.hidden = false;
    } else if (clerkClient?.session) {
      clerkStatus.textContent = 'Slutför inloggningen till Lugn.';
      clerkStatus.hidden = false;
      clerkSignInTarget.hidden = true;
      clerkRetry.hidden = true;
    } else {
      clerkStatus.hidden = true;
      clerkSignInTarget.hidden = false;
      clerkRetry.hidden = true;
      mountClerkSignIn();
    }
  }
  setLiveStatus('Inte ansluten');
}

function showDashboard() {
  loginView.hidden = true;
  dashboardView.hidden = false;
  logoutButton.hidden = false;
  logoutButton.disabled = false;
  if (clerkSignInMounted) {
    clerkClient?.unmountSignIn?.(clerkSignInTarget);
    clerkSignInMounted = false;
  }
}

async function createSession() {
  if (authProvider !== 'token') return;
  const token = tokenInput.value;
  if (tokenRequired && !token) return;

  await startSession(token, false);
}

async function startSession(credential, automatic) {
  if (authProvider === 'token' && tokenRequired && !credential) return;

  loginSubmit.disabled = true;
  loginSubmit.textContent = 'Ansluter…';
  loginSubmit.setAttribute('aria-busy', 'true');
  tokenInput.disabled = authProvider === 'clerk';
  setLoginError('');
  setLiveStatus('Skapar session', 'warn');
  if (authProvider === 'clerk') {
    clerkStatus.textContent = 'Verifierar inloggningen med Lugn…';
    clerkStatus.hidden = false;
    clerkSignInTarget.hidden = true;
    clerkRetry.hidden = true;
    if (clerkSignInMounted) {
      clerkClient?.unmountSignIn?.(clerkSignInTarget);
      clerkSignInMounted = false;
    }
  }

  try {
    const response = await fetch(`${API_ROOT}/session`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        authProvider === 'clerk'
          ? { sessionToken: credential }
          : { token: credential },
      ),
    });
    if (!response.ok) {
      if (response.status === 401 && authProvider === 'clerk')
        throw new Error('Clerk-sessionen kunde inte verifieras. Försök igen.');
      if (response.status === 403 && authProvider === 'clerk') {
        clerkAccountRejected = true;
        throw new Error('Det här Clerk-kontot har inte åtkomst till Lugn.');
      }
      if (response.status === 401 || response.status === 403)
        throw new Error('Kontrollera token och försök igen.');
      throw new Error('Sessionen kunde inte skapas. Försök igen.');
    }

    const result = await response.json();
    if (typeof result?.csrfToken !== 'string' || result.csrfToken.length === 0)
      throw new Error('Servern gav ingen giltig session. Försök igen.');
    const expiresAt = parseSessionExpiry(result.expiresAt);
    if (authProvider === 'clerk' && expiresAt === null)
      throw new Error('Servern gav ingen giltig sluttid för sessionen.');

    csrfToken = result.csrfToken;
    clerkAccountRejected = false;
    tokenInput.value = '';
    await openDashboard(result.csrfToken, expiresAt);
  } catch (error) {
    csrfToken = null;
    tokenInput.value = '';
    if (error instanceof SessionExpiredError) {
      setLoginError('Sessionen kunde inte verifieras. Logga in igen.');
    } else if (error instanceof Error) {
      setLoginError(error.message);
    } else {
      setLoginError('Sessionen kunde inte skapas. Försök igen.');
    }
    if (automatic && !tokenRequired && authProvider === 'token')
      setLoginError('Den lokala sessionen kunde inte skapas. Försök igen.');
    if (authProvider === 'clerk') {
      clerkStatus.hidden = true;
      clerkSignInTarget.hidden = true;
      clerkRetry.hidden = true;
      if (clerkClient?.session) {
        clerkRetry.textContent = clerkAccountRejected
          ? 'Byt Clerk-konto'
          : 'Försök igen';
        clerkRetry.hidden = false;
      } else clerkSignInTarget.hidden = false;
    }
    setLiveStatus('Inte ansluten', 'bad');
  } finally {
    tokenInput.disabled = authProvider === 'clerk';
    loginSubmit.disabled = authProvider === 'clerk';
    loginSubmit.textContent = 'Anslut';
    loginSubmit.removeAttribute('aria-busy');
  }
}

async function fetchAuthConfiguration() {
  const response = await fetch(`${API_ROOT}/auth-config`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  // Permit an older Lugn release to keep using its token-based login.
  if (response.status === 404) return { provider: 'token' };
  if (!response.ok)
    throw new Error('Inloggningsinställningar kunde inte hämtas.');

  const config = await response.json();
  if (config?.provider === 'token') return { provider: 'token' };
  if (
    config?.provider === 'clerk' &&
    typeof config.publishableKey === 'string'
  ) {
    return {
      provider: 'clerk',
      publishableKey: config.publishableKey,
    };
  }
  throw new Error('Servern returnerade ogiltiga inloggningsinställningar.');
}

function clerkFrontendOrigin(publishableKey) {
  const match = /^(pk_(?:test|live)_)([A-Za-z0-9_-]+={0,2})$/.exec(
    publishableKey,
  );
  if (!match) throw new Error('Clerk-nyckeln har ett ogiltigt format.');

  const encoded = match[2]
    .replace(/=+$/, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
  const decoded = window.atob(padded);
  if (!decoded.endsWith('$'))
    throw new Error('Clerk-nyckeln saknar en giltig frontend-adress.');

  const frontendHost = decoded.slice(0, -1);
  if (
    frontendHost.length > 253 ||
    frontendHost !== frontendHost.toLowerCase() ||
    !frontendHost.includes('.') ||
    frontendHost
      .split('.')
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      )
  )
    throw new Error('Clerk-nyckeln innehåller en ogiltig frontend-adress.');

  const frontendUrl = new URL(`https://${frontendHost}`);
  if (frontendUrl.hostname !== frontendHost || frontendUrl.port !== '')
    throw new Error('Clerk-nyckeln innehåller en ogiltig frontend-adress.');
  return frontendUrl.origin;
}

function loadClerkScript(url, publishableKey = null) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error('Clerk tog för lång tid att ladda.'));
    }, 30000);

    script.async = true;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.src = url;
    if (publishableKey)
      script.setAttribute('data-clerk-publishable-key', publishableKey);
    script.addEventListener(
      'load',
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      'error',
      () => {
        window.clearTimeout(timeout);
        script.remove();
        reject(new Error('Clerk kunde inte laddas. Kontrollera anslutningen.'));
      },
      { once: true },
    );
    document.head.append(script);
  });
}

async function initializeClerk(publishableKey) {
  if (clerkClient) return clerkClient;
  if (clerkLoadPromise) return clerkLoadPromise;
  if (typeof publishableKey !== 'string' || publishableKey.length === 0)
    throw new Error('Clerk saknar en publicerbar nyckel.');

  clerkLoadPromise = (async () => {
    const frontendOrigin = clerkFrontendOrigin(publishableKey);
    await loadClerkScript(
      `${frontendOrigin}/npm/@clerk/ui@1/dist/ui.browser.js`,
    );
    if (typeof window.__internal_ClerkUICtor !== 'function')
      throw new Error('Clerks inloggningsgränssnitt kunde inte laddas.');
    await loadClerkScript(
      `${frontendOrigin}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`,
      publishableKey,
    );

    const instance = window.Clerk;
    if (
      !instance ||
      typeof instance.load !== 'function' ||
      typeof instance.mountSignIn !== 'function' ||
      typeof instance.addListener !== 'function'
    ) {
      throw new Error('Clerk kunde inte startas i den här webbläsaren.');
    }

    await instance.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
    });
    clerkClient = instance;
    return instance;
  })().catch((error) => {
    clerkLoadPromise = null;
    throw error;
  });
  return clerkLoadPromise;
}

function mountClerkSignIn() {
  if (!clerkClient || clerkSignInMounted || clerkClient.session) return;
  try {
    clerkClient.mountSignIn(clerkSignInTarget, {
      routing: 'hash',
      withSignUp: true,
      fallbackRedirectUrl: '/ui/',
      forceRedirectUrl: '/ui/',
      signUpFallbackRedirectUrl: '/ui/',
      signUpForceRedirectUrl: '/ui/',
      appearance: {
        variables: {
          colorPrimary: '#d2d59a',
          colorBackground: '#222f2a',
          colorText: '#f1f4ef',
          colorTextSecondary: '#c0ccc4',
          colorInputBackground: '#18221e',
          colorInputText: '#f1f4ef',
          colorDanger: '#edb4a8',
          borderRadius: '8px',
        },
        elements: {
          rootBox: 'clerk-root-box',
          cardBox: 'clerk-card-box',
        },
      },
    });
    clerkSignInMounted = true;
  } catch {
    clerkStatus.textContent =
      'Clerk kunde inte visa inloggningen. Försök igen.';
    clerkStatus.hidden = false;
    clerkSignInTarget.hidden = true;
    clerkRetry.hidden = false;
  }
}

function observeClerkSession() {
  if (clerkListener || !clerkClient?.addListener) return;
  clerkListener = clerkClient.addListener(
    ({ session }) => {
      if (!clerkHandshakeReady || clerkSessionExchangeSuppressed) return;
      if (session === null && csrfToken) {
        void endSession();
        return;
      }
      if (!session || csrfToken || clerkExchangeInProgress) return;
      void exchangeClerkSession(true);
    },
    { skipInitialEmit: true },
  );
}

async function exchangeClerkSession(automatic) {
  if (
    clerkExchangeInProgress ||
    clerkSessionExchangeSuppressed ||
    !clerkClient?.session
  ) {
    return;
  }
  clerkExchangeInProgress = true;
  try {
    const sessionToken = await clerkClient.session.getToken();
    if (!sessionToken)
      throw new Error('Clerk gav ingen giltig session. Logga in igen.');
    await startSession(sessionToken, automatic);
  } catch (error) {
    setLoginError(
      error instanceof Error
        ? error.message
        : 'Clerk-sessionen kunde inte skickas till Lugn. Försök igen.',
    );
    clerkStatus.hidden = true;
    clerkSignInTarget.hidden = true;
    clerkRetry.hidden = false;
    setLiveStatus('Inte ansluten', 'bad');
  } finally {
    clerkExchangeInProgress = false;
  }
}

async function renewClerkSession() {
  if (
    sessionRenewInProgress ||
    authProvider !== 'clerk' ||
    !csrfToken ||
    !clerkClient?.session
  ) {
    return;
  }
  sessionRenewInProgress = true;
  let finishRenewal;
  sessionRenewDone = new Promise((resolve) => {
    finishRenewal = resolve;
  });
  const previousExpiry = sessionExpiresAt;
  try {
    const sessionToken = await clerkClient.session.getToken({
      skipCache: true,
    });
    if (!sessionToken)
      throw new ClerkAuthorizationError('Clerk-sessionen har gått ut.');

    const response = await fetch(`${API_ROOT}/session`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToken }),
    });
    if (response.status === 401 || response.status === 403)
      throw new ClerkAuthorizationError('Clerk-sessionen kan inte verifieras.');
    if (!response.ok) throw new Error('Lugn-sessionen kunde inte förnyas.');

    const result = await response.json();
    const expiresAt = parseSessionExpiry(result?.expiresAt);
    if (typeof result?.csrfToken !== 'string' || expiresAt === null)
      throw new Error('Lugn returnerade en ogiltig förnyad session.');

    csrfToken = result.csrfToken;
    scheduleSessionRenewal(expiresAt);
    try {
      overview = await fetchOverview();
    } catch (error) {
      if (error instanceof SessionExpiredError)
        throw new ClerkAuthorizationError(
          'Den förnyade sessionen kunde inte verifieras.',
        );
      throw error;
    }
    render();
    startLiveUpdates();
    if (
      actionMessage ===
      'Sessionen förnyas automatiskt. Återförsök väntar på anslutningen.'
    ) {
      setActionMessage('Sessionen är aktiv.');
    }
  } catch (error) {
    const authorizationFailed = error instanceof ClerkAuthorizationError;
    if (
      !authorizationFailed &&
      previousExpiry !== null &&
      Date.now() + 5000 < sessionExpiresAt
    ) {
      setActionMessage(
        'Sessionen förnyas automatiskt. Återförsök väntar på anslutningen.',
        'warn',
      );
      scheduleRenewalRetry();
      return;
    }

    const message = authorizationFailed
      ? 'Clerk-sessionen kan inte längre verifieras. Logga in igen.'
      : 'Lugn-sessionen hann gå ut innan den kunde förnyas. Logga in igen.';
    clearSessionRenewal();
    stopLiveUpdates();
    csrfToken = null;
    clerkSessionExchangeSuppressed = true;
    try {
      if (clerkClient?.session) await clerkClient.signOut();
      clerkSignOutPending = false;
      clerkSessionExchangeSuppressed = false;
      showLogin(message);
    } catch {
      clerkSignOutPending = true;
      showLogin(`${message} Logga också ut från Clerk för att fortsätta.`);
    }
  } finally {
    sessionRenewInProgress = false;
    finishRenewal();
    sessionRenewDone = null;
  }
}

async function restoreSessionOnStartup() {
  loginSubmit.disabled = true;
  tokenInput.disabled = true;
  loginSubmit.textContent = 'Kontrollerar session…';
  setLiveStatus('Kontrollerar session', 'warn');
  try {
    const authConfig = await fetchAuthConfiguration();
    authConfigLoaded = true;
    authProvider = authConfig.provider;
    clerkPublishableKey = authConfig.publishableKey ?? null;
    tokenRequired = true;
    updateLoginPresentation();
    if (authProvider === 'clerk') {
      clerkStatus.textContent = 'Kontrollerar Lugn-sessionen…';
      clerkStatus.hidden = false;
      clerkSignInTarget.hidden = true;
    }

    const response = await fetch(`${API_ROOT}/session`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error('Sessionsstatus kunde inte hämtas.');
    const session = await response.json();
    if (typeof session?.tokenRequired !== 'boolean')
      throw new Error('Sessionsstatus kunde inte tolkas.');
    if (session.provider && session.provider !== authProvider)
      throw new Error('Inloggningsläget ändrades. Ladda om sidan.');

    tokenRequired = session.tokenRequired;
    updateLoginPresentation();

    if (authProvider === 'clerk') {
      if (session.authenticated === true) {
        const expiresAt = parseSessionExpiry(session.expiresAt);
        if (
          typeof session.csrfToken !== 'string' ||
          session.csrfToken.length === 0 ||
          expiresAt === null
        ) {
          throw new Error('Servern returnerade en ogiltig Clerk-session.');
        }
        try {
          await openDashboard(session.csrfToken, expiresAt);
        } catch {
          showLogin('Sessionen kunde inte återupptas. Logga in igen.');
        }
        void initializeClerk(clerkPublishableKey)
          .then(() => {
            observeClerkSession();
            clerkHandshakeReady = true;
            if (csrfToken && sessionExpiresAt !== null)
              scheduleSessionRenewal(sessionExpiresAt);
            else if (!csrfToken && clerkClient.session)
              void exchangeClerkSession(true);
            else if (!csrfToken) showLogin();
          })
          .catch(() => {
            if (csrfToken) {
              setActionMessage(
                'Lugn-sessionen fungerar, men Clerk kunde inte ansluta. Kontrollera nätverket innan du loggar ut.',
                'warn',
              );
            } else {
              clerkStatus.textContent =
                'Clerk kunde inte starta. Kontrollera anslutningen och försök igen.';
              clerkStatus.hidden = false;
              clerkSignInTarget.hidden = true;
              clerkRetry.hidden = false;
            }
          });
        return;
      }

      await initializeClerk(clerkPublishableKey);
      observeClerkSession();
      clerkHandshakeReady = true;
      if (clerkClient.session) {
        await exchangeClerkSession(true);
      } else {
        showLogin();
      }
      return;
    }

    if (
      session.authenticated === true &&
      typeof session.csrfToken === 'string' &&
      session.csrfToken.length > 0
    ) {
      try {
        await openDashboard(
          session.csrfToken,
          parseSessionExpiry(session.expiresAt),
        );
        return;
      } catch {
        showLogin('Sessionen kunde inte återupptas. Logga in igen.');
      }
    }

    if (!tokenRequired) {
      await startSession('', true);
      return;
    }
    tokenInput.disabled = false;
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Anslut';
    setLiveStatus('Inloggning krävs');
  } catch (error) {
    if (!authConfigLoaded) {
      loginInitialStatus.textContent =
        'Inloggningen kunde inte kontrolleras. Ladda om sidan och försök igen.';
      loginInitialStatus.hidden = false;
      loginForm.hidden = true;
      clerkLogin.hidden = true;
      setLoginError(
        error instanceof Error
          ? error.message
          : 'Inloggningsinställningar kunde inte hämtas.',
      );
      setLiveStatus('Kan inte kontrollera inloggning', 'bad');
      return;
    }
    updateLoginPresentation();
    if (authProvider === 'clerk') {
      clerkStatus.textContent =
        'Clerk kunde inte starta. Kontrollera anslutningen och försök igen.';
      clerkStatus.hidden = false;
      clerkSignInTarget.hidden = true;
      clerkRetry.hidden = false;
    }
    tokenRequired = true;
    updateLoginPresentation();
    tokenInput.disabled = authProvider === 'clerk';
    loginSubmit.disabled = authProvider === 'clerk';
    loginSubmit.textContent = 'Anslut';
    setLoginError(
      error instanceof Error
        ? error.message
        : 'Sessionsstatus kunde inte hämtas. Kontrollera SSH-tunneln och försök igen.',
    );
    setLiveStatus('Kan inte kontrollera session', 'bad');
  }
}

async function openDashboard(sessionCsrfToken, expiresAt = null) {
  csrfToken = sessionCsrfToken;
  scheduleSessionRenewal(expiresAt);
  try {
    overview = await fetchOverview();
  } catch (error) {
    csrfToken = null;
    clearSessionRenewal();
    throw error;
  }
  showDashboard();
  render();
  startLiveUpdates();
  setActionMessage('Ansluten till Lugn.');
}

async function endSession() {
  logoutButton.disabled = true;
  setActionMessage('Loggar ut…');
  try {
    if (sessionRenewDone) await sessionRenewDone;
    const headers = {};
    if (csrfToken) headers['X-Lugn-CSRF'] = csrfToken;
    const response = await fetch(`${API_ROOT}/session`, {
      method: 'DELETE',
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
    });
    if (!response.ok && response.status !== 401)
      throw new Error('Lugn-sessionen kunde inte avslutas. Försök igen.');
    csrfToken = null;
    clearSessionRenewal();

    if (authProvider === 'clerk') {
      clerkSessionExchangeSuppressed = true;
      try {
        await signOutOfClerk();
      } catch {
        clerkSignOutPending = true;
        showLogin(
          'Lugn-sessionen avslutades, men Clerk kunde inte loggas ut. Försök igen.',
        );
        return;
      }
    }

    showLogin('Du har loggat ut.');
  } catch (error) {
    logoutButton.disabled = false;
    setActionMessage(
      error instanceof Error
        ? error.message
        : 'Utloggningen misslyckades. Försök igen.',
      'bad',
    );
  }
}

async function signOutOfClerk() {
  const clerk = await initializeClerk(clerkPublishableKey);
  if (clerk.session) await clerk.signOut();
  clerkSignOutPending = false;
  clerkAccountRejected = false;
  clerkSessionExchangeSuppressed = false;
}

async function switchClerkAccount() {
  clerkRetry.disabled = true;
  clerkRetry.textContent = 'Byter konto…';
  try {
    clerkSessionExchangeSuppressed = true;
    await signOutOfClerk();
    showLogin('Logga in med ett Clerk-konto som har åtkomst till Lugn.');
  } catch {
    clerkSignOutPending = true;
    setLoginError(
      'Clerk kunde inte logga ut. Kontrollera anslutningen och försök igen.',
    );
    clerkStatus.textContent = 'Utloggningen från Clerk väntar.';
    clerkStatus.hidden = false;
    clerkSignInTarget.hidden = true;
    clerkRetry.hidden = false;
  } finally {
    clerkRetry.disabled = false;
    if (clerkRetry.textContent === 'Byter konto…')
      clerkRetry.textContent = 'Byt Clerk-konto';
  }
}

async function retryClerkSignOut() {
  if (!clerkSignOutPending) return;
  clerkRetry.disabled = true;
  clerkRetry.textContent = 'Loggar ut…';
  setLoginError('');
  clerkStatus.textContent = 'Loggar ut från Clerk…';
  clerkStatus.hidden = false;
  try {
    await signOutOfClerk();
    showLogin('Du har loggat ut.');
  } catch {
    setLoginError(
      'Lugn-sessionen är avslutad, men Clerk kunde inte loggas ut. Kontrollera anslutningen och försök igen.',
    );
    clerkStatus.textContent = 'Utloggningen från Clerk väntar.';
    clerkStatus.hidden = false;
    clerkSignInTarget.hidden = true;
    clerkRetry.hidden = false;
  } finally {
    clerkRetry.disabled = false;
    clerkRetry.textContent = 'Försök igen';
  }
}

async function fetchOverview() {
  const response = await fetch(`${API_ROOT}/overview`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (response.status === 401 || response.status === 403)
    throw new SessionExpiredError('Sessionen har gått ut.');
  if (!response.ok) throw new Error('Rumsstatus kunde inte hämtas.');
  const result = await response.json();
  if (!result?.state?.presence || !result?.state?.lighting?.devices)
    throw new Error('Servern returnerade ett ogiltigt rumsstatus.');
  return result;
}

function startLiveUpdates() {
  stopLiveUpdates();
  setLiveStatus('Ansluter till liveuppdateringar', 'warn');
  eventSource = new EventSource(`${API_ROOT}/events`, {
    withCredentials: true,
  });
  eventSource.onopen = () => setLiveStatus('Liveuppdatering ansluten', 'good');
  eventSource.onmessage = (event) => {
    try {
      const next = JSON.parse(event.data);
      if (!next?.state?.presence || !next?.state?.lighting?.devices) return;
      overview = next;
      render();
    } catch {
      setLiveStatus('Ogiltig liveuppdatering', 'warn');
    }
  };
  eventSource.onerror = () => {
    if (eventSource?.readyState === EventSource.CLOSED) {
      setLiveStatus('Liveuppdatering stängd', 'bad');
    } else {
      setLiveStatus('Liveuppdatering återansluter', 'warn');
    }
  };
  pollTimer = window.setInterval(() => {
    if (!eventSource || eventSource.readyState === EventSource.OPEN) return;
    void refreshOverview();
  }, 15000);
}

function stopLiveUpdates() {
  if (eventSource) eventSource.close();
  eventSource = null;
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshOverview() {
  try {
    overview = await fetchOverview();
    render();
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      if (authProvider === 'clerk' && clerkClient?.session) {
        if (!sessionRenewInProgress) void renewClerkSession();
        return;
      }
      showLogin('Sessionen har gått ut. Logga in igen.');
      return;
    }
    setLiveStatus('Kan inte hämta status', 'bad');
  }
}

async function invokeCapability(capability, input, actionKey) {
  if (!csrfToken || pendingActions.has(actionKey)) return;
  const isMusic = capability.startsWith('music.');
  pendingActions.add(actionKey);
  setActionMessage(isMusic ? 'Skickar musikbegäran…' : 'Skickar begäran…');
  render();

  try {
    const response = await fetch(
      `${API_ROOT}/capabilities/${encodeURIComponent(capability)}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'X-Lugn-CSRF': csrfToken,
        },
        body: JSON.stringify({ input }),
      },
    );
    if (response.status === 401 || response.status === 403)
      throw new SessionExpiredError('Sessionen har gått ut.');
    if (!response.ok) {
      if (response.status === 400 || response.status === 404) {
        const failure = await response.json().catch(() => ({}));
        const musicErrors = {
          music_state_unavailable:
            'Spelaren måste rapportera en färsk volym innan en mjuk ändring kan börja.',
          music_fade_duration_too_short:
            'Välj en längre ändring för det här volymsteget.',
          source_not_allowed: 'Den valda källan är inte tillåten för spelaren.',
          target_not_configured: 'Spelaren är inte konfigurerad.',
        };
        throw new Error(
          isMusic
            ? (musicErrors[failure.error] ??
                'Begäran kunde inte användas. Kontrollera spelaren och dess tillåtna källor.')
            : 'Begäran kunde inte användas. Kontrollera vald scen eller lampa.',
        );
      }
      throw new Error('Begäran kunde inte skickas. Försök igen.');
    }
    setActionMessage(
      isMusic
        ? 'Musikbegäran skickad. Spelarens rapporterade läge visar om ändringen har nått fram.'
        : overview?.state?.presence?.state === 'confirmed_empty'
          ? 'Önskat läge sparat. Lamporna hålls släckta tills rummet blir upptaget.'
          : 'Begäran skickad. Lampornas rapporterade läge visar om ändringen har nått fram.',
    );
    await refreshOverview();
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      if (authProvider === 'clerk' && clerkClient?.session) {
        if (!sessionRenewInProgress) void renewClerkSession();
        setActionMessage(
          'Sessionen förnyas. Försök skicka ändringen igen när den är klar.',
          'warn',
        );
        return;
      }
      showLogin('Sessionen har gått ut. Logga in igen.');
      return;
    }
    setActionMessage(
      error instanceof Error
        ? error.message
        : 'Begäran kunde inte skickas. Försök igen.',
      'bad',
    );
  } finally {
    pendingActions.delete(actionKey);
    if (overview) render();
  }
}

function render() {
  if (!overview) return;
  const focusedKey = document.activeElement?.dataset?.focusKey;
  const focusedValue =
    document.activeElement instanceof HTMLInputElement &&
    document.activeElement.type === 'range'
      ? document.activeElement.value
      : null;
  showDashboard();
  renderRoomStatus(overview);
  renderScenes(overview);
  const music = overview.state?.music ?? {};
  renderMusic(music.devices ?? {}, music.commands ?? [], music.fades ?? {});
  const devices = overview.state?.lighting?.devices ?? {};
  const presenceState = overview.state?.presence?.state ?? 'unknown';
  renderLights(devices, presenceState);
  renderMappingSummary(devices, presenceState);
  renderUpdatedAt(overview.state?.updatedAt);
  actionStatus.textContent = actionMessage;
  actionStatus.dataset.tone = actionTone;
  restoreFocus(focusedKey, focusedValue);
}

function restoreFocus(focusedKey, focusedValue) {
  if (!focusedKey) return;
  const element = [...document.querySelectorAll('[data-focus-key]')].find(
    (candidate) => candidate.dataset.focusKey === focusedKey,
  );
  if (!element) return;
  element.focus({ preventScroll: true });
  if (
    focusedValue !== null &&
    element instanceof HTMLInputElement &&
    element.type === 'range' &&
    !element.disabled
  ) {
    element.value = focusedValue;
    element.setAttribute('aria-valuetext', `${focusedValue} procent`);
    const output = element
      .closest('.brightness-control, .music-volume-control')
      ?.querySelector('.brightness-value, .music-volume-preview');
    if (output) output.textContent = `Nytt reglagevärde ${focusedValue}%`;
  }
}

function renderRoomStatus(data) {
  const presence = data.state.presence ?? {};
  const tone = presenceTone(presence.state);
  roomPresence.dataset.tone = tone;
  const presenceLabels = {
    occupied: 'Någon i rummet',
    confirmed_empty: 'Rummet är tomt',
    unknown: 'Närvaro okänd',
  };
  presenceTitle.textContent = presenceLabels[presence.state] ?? 'Närvaro okänd';
  if (presence.state === 'occupied' && Number.isInteger(presence.personCount)) {
    const count = presence.personCount;
    presenceDetail.textContent = `${count} ${count === 1 ? 'person' : 'personer'} registrerade`;
  } else if (presence.state === 'confirmed_empty') {
    presenceDetail.textContent =
      'Rummet är tomt. Lamporna hålls släckta; vald scen återupptas vid nästa besök.';
  } else {
    presenceDetail.textContent = 'Lugn inväntar en säker närvarosignal';
  }

  const health = data.health ?? {};
  const healthLabels = {
    ok: ['Systemet igång', 'good'],
    degraded: ['Begränsad drift', 'warn'],
  };
  const [label, healthTone] = healthLabels[health.status] ?? [
    'Okänd status',
    'neutral',
  ];
  healthTitle.textContent = label;
  healthChip.textContent =
    health.status === 'ok'
      ? 'Normal'
      : health.status === 'degraded'
        ? 'Degraderad'
        : 'Okänd';
  healthChip.dataset.tone = healthTone;
  integrationList.replaceChildren();
  const integrations = Object.entries(health.integrations ?? {}).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  if (integrations.length === 0) {
    const item = node('li', 'integration-item');
    item.append(node('span', 'integration-name', 'Integrationer'));
    item.append(node('span', 'integration-value', 'Ingen status'));
    integrationList.append(item);
  }
  for (const [name, status] of integrations) {
    const [statusLabel, statusTone] = integrationStatus(status);
    const item = node('li', 'integration-item');
    item.append(node('span', 'integration-name', integrationLabel(name)));
    const value = node('span', 'integration-value', statusLabel);
    value.dataset.tone = statusTone;
    item.append(value);
    integrationList.append(item);
  }

  systemAlert.hidden = health.status === 'ok';
  systemAlert.textContent =
    health.status === 'degraded'
      ? 'En eller flera anslutningar är begränsade. Se status per integration innan du felsöker en lampa.'
      : health.status === 'ok'
        ? ''
        : 'Systemstatus är okänd. Lampornas rapporterade värden kan vara inaktuella.';
}

function renderScenes(data) {
  const scenes = Array.isArray(data.scenes) ? data.scenes : [];
  const currentScene = data.state.lighting.currentScene;
  const currentSceneInfo = scenes.find((scene) => scene.id === currentScene);
  sceneSummary.textContent = currentSceneInfo
    ? `Vald scen: ${currentSceneInfo.name}`
    : currentScene
      ? 'En scen är vald men finns inte i den aktuella scenlistan.'
      : 'Ingen aktiv scen';
  reapplyButton.hidden = !currentScene;
  reapplyButton.disabled = pendingActions.has('scene');
  reapplyButton.dataset.focusKey = 'reapply-scene';

  sceneList.replaceChildren();
  if (scenes.length === 0) {
    sceneList.append(
      node('p', 'empty-note', 'Inga ljusscener är konfigurerade.'),
    );
    return;
  }
  for (const scene of scenes) {
    const selected = scene.id === currentScene;
    const button = node('button', 'scene-button');
    button.type = 'button';
    button.disabled = pendingActions.has('scene');
    button.setAttribute('aria-pressed', String(selected));
    button.dataset.focusKey = `scene:${scene.id}`;
    const name = node('span', 'scene-name', scene.name);
    button.append(name);
    if (selected) button.append(node('span', 'scene-selected', 'Vald'));
    button.addEventListener('click', () => {
      void invokeCapability(
        'lighting.activateScene',
        { sceneId: scene.id },
        'scene',
      );
    });
    sceneList.append(button);
  }
}

function renderMusic(devices, commands, fades = {}) {
  musicList.replaceChildren();
  const entries = Object.entries(devices).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    musicList.append(
      node(
        'p',
        'empty-note',
        'Ingen musikspelare är konfigurerad för Lugn ännu.',
      ),
    );
    return;
  }
  for (const [target, device] of entries) {
    musicList.append(
      renderMusicPlayer(target, device, commands, fades[target]),
    );
  }
}

function renderMusicPlayer(target, device, commands, fade) {
  const article = node('article', 'music-row');
  const identity = node('div', 'music-identity');
  identity.append(node('h3', '', displayMusicTarget(target)));
  identity.append(node('code', '', target));
  const availability = availabilityStatus(device.availability);
  identity.append(stateChip(availability.label, availability.tone));
  article.append(identity);

  const observed = device.observed ?? {};
  const readings = node('dl', 'music-readings');
  appendReading(
    readings,
    'Rapporterad uppspelning',
    musicPlaybackLabel(observed.playback),
  );
  appendReading(
    readings,
    'Nu spelas',
    typeof observed.title === 'string' && observed.title.trim()
      ? observed.title
      : 'Ingen titel rapporterad',
  );
  appendReading(
    readings,
    'Rapporterad volym',
    musicVolumeLabel(observed.volume),
  );
  appendReading(
    readings,
    'Rapporterad källa',
    typeof observed.source === 'string' && observed.source
      ? observed.source
      : 'Okänd',
  );
  article.append(readings);

  const controls = node('div', 'music-controls');
  const unavailable = device.availability !== 'available';
  const playbackCommand = latestMusicCommand(commands, target, 'playback');
  const volumeCommand = latestMusicCommand(commands, target, 'volume');
  const sourceCommand = latestMusicCommand(commands, target, 'source');
  const playbackKey = `music:${target}:playback`;
  const volumeKey = `music:${target}:volume`;
  const sourceKey = `music:${target}:source`;

  const playbackControl = node('div', 'music-control');
  playbackControl.append(node('p', 'music-control-title', 'Uppspelning'));
  const transport = node('div', 'music-transport');
  const playButton = node('button', 'button button-quiet', 'Spela / återuppta');
  playButton.type = 'button';
  playButton.disabled =
    unavailable || musicPropertyPending(playbackCommand, playbackKey);
  playButton.setAttribute(
    'aria-label',
    `Spela eller återuppta ${displayMusicTarget(target)}`,
  );
  playButton.dataset.focusKey = `${playbackKey}:play`;
  playButton.addEventListener('click', () => {
    void invokeCapability('music.play', { target }, playbackKey);
  });
  const pauseButton = node('button', 'button button-quiet', 'Pausa');
  pauseButton.type = 'button';
  pauseButton.disabled =
    unavailable || musicPropertyPending(playbackCommand, playbackKey);
  pauseButton.setAttribute('aria-label', `Pausa ${displayMusicTarget(target)}`);
  pauseButton.dataset.focusKey = `${playbackKey}:pause`;
  pauseButton.addEventListener('click', () => {
    void invokeCapability('music.pause', { target }, playbackKey);
  });
  transport.append(playButton, pauseButton);
  playbackControl.append(transport);
  playbackControl.append(
    renderMusicRequest(device, 'playback', playbackCommand),
  );
  controls.append(playbackControl);

  const volumeControl = node('div', 'music-control music-volume-control');
  volumeControl.append(node('p', 'music-control-title', 'Volym'));
  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.id = `music-volume-${target.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
  volumeSlider.min = '0';
  volumeSlider.max = '100';
  volumeSlider.step = '1';
  const requestedVolume = device.requested?.volume;
  const initialVolume =
    typeof requestedVolume === 'number' && Number.isFinite(requestedVolume)
      ? requestedVolume
      : typeof observed.volume === 'number' && Number.isFinite(observed.volume)
        ? observed.volume
        : 0;
  volumeSlider.value = String(Math.round(initialVolume * 100));
  volumeSlider.disabled =
    unavailable || musicPropertyPending(volumeCommand, volumeKey);
  volumeSlider.setAttribute(
    'aria-label',
    `Ställ volym för ${displayMusicTarget(target)}`,
  );
  volumeSlider.setAttribute('aria-valuetext', `${volumeSlider.value} procent`);
  volumeSlider.dataset.focusKey = `${volumeKey}:slider`;
  const volumePreview = node(
    'output',
    'music-volume-preview',
    `Reglagevärde ${volumeSlider.value}%`,
  );
  volumePreview.htmlFor = volumeSlider.id;
  volumeSlider.addEventListener('input', () => {
    volumeSlider.setAttribute(
      'aria-valuetext',
      `${volumeSlider.value} procent`,
    );
    volumePreview.textContent = `Nytt reglagevärde ${volumeSlider.value}%`;
  });
  volumeControl.append(volumeSlider, volumePreview);
  const volumeActions = node('div', 'music-transport');
  const setVolumeButton = node('button', 'button button-quiet', 'Sätt direkt');
  setVolumeButton.type = 'button';
  setVolumeButton.disabled =
    unavailable || musicPropertyPending(volumeCommand, volumeKey);
  setVolumeButton.setAttribute(
    'aria-label',
    `Sätt volym direkt för ${displayMusicTarget(target)}`,
  );
  setVolumeButton.dataset.focusKey = `${volumeKey}:direct`;
  setVolumeButton.addEventListener('click', () => {
    void invokeCapability(
      'music.setVolume',
      { target, volume: Number(volumeSlider.value) / 100 },
      volumeKey,
    );
  });
  const fadeButton = node('button', 'button button-quiet', 'Mjuk ändring');
  fadeButton.type = 'button';
  fadeButton.disabled =
    unavailable || musicPropertyPending(volumeCommand, volumeKey);
  fadeButton.setAttribute(
    'aria-label',
    `Ändra volym mjukt för ${displayMusicTarget(target)}`,
  );
  fadeButton.dataset.focusKey = `${volumeKey}:fade`;
  fadeButton.addEventListener('click', () => {
    const targetVolume = Number(volumeSlider.value) / 100;
    const observedVolume =
      typeof observed.volume === 'number' ? observed.volume : targetVolume;
    const durationMs = Math.max(
      1000,
      Math.ceil(Math.abs(targetVolume - observedVolume) / 0.02) * 250,
    );
    void invokeCapability(
      'music.fadeVolume',
      {
        target,
        volume: targetVolume,
        durationMs,
      },
      volumeKey,
    );
  });
  volumeActions.append(setVolumeButton, fadeButton);
  volumeControl.append(volumeActions);
  const fadeActive = fade?.status === 'active' || fade?.status === 'settling';
  const fadeStatus = node('p', 'music-request');
  if (fade) {
    const statusLabels = {
      active: 'Fade pågår',
      settling: 'Fade klar, inväntar återrapportering',
      completed: 'Fade klar',
      cancelled: 'Fade avbruten',
      interrupted: 'Fade stoppad av avvikande återrapportering',
      failed: 'Fade misslyckades',
    };
    const diagnostic =
      typeof fade.diagnosticReason === 'string' && fade.diagnosticReason
        ? ` · ${fade.diagnosticReason}`
        : '';
    fadeStatus.textContent = `${statusLabels[fade.status] ?? 'Fade'} · ${musicVolumeLabel(fade.observedVolume)} rapporterat · ${musicVolumeLabel(fade.expectedVolume)} förväntat${diagnostic}`;
    fadeStatus.dataset.tone =
      fade.status === 'completed'
        ? 'good'
        : fade.status === 'failed' || fade.status === 'interrupted'
          ? 'bad'
          : fadeActive
            ? 'warn'
            : 'neutral';
  } else {
    fadeStatus.textContent = 'Ingen fade körs';
  }
  volumeControl.append(fadeStatus);
  if (fadeActive) {
    const cancelFadeButton = node(
      'button',
      'button button-quiet',
      'Avbryt fade',
    );
    cancelFadeButton.type = 'button';
    cancelFadeButton.setAttribute(
      'aria-label',
      `Avbryt volymfade för ${displayMusicTarget(target)}`,
    );
    cancelFadeButton.dataset.focusKey = `${volumeKey}:cancel-fade`;
    cancelFadeButton.addEventListener('click', () => {
      void invokeCapability(
        'music.cancelFade',
        { target },
        `${volumeKey}:cancel`,
      );
    });
    volumeControl.append(cancelFadeButton);
  }
  volumeControl.append(renderMusicRequest(device, 'volume', volumeCommand));
  controls.append(volumeControl);

  const sourceControl = node('div', 'music-control');
  const sourceId = `music-source-${target.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
  const sourceLabel = document.createElement('label');
  sourceLabel.className = 'music-control-title';
  sourceLabel.htmlFor = sourceId;
  sourceLabel.textContent = 'Källa';
  sourceControl.append(sourceLabel);
  const sourceSelect = document.createElement('select');
  sourceSelect.id = sourceId;
  sourceSelect.dataset.focusKey = `${sourceKey}:select`;
  sourceSelect.setAttribute(
    'aria-label',
    `Välj källa för ${displayMusicTarget(target)}`,
  );
  const allowedSources = Array.isArray(device.allowedSources)
    ? device.allowedSources
    : [];
  const selectedSource = device.requested?.source ?? observed.source;
  const selectedAllowedSource = allowedSources.includes(selectedSource)
    ? selectedSource
    : '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = allowedSources.length
    ? 'Välj källa'
    : 'Inga källor tillåtna';
  placeholder.selected = !selectedAllowedSource;
  sourceSelect.append(placeholder);
  for (const source of allowedSources) {
    const option = document.createElement('option');
    option.value = source;
    option.textContent = source;
    option.selected = source === selectedAllowedSource;
    sourceSelect.append(option);
  }
  sourceSelect.disabled =
    unavailable ||
    allowedSources.length === 0 ||
    musicPropertyPending(sourceCommand, sourceKey);
  sourceSelect.addEventListener('change', () => {
    if (!sourceSelect.value) return;
    void invokeCapability(
      'music.selectSource',
      { target, source: sourceSelect.value },
      sourceKey,
    );
  });
  sourceControl.append(sourceSelect);
  sourceControl.append(renderMusicRequest(device, 'source', sourceCommand));
  controls.append(sourceControl);
  article.append(controls);
  return article;
}

function latestMusicCommand(commands, target, property) {
  return [...commands]
    .reverse()
    .find(
      (command) =>
        command.target === target && command.requested?.property === property,
    );
}

function musicPropertyPending(command, actionKey) {
  return pendingActions.has(actionKey) || command?.status === 'pending';
}

function renderMusicRequest(device, property, command) {
  const requested = device.requested?.[property];
  const line = node('p', 'music-request');
  if (requested === undefined) {
    line.textContent = 'Inget önskemål registrerat';
    return line;
  }

  const requestedLabel =
    property === 'playback'
      ? requested === 'playing'
        ? 'Spela'
        : 'Pausa'
      : property === 'volume'
        ? musicVolumeLabel(requested)
        : requested;
  const status = command?.status ?? 'unknown';
  const statusLabels = {
    pending: 'Väntar på rapport',
    confirmed: 'Bekräftad av rapport',
    unconfirmed: 'Ingen bekräftelse',
    superseded: 'Ersatt av ny begäran',
    failed: 'Misslyckades',
    unknown: 'Status saknas',
  };
  line.dataset.tone =
    status === 'confirmed'
      ? 'good'
      : status === 'failed'
        ? 'bad'
        : status === 'pending' || status === 'unconfirmed'
          ? 'warn'
          : 'neutral';
  line.textContent = `Lugn begär: ${requestedLabel} · ${statusLabels[status]}`;
  return line;
}

function musicPlaybackLabel(playback) {
  const labels = {
    playing: 'Spelar',
    paused: 'Pausad',
    idle: 'Inaktiv',
    off: 'Av',
    unknown: 'Okänt',
  };
  return labels[playback] ?? 'Okänt';
}

function musicVolumeLabel(volume) {
  return typeof volume === 'number' && Number.isFinite(volume)
    ? `${Math.round(volume * 100)}%`
    : 'Okänd';
}

function renderLights(devices, presenceState) {
  lightList.replaceChildren();
  const entries = Object.entries(devices).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    lightList.append(
      node('p', 'empty-note', 'Inga lampor är mappade till Lugn ännu.'),
    );
    return;
  }
  for (const [target, device] of entries) {
    lightList.append(renderLight(target, device, presenceState));
  }
}

function renderLight(target, device, presenceState) {
  const article = node('article', 'light-row');
  const identity = node('div', 'light-identity');
  identity.append(node('h3', '', displayTarget(target)));
  identity.append(node('code', '', target));
  const badges = node('div', 'light-badges');
  const availability = availabilityStatus(device.availability);
  badges.append(stateChip(availability.label, availability.tone));
  const convergence = convergenceStatus(device, presenceState);
  badges.append(stateChip(convergence.label, convergence.tone));
  identity.append(badges);
  article.append(identity);

  const readings = node('dl', 'light-readings');
  appendReading(
    readings,
    'Önskad ström',
    formatPower(device.effectiveDesired?.power),
    device.effectiveDesired?.power === undefined ? 'warn' : '',
  );
  appendReading(
    readings,
    'Rapporterad ström',
    formatPower(device.observed?.power),
    device.observed?.power === undefined ? 'warn' : '',
  );
  if (hasBrightness(device)) {
    appendReading(
      readings,
      'Önskad ljusstyrka',
      formatPercent(device.effectiveDesired?.brightness),
      device.effectiveDesired?.brightness === undefined ? 'warn' : '',
    );
    appendReading(
      readings,
      'Rapporterad ljusstyrka',
      formatPercent(device.observed?.brightness),
      device.observed?.brightness === undefined ? 'warn' : '',
    );
  }
  if (hasColorTemperature(device)) {
    appendReading(
      readings,
      'Önskad färgtemperatur',
      formatTemperature(device.effectiveDesired?.colorTemperature),
      device.effectiveDesired?.colorTemperature === undefined ? 'warn' : '',
    );
    appendReading(
      readings,
      'Rapporterad färgtemperatur',
      formatTemperature(device.observed?.colorTemperature),
      device.observed?.colorTemperature === undefined ? 'warn' : '',
    );
  }
  article.append(readings);

  const controls = node('div', 'light-controls');
  const isPending = pendingActions.has(`light:${target}`);
  const unavailable = device.availability === 'unavailable';
  const knownPower = device.effectiveDesired?.power ?? device.observed?.power;
  const powerControl = node('div', 'power-control');
  powerControl.append(node('span', 'power-label', 'Ström'));
  const powerLabel = node('label', 'power-toggle');
  const powerInput = document.createElement('input');
  powerInput.type = 'checkbox';
  powerInput.className = 'switch-input';
  powerInput.checked = knownPower === true;
  powerInput.indeterminate = knownPower === undefined;
  powerInput.disabled = unavailable || isPending;
  powerInput.setAttribute(
    'aria-label',
    `Önskat strömläge för ${displayTarget(target)}`,
  );
  powerInput.dataset.focusKey = `power:${target}`;
  const switchTrack = node('span', 'switch-track');
  switchTrack.setAttribute('aria-hidden', 'true');
  powerLabel.append(powerInput, switchTrack);
  powerControl.append(powerLabel);
  powerInput.addEventListener('change', () => {
    void invokeCapability(
      'lighting.set',
      { target, values: { power: powerInput.checked } },
      `light:${target}`,
    );
  });
  controls.append(powerControl);

  if (hasBrightness(device)) {
    controls.append(
      renderBrightnessControl(target, device, unavailable || isPending),
    );
  }
  controls.append(
    node('p', 'ownership-note', ownershipLabel(device.ownership)),
  );
  article.append(controls);
  return article;
}

function renderBrightnessControl(target, device, disabled) {
  const wrap = node('div', 'brightness-control');
  const current =
    device.effectiveDesired?.brightness ?? device.observed?.brightness;
  const minus = node('button', 'adjust-button', '−10');
  minus.type = 'button';
  minus.disabled = disabled || !Number.isInteger(current) || current <= 0;
  minus.setAttribute(
    'aria-label',
    `Sänk ljusstyrkan för ${displayTarget(target)} med 10 procentenheter`,
  );
  minus.dataset.focusKey = `adjust-down:${target}`;
  minus.addEventListener('click', () => {
    void invokeCapability(
      'lighting.adjust',
      { target, brightnessDelta: -10 },
      `light:${target}`,
    );
  });

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = `light-brightness-${target.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.value = String(Number.isInteger(current) ? current : 0);
  slider.disabled = disabled;
  slider.setAttribute(
    'aria-label',
    `Önskad ljusstyrka för ${displayTarget(target)}`,
  );
  slider.setAttribute('aria-valuetext', `${slider.value} procent`);
  slider.dataset.focusKey = `brightness:${target}`;
  const value = node(
    'output',
    'brightness-value',
    Number.isInteger(current) ? `${current}%` : 'Okänd',
  );
  value.htmlFor = slider.id;
  slider.addEventListener('input', () => {
    slider.setAttribute('aria-valuetext', `${slider.value} procent`);
    value.textContent = `Nytt önskemål ${slider.value}%`;
  });
  slider.addEventListener('change', () => {
    void invokeCapability(
      'lighting.set',
      { target, values: { brightness: Number(slider.value) } },
      `light:${target}`,
    );
  });

  const plus = node('button', 'adjust-button', '+10');
  plus.type = 'button';
  plus.disabled = disabled || !Number.isInteger(current) || current >= 100;
  plus.setAttribute(
    'aria-label',
    `Höj ljusstyrkan för ${displayTarget(target)} med 10 procentenheter`,
  );
  plus.dataset.focusKey = `adjust-up:${target}`;
  plus.addEventListener('click', () => {
    void invokeCapability(
      'lighting.adjust',
      { target, brightnessDelta: 10 },
      `light:${target}`,
    );
  });

  wrap.append(minus, slider, value, plus);
  return wrap;
}

function appendReading(list, label, value, tone = '') {
  const item = node('div', 'reading');
  item.append(node('dt', '', label));
  const result = node('dd', '', value);
  if (tone) result.dataset.tone = tone;
  item.append(result);
  list.append(item);
}

function stateChip(label, tone) {
  const chip = node('span', 'state-chip', label);
  chip.dataset.tone = tone;
  return chip;
}

function renderMappingSummary(devices, presenceState) {
  if (presenceState === 'confirmed_empty') {
    const values = Object.values(devices);
    const unavailable = values.filter(
      (device) => device.availability === 'unavailable',
    ).length;
    const degraded = values.filter(
      (device) => device.availability === 'degraded',
    ).length;
    const parts = ['Lamporna hålls släckta medan rummet är tomt'];
    if (unavailable) parts.push(`${unavailable} otillgängliga`);
    if (degraded) parts.push(`${degraded} med degraderad status`);
    mappingSummary.textContent = parts.join(' · ');
    return;
  }
  const counts = {
    aligned: 0,
    waiting: 0,
    diverged: 0,
    unavailable: 0,
    empty: 0,
    degraded: 0,
  };
  for (const device of Object.values(devices)) {
    if (device.availability === 'unavailable') {
      counts.unavailable += 1;
      continue;
    }
    if (device.availability === 'degraded') {
      counts.degraded += 1;
      continue;
    }
    const desired = device.effectiveDesired ?? {};
    const properties = Object.keys(desired);
    if (properties.length === 0) {
      counts.empty += 1;
      continue;
    }
    if (
      properties.some((property) => device.observed?.[property] === undefined)
    ) {
      counts.waiting += 1;
      continue;
    }
    if (
      properties.every(
        (property) => device.observed[property] === desired[property],
      )
    ) {
      counts.aligned += 1;
    } else {
      counts.diverged += 1;
    }
  }
  const parts = [];
  if (counts.aligned)
    parts.push(`${counts.aligned} rapporterade värden stämmer`);
  if (counts.waiting) parts.push(`${counts.waiting} inväntar återrapportering`);
  if (counts.diverged)
    parts.push(`${counts.diverged} avviker från önskat läge`);
  if (counts.unavailable) parts.push(`${counts.unavailable} otillgängliga`);
  if (counts.degraded) parts.push(`${counts.degraded} med degraderad status`);
  if (counts.empty) parts.push(`${counts.empty} utan önskade värden`);
  mappingSummary.textContent = parts.length
    ? parts.join(' · ')
    : 'Inga lampor att visa';
}

function renderUpdatedAt(value) {
  if (!Number.isFinite(value) || value < 0) {
    updatedAt.textContent = 'Uppdateringstid saknas';
    return;
  }
  const date = new Date(value);
  updatedAt.textContent = Number.isNaN(date.getTime())
    ? 'Uppdateringstid saknas'
    : `Tillstånd ändrat ${new Intl.DateTimeFormat('sv-SE', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date)}`;
}

function integrationLabel(name) {
  const labels = {
    home_assistant: 'Home Assistant',
    mqtt: 'MQTT',
  };
  return (
    labels[name] ??
    name.replace(/[._-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
  );
}

function integrationStatus(status) {
  const statuses = {
    connected: ['Ansluten', 'good'],
    not_configured: ['Inte konfigurerad', 'neutral'],
    connecting: ['Ansluter', 'warn'],
    authenticating: ['Verifierar', 'warn'],
    subscribing: ['Startar', 'warn'],
    reconnecting: ['Återansluter', 'warn'],
    disconnected: ['Frånkopplad', 'bad'],
    stopped: ['Stoppad', 'bad'],
    failed: ['Fel', 'bad'],
  };
  return statuses[status] ?? ['Okänd status', 'neutral'];
}

function presenceTone(state) {
  if (state === 'occupied') return 'good';
  if (state === 'confirmed_empty') return 'neutral';
  return 'warn';
}

function availabilityStatus(availability) {
  const statuses = {
    available: { label: 'Tillgänglig', tone: 'good' },
    degraded: { label: 'Degraderad', tone: 'warn' },
    unavailable: { label: 'Otillgänglig', tone: 'bad' },
  };
  return statuses[availability] ?? { label: 'Status okänd', tone: 'neutral' };
}

function convergenceStatus(device, presenceState) {
  if (device.availability === 'unavailable')
    return { label: 'Ingen aktuell återrapportering', tone: 'bad' };
  if (device.availability === 'degraded')
    return { label: 'Återrapportering begränsad', tone: 'warn' };
  if (presenceState === 'confirmed_empty') {
    if (device.observed?.power === false)
      return { label: 'Av enligt tomt-rum-läge', tone: 'neutral' };
    if (device.observed?.power === true)
      return { label: 'Väntar på avstängning', tone: 'warn' };
    return { label: 'Inväntar avstängningsrapport', tone: 'warn' };
  }
  const desired = device.effectiveDesired ?? {};
  const properties = Object.keys(desired);
  if (properties.length === 0)
    return { label: 'Inget önskat läge', tone: 'neutral' };
  if (properties.some((property) => device.observed?.[property] === undefined))
    return { label: 'Inväntar återrapportering', tone: 'warn' };
  if (
    properties.every(
      (property) => device.observed[property] === desired[property],
    )
  )
    return { label: 'Rapporterat läge stämmer', tone: 'good' };
  return { label: 'Avviker från önskat läge', tone: 'warn' };
}

function ownershipLabel(ownership = {}) {
  const values = Object.values(ownership);
  const names = new Set();
  for (const item of values) {
    if (item.kind === 'scene') {
      names.add('Scenstyrd');
    } else if (item.kind === 'override') {
      names.add(
        item.actor?.type === 'home_assistant'
          ? 'Överstyrd via Home Assistant'
          : 'Manuell justering',
      );
    }
  }
  return names.size
    ? [...names].join(' · ')
    : 'Ingen aktiv scen- eller manuell ägare';
}

function displayTarget(target) {
  const label = target
    .replace(/^lighting\./, '')
    .replace(/[._-]+/g, ' ')
    .trim();
  return label
    ? label.replace(/^./, (letter) => letter.toLocaleUpperCase('sv-SE'))
    : target;
}

function displayMusicTarget(target) {
  const label = target
    .replace(/^music\./, '')
    .replace(/[._-]+/g, ' ')
    .trim();
  return label
    ? label.replace(/^./, (letter) => letter.toLocaleUpperCase('sv-SE'))
    : target;
}

function formatPower(value) {
  if (value === true) return 'På';
  if (value === false) return 'Av';
  return 'Okänt';
}

function formatPercent(value) {
  return Number.isInteger(value) ? `${value}%` : 'Okänd';
}

function formatTemperature(value) {
  return Number.isInteger(value) ? `${value} K` : 'Okänd';
}

function hasBrightness(device) {
  return (
    Number.isInteger(device.effectiveDesired?.brightness) ||
    Number.isInteger(device.observed?.brightness)
  );
}

function hasColorTemperature(device) {
  return (
    Number.isInteger(device.effectiveDesired?.colorTemperature) ||
    Number.isInteger(device.observed?.colorTemperature)
  );
}
