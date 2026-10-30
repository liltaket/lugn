const API_ROOT = '/ui/api';

// Bolt optimization: Cache Intl instantiation instead of recreating inside render function
const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

// Bolt optimization: Cache Intl.DateTimeFormat instead of recreating inside render function
const routineDateFormat = new Intl.DateTimeFormat('sv-SE', {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Stockholm',
});

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
const createPresetButton = document.getElementById('create-preset-button');
const presetEditor = document.getElementById('preset-editor');
const presetForm = document.getElementById('preset-form');
const presetFields = document.getElementById('preset-fields');
const presetName = document.getElementById('preset-name');
const presetLightList = document.getElementById('preset-light-list');
const presetStatus = document.getElementById('preset-status');
const closePresetButton = document.getElementById('close-preset-button');
const savePresetButton = document.getElementById('save-preset-button');
const saveActivatePresetButton = document.getElementById(
  'save-activate-preset-button',
);
const deletePresetButton = document.getElementById('delete-preset-button');
const presetConfirm = document.getElementById('preset-confirm');
const presetConfirmMessage = document.getElementById('preset-confirm-message');
const presetConfirmYes = document.getElementById('preset-confirm-yes');
const presetConfirmNo = document.getElementById('preset-confirm-no');
const mappingSummary = document.getElementById('mapping-summary');
const musicList = document.getElementById('music-list');
const computerSection = document.getElementById('computer-section');
const computerList = document.getElementById('computer-list');
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
let overviewStale = false;
let lastOverviewAt = 0;
let overviewInstanceId;
let overviewInstanceGeneration = 0;
let overviewDeliveryRevision = -1;
const retiredOverviewInstances = new Set();
let eventSource = null;
let pollTimer = null;
let actionMessage = '';
let actionTone = 'neutral';
const pendingActions = new Set();
let volumeSettingsDraft = null;
let volumeSettingsOriginal = null;
let volumeSettingsBusy = false;
let volumePreviewRevision = 0;
let presetDraft = null;
let presetOriginal = null;
let presetBusy = false;
let presetReturnFocus = null;
let presetConfirmationAction = null;
let routineDraft = null;
let routineOriginal = null;
let routineGeneration = null;
let routinePreviewRevision = 0;
let cameraWebDraft = null;
let cameraWebOriginal = null;
let cameraWebGeneration;
let cameraWebBusy = false;
let cameraWebChoicesKey;
const cameraWebDismissedIds = new Set();
let cameraWebCloseHoldUntil = 0;
let cameraWebPendingShow = null;
let cameraWebActionEpoch = 0;
let cameraWebActionPending = false;
let cameraWebActionRequests = 0;
let cameraWebMediaEpoch = 0;
let cameraWebMediaKey = null;
let cameraWebImageTimer;
let cameraWebImageTimeout;
let cameraWebController;
let cameraWebObjectUrl;
let intelligenceDraft = null;
let intelligenceOriginal = null;
let intelligenceGeneration = null;
let mappingDraft = [];
const l2Pending = new Set();

class SessionExpiredError extends Error {}
class ClerkAuthorizationError extends Error {}

tokenHelp.textContent =
  'Använd installationens lokala HTTPS-adress eller en SSH-tunnel. Hämta åtkomsttoken på Lugn-värden enligt docs/OPERATIONS.md i ett privat terminalfönster och klistra in den bara här.';

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

createPresetButton.addEventListener('click', () => openPresetEditor(null));
closePresetButton.addEventListener('click', requestClosePreset);
presetName.addEventListener('input', () => {
  if (presetDraft) presetDraft.name = presetName.value;
  updatePresetDirtyState();
});
presetForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void savePreset(event.submitter === saveActivatePresetButton);
});
deletePresetButton.addEventListener('click', () => {
  confirmPresetAction(
    'delete',
    `Radera ”${presetOriginal.name}”? Lampornas aktuella läge behålls.`,
    'Radera preset',
  );
});
presetConfirmNo.addEventListener('click', () => {
  const action = presetConfirmationAction;
  hidePresetConfirmation();
  (action === 'delete' ? deletePresetButton : closePresetButton).focus();
});
presetConfirmYes.addEventListener('click', () => {
  if (presetConfirmationAction === 'delete') void deletePreset();
  else closePresetEditor();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!presetConfirm.hidden) {
      presetConfirmNo.click();
    } else if (!presetEditor.hidden) {
      requestClosePreset();
    }
  }
});

initializeLugn2();
initializeCameraWeb();
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
  stopCameraWebMedia();
  clearSessionRenewal();
  stopLiveUpdates();
  csrfToken = null;
  overview = null;
  closePresetEditor(false);
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
      await fetchOverview();
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
  loginSubmit.setAttribute('aria-busy', 'true');
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
  } finally {
    loginSubmit.removeAttribute('aria-busy');
  }
}

async function openDashboard(sessionCsrfToken, expiresAt = null) {
  csrfToken = sessionCsrfToken;
  scheduleSessionRenewal(expiresAt);
  try {
    await fetchOverview();
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
  if (
    volumeSettingsDirty() &&
    !window.confirm(
      'Du har osparade musikinställningar. Logga ut och kasta ändringarna?',
    )
  )
    return;
  volumeSettingsDraft = null;
  volumeSettingsOriginal = null;
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

// HTTP reads and SSE frames share the server's per-instance delivery sequence.
function acceptOverview(next) {
  if (
    !next?.state?.presence ||
    !next?.state?.lighting?.devices ||
    !Number.isInteger(next.state.revision) ||
    next.state.revision < 0
  )
    throw new Error('Servern returnerade ett ogiltigt rumsstatus.');
  if (
    typeof next.instanceId === 'string' &&
    next.instanceId !== overviewInstanceId
  ) {
    if (retiredOverviewInstances.has(next.instanceId)) return false;
    if (overviewInstanceId) retiredOverviewInstances.add(overviewInstanceId);
    overviewInstanceId = next.instanceId;
    overviewInstanceGeneration += 1;
    overview = null;
    overviewDeliveryRevision = -1;
  }
  if (next.state.revision < (overview?.state?.revision ?? -1)) return false;
  if (
    Number.isInteger(next.deliveryRevision) &&
    next.deliveryRevision < overviewDeliveryRevision
  )
    return false;
  overviewDeliveryRevision = Number.isInteger(next.deliveryRevision)
    ? next.deliveryRevision
    : overviewDeliveryRevision;
  overview = next;
  overviewStale = false;
  lastOverviewAt = Date.now();
  return true;
}

async function fetchOverview() {
  const readGeneration = overviewInstanceGeneration;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${API_ROOT}/overview`, {
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403)
      throw new SessionExpiredError('Sessionen har gått ut.');
    if (!response.ok) throw new Error('Rumsstatus kunde inte hämtas.');
    const result = await response.json();
    // A response from an earlier connection cannot introduce another instance.
    if (
      readGeneration !== overviewInstanceGeneration &&
      result?.instanceId !== overviewInstanceId
    )
      return overview;
    acceptOverview(result);
    return overview;
  } finally {
    window.clearTimeout(timeout);
  }
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
      if (acceptOverview(next)) render();
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
    if (lastOverviewAt && Date.now() - lastOverviewAt > 30000) {
      overviewStale = true;
      if (overview) render();
    }
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
    await fetchOverview();
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
    if (
      !lastOverviewAt ||
      Date.now() - lastOverviewAt > 30000 ||
      !eventSource ||
      eventSource.readyState !== EventSource.OPEN
    ) {
      overviewStale = true;
      if (overview) render();
    }
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
  renderMusicSettings();
  renderLugn2();
  renderCameraWeb();
  renderComputers(overview.state?.computer?.devices ?? {}, overviewStale);
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
  // Bolt optimization: Use querySelector instead of converting NodeList to an array
  const element = document.querySelector(
    `[data-focus-key="${CSS.escape(focusedKey)}"]`,
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
  presenceTitle.textContent = `${overviewStale ? 'Senast rapporterat: ' : ''}${presenceLabels[presence.state] ?? 'Närvaro okänd'}`;
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
  reapplyButton.disabled = pendingActions.has('scene') || presetBusy;
  saveActivatePresetButton.disabled = pendingActions.has('scene') || presetBusy;
  reapplyButton.dataset.focusKey = 'reapply-scene';
  const editable = data.presetsEnabled === true;
  createPresetButton.hidden = !editable;
  createPresetButton.disabled = presetBusy || !!presetConfirmationAction;

  sceneList.replaceChildren();
  if (scenes.length === 0) {
    sceneList.append(
      node('p', 'empty-note', 'Inga ljusscener är konfigurerade.'),
    );
    return;
  }
  for (const scene of scenes) {
    const item = node('div', 'scene-item');
    item.dataset.editing = String(presetDraft?.id === scene.id);
    const selected = scene.id === currentScene;
    const button = node('button', 'scene-button');
    button.type = 'button';
    button.disabled = pendingActions.has('scene') || presetBusy;
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
    item.append(button);
    if (editable && scene.canEdit) {
      const edit = node('button', 'scene-edit', 'Redigera');
      edit.type = 'button';
      edit.disabled = presetBusy;
      edit.setAttribute('aria-label', `Redigera ${scene.name}`);
      edit.dataset.focusKey = `edit-scene:${scene.id}`;
      edit.addEventListener('click', () => {
        if (presetDraft && presetIsDirty()) {
          setPresetStatus(
            'Spara eller stäng dina ändringar innan du väljer ett annat preset.',
            'warn',
          );
          presetName.focus();
          return;
        }
        openPresetEditor(scene);
      });
      item.append(edit);
    }
    sceneList.append(item);
  }
}

function sceneSnapshot(scene) {
  return {
    id: scene.id,
    name: scene.name,
    lighting: structuredClone(scene.lighting),
  };
}

function presetIsDirty() {
  return (
    presetDraft &&
    (!presetOriginal ||
      JSON.stringify(presetDraft) !== JSON.stringify(presetOriginal))
  );
}

function updatePresetDirtyState() {
  closePresetButton.textContent = presetIsDirty()
    ? 'Avbryt ändringar'
    : 'Stäng';
  closePresetButton.title = presetIsDirty()
    ? 'Avbryt ändringar (Esc)'
    : 'Stäng (Esc)';
}

function setPresetStatus(message, tone = 'neutral') {
  presetStatus.textContent = message;
  presetStatus.dataset.tone = tone;
}

function hidePresetConfirmation() {
  presetConfirm.hidden = true;
  presetConfirmationAction = null;
  presetFields.disabled = presetBusy;
  closePresetButton.disabled = presetBusy;
  createPresetButton.disabled = presetBusy;
}

function confirmPresetAction(action, message, label) {
  if (presetBusy) return;
  presetConfirmationAction = action;
  presetConfirmMessage.textContent = message;
  presetConfirmYes.textContent = label;
  presetConfirm.hidden = false;
  presetFields.disabled = true;
  closePresetButton.disabled = true;
  createPresetButton.disabled = true;
  presetConfirmNo.focus();
}

function requestClosePreset() {
  if (presetBusy) return;
  if (presetIsDirty()) {
    confirmPresetAction(
      'discard',
      'Stäng utan att spara dina ändringar?',
      'Kasta ändringar',
    );
  } else closePresetEditor();
}

function closePresetEditor(restore = true) {
  presetEditor.hidden = true;
  presetDraft = null;
  presetOriginal = null;
  hidePresetConfirmation();
  if (overview) renderScenes(overview);
  if (restore) restoreFocus(presetReturnFocus, null);
}

function openPresetEditor(scene) {
  if (presetBusy || presetConfirmationAction) return;
  if (presetDraft && presetIsDirty()) {
    setPresetStatus(
      'Spara eller stäng dina ändringar innan du skapar ett nytt preset.',
      'warn',
    );
    presetName.focus();
    return;
  }
  presetReturnFocus = scene ? `edit-scene:${scene.id}` : 'create-preset';
  createPresetButton.dataset.focusKey = 'create-preset';
  presetOriginal = scene ? sceneSnapshot(scene) : null;
  const source = (overview.scenes ?? []).find(
    (candidate) => candidate.id === overview.state.lighting.currentScene,
  );
  const lighting =
    scene?.lighting ??
    source?.lighting ??
    Object.fromEntries(
      Object.entries(overview.state.lighting.devices).map(
        ([target, device]) => [
          target,
          { power: true, brightness: 50, ...device.baselineDesired },
        ],
      ),
    );
  presetDraft = scene
    ? sceneSnapshot(scene)
    : { name: '', lighting: structuredClone(lighting) };
  presetName.value = presetDraft.name;
  document.getElementById('preset-editor-title').textContent = scene
    ? `Redigera ${scene.name}`
    : 'Nytt preset';
  deletePresetButton.hidden = !scene?.canDelete;
  deletePresetButton.title = scene?.protectionReason ?? '';
  hidePresetConfirmation();
  presetEditor.hidden = false;
  presetLightList.replaceChildren();
  for (const target of Object.keys(overview.state.lighting.devices).sort(
    (a, b) => a.localeCompare(b),
  )) {
    presetLightList.append(renderPresetLight(target));
  }
  setPresetStatus(
    !scene && source
      ? `Utgår från ${source.name}. Ge presetet ett eget namn.`
      : 'Ändringar sparas först när du väljer Spara.',
  );
  updatePresetDirtyState();
  renderScenes(overview);
  presetName.focus({ preventScroll: true });
  presetEditor.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

function renderPresetLight(target) {
  const row = node('div', 'preset-light');
  const includeLabel = node('label', 'preset-light-identity');
  const include = document.createElement('input');
  include.type = 'checkbox';
  include.checked = Object.hasOwn(presetDraft.lighting, target);
  include.setAttribute(
    'aria-label',
    `Ta med ${displayTarget(target)} i presetet`,
  );
  includeLabel.append(include, node('span', '', displayTarget(target)));
  const control = node('div', 'preset-brightness');
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = `preset-brightness-${target.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.setAttribute(
    'aria-label',
    `Ljusstyrka för ${displayTarget(target)} i presetet`,
  );
  const number = document.createElement('input');
  number.type = 'number';
  number.required = true;
  number.min = '0';
  number.max = '100';
  number.step = '1';
  number.inputMode = 'numeric';
  number.setAttribute(
    'aria-label',
    `Ljusstyrka i procent för ${displayTarget(target)}`,
  );
  const numberWrap = node('div', 'preset-number');
  numberWrap.append(number, node('span', '', '%'));
  const status = node('output', 'preset-light-state');
  status.htmlFor = slider.id;
  let retained = structuredClone(
    presetDraft.lighting[target] ?? { power: false, brightness: 0 },
  );
  const sync = () => {
    const values = presetDraft.lighting[target];
    const brightness = values?.power === false ? 0 : (values?.brightness ?? 50);
    slider.value = String(brightness);
    number.value = String(brightness);
    slider.disabled = !include.checked;
    number.disabled = !include.checked;
    slider.setAttribute(
      'aria-valuetext',
      include.checked ? `${brightness} procent` : 'Oförändrad',
    );
    status.textContent = !include.checked
      ? 'Oförändrad'
      : values.power === false
        ? 'Släckt'
        : values.brightness === undefined
          ? 'Nivå ej angiven'
          : 'På';
    row.dataset.included = String(include.checked);
  };
  const setBrightness = (value) => {
    if (!Number.isInteger(value) || value < 0 || value > 100) return;
    presetDraft.lighting[target] = {
      ...presetDraft.lighting[target],
      power: value > 0,
      brightness: value,
    };
    sync();
    updatePresetDirtyState();
  };
  slider.addEventListener('input', () => setBrightness(Number(slider.value)));
  number.addEventListener('input', () => {
    if (number.value !== '' && number.validity.valid)
      setBrightness(Number(number.value));
  });
  number.addEventListener('change', () => {
    if (number.validity.valid && number.value !== '') sync();
  });
  include.addEventListener('change', () => {
    if (include.checked) presetDraft.lighting[target] = retained;
    else {
      retained = structuredClone(presetDraft.lighting[target]);
      delete presetDraft.lighting[target];
    }
    sync();
    updatePresetDirtyState();
  });
  sync();
  control.append(slider, numberWrap, status);
  row.append(includeLabel, control);
  return row;
}

function setPresetBusy(busy) {
  presetBusy = busy;
  presetFields.disabled = busy;
  closePresetButton.disabled = busy;
  presetConfirmYes.disabled = busy;
  presetConfirmNo.disabled = busy;
  savePresetButton.textContent = busy ? 'Sparar…' : 'Spara';
  presetForm.setAttribute('aria-busy', String(busy));
  if (overview) renderScenes(overview);
}

async function mutatePreset(path, method, body) {
  const response = await fetch(`${API_ROOT}/scenes${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'X-Lugn-CSRF': csrfToken },
    body: JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403)
    throw new SessionExpiredError();
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    const errors = {
      scene_changed:
        'Presetet har ändrats någon annanstans. Ditt utkast finns kvar. Stäng och öppna presetet igen för att hämta senaste versionen.',
      unknown_scene:
        'Presetet har raderats någon annanstans. Stäng redigeraren och skapa ett nytt preset.',
      scene_protected:
        'Det här presetet behövs av systemet och kan inte ändras eller raderas.',
      target_not_configured:
        'En lampa finns inte längre i konfigurationen. Stäng och öppna presetet igen för att hämta aktuella lampor.',
      scene_limit_reached:
        'Presetlistan är full. Radera ett preset innan du skapar ett nytt.',
      scene_save_failed:
        'Presetet kunde inte lagras på servern. Dina ändringar finns kvar. Försök igen.',
    };
    throw new Error(
      errors[failure.error] ??
        'Ändringen kunde inte sparas. Ditt utkast finns kvar. Försök igen.',
    );
  }
  return response.json();
}

async function savePreset(activate) {
  if (!presetDraft || presetBusy || !csrfToken) return;
  if (activate && pendingActions.has('scene')) {
    setPresetStatus(
      'Vänta tills den pågående scenaktiveringen är klar innan du sparar och aktiverar.',
      'warn',
    );
    return;
  }
  const name = presetDraft.name.trim();
  if (!name) {
    setPresetStatus('Ge presetet ett namn.', 'bad');
    presetName.focus();
    return;
  }
  if (!Object.keys(presetDraft.lighting).length) {
    setPresetStatus('Välj minst en lampa som ska ingå.', 'bad');
    return;
  }
  setPresetBusy(true);
  setPresetStatus('Sparar preset…');
  try {
    const { scene } = await mutatePreset(
      presetOriginal ? `/${encodeURIComponent(presetOriginal.id)}` : '',
      'POST',
      {
        name,
        lighting: presetDraft.lighting,
        ...(presetOriginal ? { expectedScene: presetOriginal } : {}),
      },
    );
    presetOriginal = sceneSnapshot(scene);
    presetDraft = sceneSnapshot(scene);
    presetName.value = scene.name;
    deletePresetButton.hidden = !scene.canDelete;
    document.getElementById('preset-editor-title').textContent =
      `Redigera ${scene.name}`;
    // Keep the successful response even if the following status read is unavailable.
    overview.scenes = [
      ...overview.scenes.filter((item) => item.id !== scene.id),
      scene,
    ];
    updatePresetDirtyState();
    await refreshOverview();
    setPresetStatus(
      activate
        ? 'Presetet är sparat. Aktiverar…'
        : 'Presetet är sparat. Lamporna ändras när du aktiverar det.',
      'good',
    );
    if (activate) {
      await invokeCapability(
        'lighting.activateScene',
        { sceneId: scene.id },
        'scene',
      );
      setPresetStatus(`Presetet är sparat. ${actionMessage}`, actionTone);
    }
  } catch (error) {
    handlePresetError(error);
  } finally {
    setPresetBusy(false);
    if (!presetEditor.hidden) savePresetButton.focus({ preventScroll: true });
  }
}

async function deletePreset() {
  if (!presetOriginal || presetBusy || !csrfToken) return;
  setPresetBusy(true);
  setPresetStatus('Raderar preset…');
  try {
    const id = presetOriginal.id;
    await mutatePreset(`/${encodeURIComponent(id)}`, 'DELETE', {
      expectedScene: presetOriginal,
    });
    overview.scenes = overview.scenes.filter((scene) => scene.id !== id);
    closePresetEditor(false);
    await refreshOverview();
    setActionMessage(
      'Presetet har raderats. Lampornas aktuella läge behålls.',
      'good',
    );
    createPresetButton.focus({ preventScroll: true });
  } catch (error) {
    hidePresetConfirmation();
    handlePresetError(error);
  } finally {
    setPresetBusy(false);
  }
}

function handlePresetError(error) {
  if (error instanceof SessionExpiredError) {
    setPresetStatus(
      'Sessionen har gått ut. Logga in igen innan du sparar.',
      'bad',
    );
    setActionMessage(
      'Sessionen har gått ut. Logga ut och logga in igen.',
      'bad',
    );
  } else
    setPresetStatus(
      error instanceof Error
        ? error.message
        : 'Åtgärden misslyckades. Försök igen.',
      'bad',
    );
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

function renderComputers(devices, overviewUnavailable = false) {
  const entries = Object.entries(devices ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const openDetails = new Map();
  for (const row of computerList.children) {
    const details = findComputerDetails(row);
    if (row.dataset.deviceId && details?.open)
      openDetails.set(row.dataset.deviceId, true);
  }
  computerList.replaceChildren();
  computerSection.hidden = entries.length === 0;
  for (const [deviceId, observation] of entries) {
    const current = overviewUnavailable
      ? {
          ...observation,
          availability: 'unknown',
          freshness: 'unknown',
          reason: 'overview_stale',
          observed: {},
          activity: { classification: 'unknown' },
        }
      : observation;
    computerList.append(
      renderComputer(deviceId, current, openDetails.get(deviceId) === true),
    );
  }
}

function findComputerDetails(element) {
  if (element.className?.split(/\s+/).includes('computer-details'))
    return element;
  for (const child of element.children ?? []) {
    const found = findComputerDetails(child);
    if (found) return found;
  }
  return null;
}

function renderComputer(deviceId, observation = {}, detailsOpen = false) {
  const article = node('article', 'computer-row');
  article.dataset.deviceId = deviceId;
  const heading = node('header', 'computer-device-heading');
  const title = node(
    'h3',
    '',
    computerTextValue(observation.deviceId ?? deviceId),
  );
  const status = node('div', 'computer-status-chips');
  const availability = computerAvailabilityStatus(observation.availability);
  const freshness = computerFreshnessStatus(observation.freshness);
  status.append(
    stateChip(availability.label, availability.tone),
    stateChip(freshness.label, freshness.tone),
  );
  heading.append(title, status);
  article.append(heading);
  article.append(
    node(
      'p',
      'computer-status-reason',
      computerReasonLabel(observation.reason),
    ),
  );

  const observed = observation.observed ?? {};
  const readings = node('dl', 'computer-readings');
  appendReading(
    readings,
    'Låsning',
    computerBooleanLabel(observed.locked, 'Låst', 'Olåst'),
  );
  appendReading(
    readings,
    'Datoraktivitet',
    computerBooleanLabel(observed.idle, 'Inaktiv', 'Aktiv'),
  );
  appendReading(
    readings,
    'Helskärm',
    computerBooleanLabel(observed.fullscreen, 'Ja', 'Nej'),
  );
  appendReading(
    readings,
    'Ljud',
    observed.audio === null || observed.audio === undefined
      ? 'Okänt'
      : computerBooleanLabel(
          observed.audio.playing,
          'Ljud spelas',
          'Ljud spelas inte',
        ),
  );
  article.append(readings);

  const activity = node('dl', 'computer-activity');
  appendReading(
    activity,
    'Bedömd aktivitet',
    computerActivityLabel(observation.activity?.classification),
  );
  article.append(activity);
  article.append(renderComputerDetails(deviceId, observed, detailsOpen));
  return article;
}

function renderComputerDetails(deviceId, observed, detailsOpen) {
  const details = node('details', 'computer-details');
  details.open = detailsOpen;
  const summary = node('summary', '', 'App, nätverk och media');
  summary.dataset.focusKey = `computer:${deviceId}:details`;
  details.append(summary);

  const readings = node('dl', 'computer-detail-readings');
  appendReading(
    readings,
    'Internetåtkomst',
    computerBooleanLabel(observed.networkOnline, 'Ja', 'Nej'),
  );
  appendReading(
    readings,
    'Aktiv app',
    computerTextValue(observed.activeApplication?.id),
  );
  appendReading(
    readings,
    'Appklass',
    computerTextValue(observed.activeApplication?.resourceClass),
  );
  appendReading(
    readings,
    'Ljudappar',
    computerValuesLabel(observed.audio?.applications),
  );
  appendReading(
    readings,
    'Ljudroller',
    computerValuesLabel(observed.audio?.roles),
  );
  details.append(readings);

  const media = node('div', 'computer-media-list');
  if (observed.media === null || observed.media === undefined) {
    media.append(node('p', 'computer-media-empty', 'Media: Okänt'));
  } else if (observed.media.length === 0) {
    media.append(
      node('p', 'computer-media-empty', 'Ingen mediaspelare rapporterad'),
    );
  } else {
    for (const item of observed.media) media.append(renderComputerMedia(item));
  }
  details.append(media);
  return details;
}

function renderComputerMedia(media) {
  const item = node('section', 'computer-media-item');
  const heading = node('div', 'computer-media-heading');
  heading.append(node('h4', '', computerTextValue(media?.player)));
  heading.append(stateChip(computerPlaybackLabel(media?.playback), 'neutral'));
  item.append(heading);

  const readings = node('dl', 'computer-media-readings');
  appendReading(readings, 'Titel', computerTextValue(media?.title));
  appendReading(readings, 'Artist', computerValuesLabel(media?.artists));
  appendReading(readings, 'Album', computerTextValue(media?.album));
  appendReading(
    readings,
    'Innehållstyp',
    computerTextValue(media?.contentType),
  );
  appendReading(readings, 'Mediaidentitet', computerTextValue(media?.identity));
  appendReading(
    readings,
    'Skrivbordsapp',
    computerTextValue(media?.desktopEntry),
  );
  item.append(readings);
  return item;
}

function computerAvailabilityStatus(availability) {
  const statuses = {
    online: { label: 'Online', tone: 'good' },
    offline: { label: 'Offline', tone: 'bad' },
    unknown: { label: 'Anslutning okänd', tone: 'neutral' },
  };
  return statuses[availability] ?? statuses.unknown;
}

function computerFreshnessStatus(freshness) {
  const statuses = {
    fresh: { label: 'Aktuell', tone: 'good' },
    stale: { label: 'Föråldrad', tone: 'warn' },
    unknown: { label: 'Aktualitet okänd', tone: 'neutral' },
  };
  return statuses[freshness] ?? statuses.unknown;
}

function computerReasonLabel(reason) {
  const labels = {
    awaiting_state: 'Väntar på datorns första statusrapport.',
    live: 'Uppdateras från datoragenten.',
    retained: 'Sparad rapport mottagen; väntar på en aktuell rapport.',
    stale: 'Ingen ny rapport har kommit in i tid.',
    offline: 'Datoragenten är offline.',
    broker_disconnected: 'Anslutningen till MQTT är bruten.',
    malformed: 'Datorns senaste rapport kunde inte läsas.',
    stopped: 'Mottagningen av datorstatus har stoppats.',
    overview_stale: 'Ingen livekontakt med Lugn.',
  };
  return labels[reason] ?? 'Statusorsak okänd.';
}

function computerBooleanLabel(value, trueLabel, falseLabel) {
  if (value === true) return trueLabel;
  if (value === false) return falseLabel;
  return 'Okänt';
}

function computerActivityLabel(classification) {
  const labels = {
    gaming: 'Spel',
    video: 'Video',
    music: 'Musik',
    desktop: 'Skrivbord',
    idle: 'Inaktiv',
    unknown: 'Okänd',
  };
  return labels[classification] ?? labels.unknown;
}

function computerPlaybackLabel(playback) {
  const labels = {
    playing: 'Spelar',
    paused: 'Pausad',
    stopped: 'Stoppad',
    unknown: 'Okänt',
  };
  return labels[playback] ?? labels.unknown;
}

function computerTextValue(value) {
  return typeof value === 'string' && value.trim() ? value : 'Okänt';
}

function computerValuesLabel(values) {
  if (!Array.isArray(values)) return 'Okänt';
  if (values.length === 0) return 'Ingen uppgift rapporterad';
  const labels = values
    .slice(0, 3)
    .map(computerTextValue)
    .filter((value) => value !== 'Okänt');
  if (labels.length === 0) return 'Ingen uppgift rapporterad';
  const remaining = values.length - labels.length;
  return `${labels.join(', ')}${remaining > 0 ? ` (+${remaining})` : ''}`;
}

function renderMusicPlayer(target, device, commands, fade) {
  const article = node('article', 'music-row');
  const identity = node('div', 'music-identity');
  if (overview?.artwork) identity.append(renderMusicArtwork(target));
  identity.append(node('h3', '', displayMusicTarget(target)));
  identity.append(node('code', '', target));
  const availability = availabilityStatus(device.availability);
  identity.append(stateChip(availability.label, availability.tone));
  article.append(identity);

  const observed = device.observed ?? {};
  const newerPlaybackReport = commands.some(
    (command) =>
      command.target === target &&
      command.recovery?.verifiedAt > (device.observedAt ?? -1) &&
      typeof command.recovery?.reported?.playback === 'string' &&
      command.recovery.reported.playback !== observed.playback,
  );
  const reportedOnly =
    overviewStale ||
    device.availability !== 'available' ||
    overview?.musicObservationTrust?.[target] === false ||
    (overview?.health?.integrations?.home_assistant !== undefined &&
      overview.health.integrations.home_assistant !== 'connected') ||
    newerPlaybackReport;
  const readings = node('dl', 'music-readings');
  appendReading(
    readings,
    reportedOnly ? 'Senast rapporterad uppspelning' : 'Rapporterad uppspelning',
    musicPlaybackLabel(observed.playback),
  );
  appendReading(
    readings,
    reportedOnly
      ? 'Senast rapporterad titel'
      : observed.playback === 'playing'
        ? 'Nu spelas'
        : 'Senaste titel',
    typeof observed.title === 'string' && observed.title.trim()
      ? observed.title
      : 'Ingen titel rapporterad',
  );
  appendReading(
    readings,
    reportedOnly ? 'Senast rapporterad volym' : 'Rapporterad volym',
    musicVolumeLabel(observed.volume),
  );
  appendReading(
    readings,
    reportedOnly ? 'Senast rapporterad källa' : 'Rapporterad källa',
    typeof observed.source === 'string' && observed.source
      ? observed.source
      : 'Okänd',
  );
  article.append(readings);

  const controls = node('div', 'music-controls');
  const unavailable = overviewStale || device.availability !== 'available';
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
  const policy = overview?.musicVolumePolicies?.[target];
  if (policy) {
    const authorityKey = `volume-authority:${target}`;
    const authority = node('div', 'music-transport');
    authority.setAttribute('role', 'group');
    authority.setAttribute(
      'aria-label',
      `Volymläge för ${displayMusicTarget(target)}`,
    );
    for (const [mode, title] of [
      ['auto', 'Auto'],
      ['manual', 'Manuellt'],
    ]) {
      const button = node('button', 'button button-quiet', title);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(policy.mode === mode));
      button.disabled =
        reportedOnly ||
        !!policy.authorityControlBlocked ||
        pendingActions.has(authorityKey);
      button.dataset.focusKey = `${authorityKey}:${mode}`;
      button.addEventListener('click', () => {
        void invokeCapability(
          'music.setVolumeAuthority',
          { target, mode },
          authorityKey,
        );
      });
      authority.append(button);
    }
    volumeControl.append(authority);
    volumeControl.append(
      node('p', 'field-help', settingsVolumeReason(policy.activityReason)),
    );
  }
  const volumeLabel = document.createElement('label');
  volumeLabel.className = 'music-control-title';
  volumeLabel.textContent = 'Volym';
  volumeControl.append(volumeLabel);
  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.id = `music-volume-${target.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
  volumeLabel.htmlFor = volumeSlider.id;
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
  // Bolt optimization: Iterating backward avoids O(N) allocation overhead compared to [...arr].reverse().find()
  for (let i = commands.length - 1; i >= 0; i--) {
    const command = commands[i];
    if (command.target === target && command.requested?.property === property) {
      return command;
    }
  }
  return undefined;
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
  const powerLabelId = `light-power-${target.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
  const labelElem = document.createElement('label');
  labelElem.className = 'power-label';
  labelElem.textContent = 'Ström';
  labelElem.htmlFor = powerLabelId;
  powerControl.append(labelElem);
  const powerLabel = node('label', 'power-toggle');
  const powerInput = document.createElement('input');
  powerInput.type = 'checkbox';
  powerInput.id = powerLabelId;
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
  if (minus.disabled) {
    if (disabled) {
      minus.title = 'Justering tillfälligt inaktiverad';
    } else if (!Number.isInteger(current)) {
      minus.title = 'Okänd ljusstyrka';
    } else {
      minus.title = 'Redan på lägsta nivån';
    }
  }
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
  if (plus.disabled) {
    if (disabled) {
      plus.title = 'Justering tillfälligt inaktiverad';
    } else if (!Number.isInteger(current)) {
      plus.title = 'Okänd ljusstyrka';
    } else {
      plus.title = 'Redan på högsta nivån';
    }
  }
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
      properties.every((property) =>
        lightingFeedbackMatches(
          property,
          desired[property],
          device.observed[property],
        ),
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
    : `Tillstånd ändrat ${timeFormat.format(date)}`;
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
    properties.every((property) =>
      lightingFeedbackMatches(
        property,
        desired[property],
        device.observed[property],
      ),
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

// Lugn 2 editors keep local drafts separate from authoritative SSE snapshots.
function renderMusicArtwork(target) {
  const frame = node('div', 'music-artwork');
  frame.setAttribute('aria-label', 'Skivomslag');
  const fallback = node('span', '', '♪');
  fallback.setAttribute('aria-label', 'Omslag saknas');
  frame.append(fallback);
  const artwork = overview.artwork?.[target];
  if (artwork?.status !== 'available' || typeof artwork.url !== 'string')
    return frame;
  try {
    const url = new URL(artwork.url, location.origin);
    if (url.origin !== location.origin || !artwork.url.startsWith('/'))
      return frame;
    const image = node('img');
    image.alt = '';
    image.width = 72;
    image.height = 72;
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      image.hidden = true;
      fallback.hidden = false;
    });
    image.addEventListener('load', () => {
      fallback.hidden = true;
    });
    image.src = url.href;
    frame.append(image);
  } catch {
    /* Malformed or external artwork keeps the fixed-size fallback. */
  }
  return frame;
}
function l2(id) {
  return document.getElementById(id);
}
function clone(value) {
  return structuredClone(value);
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function routineDirty() {
  return routineDraft !== null && !same(routineDraft, routineOriginal);
}
function intelligenceDirty() {
  return (
    intelligenceDraft !== null &&
    (!same(intelligenceDraft, intelligenceOriginal) ||
      !same(
        mappingDraft,
        Object.entries(
          intelligenceOriginal?.suggestions?.sceneMappings ?? {},
        ).map(([activity, scene]) => ({ activity, scene })),
      ))
  );
}
function initializeLugn2() {
  const pages = {
    oversikt: 'Översikt',
    belysning: 'Belysning',
    musik: 'Musik',
    rutiner: 'Rutiner',
    intelligens: 'Intelligens',
    system: 'System',
  };
  const navigate = (focus = false) => {
    const page = Object.hasOwn(pages, location.hash.slice(1))
      ? location.hash.slice(1)
      : 'oversikt';
    dashboardView.dataset.page = page;
    l2('page-title').textContent = pages[page];
    for (const link of document.querySelectorAll('.section-nav a')) {
      if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    for (const section of document.querySelectorAll('[data-pages]'))
      section.classList.toggle(
        'page-inactive',
        !section.dataset.pages.split(' ').includes(page),
      );
    if (focus) l2('page-title').focus();
    if (overview?.cameraDashboard) renderCameraWeb();
  };
  window.addEventListener('hashchange', () => navigate(true));
  navigate();
  l2('routine-new').addEventListener('click', () => openRoutine());
  l2('routine-night').addEventListener('click', () =>
    openRoutine(null, 'good_night'),
  );
  l2('routine-morning').addEventListener('click', () =>
    openRoutine(null, 'good_morning'),
  );
  for (const id of ['name', 'kind', 'enabled', 'scheduled', 'time']) {
    l2(`routine-${id}`).addEventListener(
      id === 'name' || id === 'time' ? 'input' : 'change',
      () => {
        if (!routineDraft) return;
        routineDraft.name = l2('routine-name').value;
        routineDraft.kind = l2('routine-kind').value;
        routineDraft.enabled = l2('routine-enabled').checked;
        routineDraft.schedule = l2('routine-scheduled').checked
          ? {
              time: l2('routine-time').value,
              weekdays: routineDraft.schedule?.weekdays ?? [
                1, 2, 3, 4, 5, 6, 7,
              ],
            }
          : null;
        l2('routine-schedule').hidden = !routineDraft.schedule;
        updateWeekdays();
        routineChanged();
      },
    );
  }
  l2('routine-add').addEventListener('click', () => {
    if (!routineDraft) return;
    if (routineDraft.steps.length >= 32) {
      l2('routine-status').textContent = 'En rutin kan ha högst 32 steg.';
      return;
    }
    routineDraft.steps.push(defaultRoutineStep(l2('routine-add-type').value));
    renderRoutineSteps();
    routineChanged();
    l2('routine-steps')
      .lastElementChild?.querySelector('select, input')
      ?.focus();
  });
  l2('routine-form').addEventListener('submit', saveRoutine);
  l2('routine-preview').addEventListener('click', previewRoutine);
  l2('routine-delete').addEventListener('click', deleteRoutine);
  l2('routine-discard').addEventListener('click', () => {
    if (
      routineDirty() &&
      !window.confirm('Kasta osparade ändringar i rutinen?')
    )
      return;
    routineDraft = null;
    routineOriginal = null;
    l2('routine-form').hidden = true;
    l2('routine-new').focus();
  });
  l2('intelligence-form').addEventListener('input', readIntelligenceForm);
  l2('intelligence-form').addEventListener('change', readIntelligenceForm);
  l2('intelligence-form').addEventListener('submit', saveIntelligence);
  l2('intelligence-add-mapping').addEventListener('click', () => {
    mappingDraft.push({ activity: '', scene: overview.scenes?.[0]?.id ?? '' });
    renderMappings();
    intelligenceChanged();
    l2('intelligence-mappings')
      .lastElementChild?.querySelector('input')
      ?.focus();
  });
  l2('intelligence-discard').addEventListener('click', async () => {
    if (
      intelligenceDirty() &&
      !window.confirm('Kasta osparade inställningar och hämta de sparade?')
    )
      return;
    await l2Operation('intelligence', 'intelligence-status', async () => {
      await fetchOverview();
      intelligenceDraft = null;
      renderLugn2();
      l2('intelligence-status').textContent =
        'Visar senast sparade inställningar.';
    });
  });
  window.addEventListener('beforeunload', (event) => {
    if (routineDirty() || intelligenceDirty() || l2Pending.size) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}
function l2Button(label, action, disabled = false) {
  const button = node('button', 'button button-quiet', label);
  button.type = 'button';
  button.disabled = disabled;
  button.addEventListener('click', action);
  return button;
}
function l2Select(options, value, onChange, label) {
  const select = node('select');
  select.setAttribute('aria-label', label);
  const entries = options.map((item) =>
    typeof item === 'string' ? [item, item] : item,
  );
  // A removed mapping stays visible in an unsaved draft, never silently replaced.
  if (value && !entries.some(([key]) => key === value))
    entries.push([value, `${value} (saknas i senaste status)`]);
  for (const [key, title] of entries) {
    const option = node('option', '', title);
    option.value = key;
    select.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}
function l2Field(label, input) {
  const field = node('label', 'editor-field', label);
  field.append(input);
  return field;
}
function l2Input(
  value,
  change,
  { type = 'text', min, max, step = '1', required = true } = {},
) {
  const input = node('input');
  input.type = type;
  input.value = value;
  input.required = required;
  if (min !== undefined) input.min = min;
  if (max !== undefined) input.max = max;
  if (type === 'number') input.step = step;
  input.addEventListener('input', () => {
    change(type === 'number' ? input.valueAsNumber : input.value);
    routineChanged();
  });
  return input;
}
function sceneOptions() {
  return (overview.scenes ?? []).map((scene) => [scene.id, scene.name]);
}
function musicTargets() {
  return Object.keys(overview.state?.music?.devices ?? {});
}
function lightTargets() {
  return Object.keys(overview.state?.lighting?.devices ?? {});
}
function defaultRoutineStep(type) {
  const target = musicTargets()[0] ?? '';
  const defaults = {
    scene: { type, sceneId: overview.scenes?.[0]?.id ?? '' },
    light: { type, targets: lightTargets(), brightness: 0, durationMs: 600000 },
    volume: { type, target, volume: 0.2, durationMs: 30000 },
    delay: { type, durationMs: 60000 },
    playback: { type, target, state: 'paused' },
    source: {
      type,
      target,
      source:
        overview.state?.music?.devices?.[target]?.allowedSources?.[0] ?? '',
    },
    preset: { type, target, preset: 'optical' },
    condition: { type, condition: 'occupied' },
  };
  return defaults[type];
}
function openRoutine(definition = null, template = null) {
  if (!overview.routines || l2Pending.has('routine')) return;
  if (routineDirty()) {
    l2('routine-status').textContent =
      'Spara eller kasta ditt utkast innan du väljer en annan rutin.';
    l2('routine-name').focus();
    return;
  }
  routineOriginal = definition ? clone(definition) : null;
  routineGeneration = overview.routines.generation;
  routineDraft = definition
    ? clone(definition)
    : {
        id: `routine-${crypto.randomUUID()}`,
        name:
          template === 'good_night'
            ? 'God natt'
            : template === 'good_morning'
              ? 'God morgon'
              : '',
        kind: template ?? 'custom',
        enabled: false,
        schedule: null,
        steps: [],
      };
  if (template) {
    const scenes = overview.scenes ?? [];
    const cozy =
      scenes.find((scene) => /mys|cozy/i.test(scene.name)) ?? scenes[0];
    routineDraft.steps =
      template === 'good_night'
        ? [
            ...(cozy ? [{ type: 'scene', sceneId: cozy.id }] : []),
            {
              type: 'light',
              targets: lightTargets(),
              brightness: 0,
              durationMs: 600000,
            },
          ]
        : [
            {
              type: 'light',
              targets: lightTargets(),
              brightness: 40,
              durationMs: 600000,
            },
          ];
  }
  fillRoutineForm();
  l2('routine-name').focus();
}
function fillRoutineForm() {
  l2('routine-form').hidden = false;
  l2('routine-name').value = routineDraft.name;
  l2('routine-kind').value = routineDraft.kind;
  l2('routine-enabled').checked = routineDraft.enabled;
  l2('routine-scheduled').checked = !!routineDraft.schedule;
  l2('routine-time').value = routineDraft.schedule?.time ?? '22:30';
  l2('routine-schedule').hidden = !routineDraft.schedule;
  l2('routine-delete').hidden = !routineOriginal;
  l2('routine-status').textContent = routineDraft.enabled
    ? 'Aktiverad i utkastet. Ändringar gäller efter Spara.'
    : 'Avstängd. Spara ändrar inte rummets aktuella läge.';
  updateWeekdays();
  renderRoutineSteps();
  routineChanged();
}
function updateWeekdays() {
  const container = l2('routine-weekdays');
  container.replaceChildren(node('legend', '', 'Dagar'));
  ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'].forEach((day, index) => {
    const input = node('input');
    input.type = 'checkbox';
    input.checked =
      routineDraft?.schedule?.weekdays.includes(index + 1) ?? false;
    input.addEventListener('change', () => {
      if (!routineDraft.schedule) return;
      const days = new Set(routineDraft.schedule.weekdays);
      if (input.checked) days.add(index + 1);
      else days.delete(index + 1);
      routineDraft.schedule.weekdays = [...days].sort((a, b) => a - b);
      routineChanged();
    });
    container.append(l2Field(day, input));
  });
}
function renderRoutineSteps() {
  const list = l2('routine-steps');
  list.replaceChildren();
  const names = {
    scene: 'Ljusscen',
    light: 'Dimma / släck',
    volume: 'Volym',
    delay: 'Vänta',
    playback: 'Uppspelning',
    source: 'Musikkälla',
    preset: 'Musikpreset',
    condition: 'Villkor',
  };
  routineDraft.steps.forEach((step, index) => {
    const row = node('li', 'routine-step');
    const heading = node('div', 'step-heading');
    heading.append(node('h4', '', `${index + 1}. ${names[step.type]}`));
    const actions = node('div', 'inline-actions');
    for (const [label, offset] of [
      ['Flytta upp', -1],
      ['Flytta ned', 1],
    ])
      actions.append(
        l2Button(
          label,
          () => {
            const next = index + offset;
            [routineDraft.steps[index], routineDraft.steps[next]] = [
              routineDraft.steps[next],
              routineDraft.steps[index],
            ];
            renderRoutineSteps();
            routineChanged();
            l2('routine-steps')
              .children[next]?.querySelector('select, input')
              ?.focus();
          },
          index + offset < 0 || index + offset >= routineDraft.steps.length,
        ),
      );
    actions.append(
      l2Button('Ta bort steg', () => {
        routineDraft.steps.splice(index, 1);
        renderRoutineSteps();
        routineChanged();
        l2('routine-add').focus();
      }),
    );
    heading.append(actions);
    row.append(heading);
    const fields = node('div', 'form-grid');
    const choose = (key, label, options) =>
      fields.append(
        l2Field(
          label,
          l2Select(
            options,
            step[key] ?? '',
            (value) => {
              step[key] = value;
              routineChanged();
            },
            label,
          ),
        ),
      );
    if (step.type === 'scene') choose('sceneId', 'Ljusscen', sceneOptions());
    if ('target' in step && step.type !== 'condition')
      choose('target', 'Musikspelare', musicTargets());
    if (step.type === 'light') {
      const targets = node('fieldset', 'step-targets');
      targets.append(node('legend', '', 'Lampor'));
      const available = [...new Set([...lightTargets(), ...step.targets])];
      if (!available.length)
        targets.append(
          node('p', 'field-help', 'Inga lampor är konfigurerade.'),
        );
      for (const target of available) {
        const input = node('input');
        input.type = 'checkbox';
        input.checked = step.targets.includes(target);
        input.addEventListener('change', () => {
          step.targets = input.checked
            ? [...new Set([...step.targets, target])]
            : step.targets.filter((item) => item !== target);
          routineChanged();
        });
        targets.append(l2Field(displayTarget(target), input));
      }
      fields.append(
        targets,
        l2Field(
          'Ljusstyrka (%)',
          l2Input(
            step.brightness,
            (value) => {
              step.brightness = value;
            },
            { type: 'number', min: 0, max: 100 },
          ),
        ),
      );
    }
    if (step.type === 'volume')
      fields.append(
        l2Field(
          'Volym (%)',
          l2Input(
            step.volume * 100,
            (value) => {
              step.volume = value / 100;
            },
            { type: 'number', min: 0, max: 100, step: 'any' },
          ),
        ),
      );
    if ('durationMs' in step) {
      const volume = step.type === 'volume';
      const unit = volume ? 1000 : 60000;
      fields.append(
        l2Field(
          volume
            ? 'Förändringstid (sekunder)'
            : step.type === 'delay'
              ? 'Vänta (minuter)'
              : 'Förändringstid (minuter)',
          l2Input(
            step.durationMs / unit,
            (value) => {
              step.durationMs = Math.round(value * unit);
            },
            {
              type: 'number',
              min: 0,
              max: volume ? 120 : 60,
              step: 'any',
            },
          ),
        ),
      );
      if (volume)
        fields.append(
          node(
            'p',
            'field-help',
            '0 sekunder ändrar direkt. Annars 1–120 sekunder. Manuellt ägd volym kan blockera steget; serverns körningsstatus visar utfallet.',
          ),
        );
    }
    if (step.type === 'playback')
      choose('state', 'Uppspelning', [
        ['playing', 'Spela'],
        ['paused', 'Pausa'],
      ]);
    if (step.type === 'preset')
      choose('preset', 'Preset', [
        ['spotify_dj', 'Spotify DJ'],
        ['optical', 'Optical'],
      ]);
    if (step.type === 'source')
      fields.append(
        l2Field(
          'Exakt källnamn',
          l2Input(step.source, (value) => {
            step.source = value;
          }),
        ),
      );
    if (step.type === 'condition') {
      choose('condition', 'Fortsätt bara om', [
        ['occupied', 'Någon är i rummet'],
        ['home', 'Hemma'],
        ['music_idle', 'Musiken är inaktiv'],
      ]);
      choose('target', 'Spelare (valfri)', [
        ['', 'Ingen särskild spelare'],
        ...musicTargets().map((target) => [target, target]),
      ]);
    }
    row.append(fields);
    list.append(row);
  });
  if (!routineDraft.steps.length)
    list.append(node('li', 'empty-note', 'Lägg till det första steget nedan.'));
}
function routineChanged() {
  routinePreviewRevision += 1;
  l2('routine-preview-summary').textContent =
    'Utkastet behöver förhandsvisas. Inga kommandon skickas vid förhandsvisning.';
  l2('routine-timeline').replaceChildren();
  updateLugn2Controls();
}
function validateRoutine() {
  if (!routineDraft.name.trim()) throw new Error('Ge rutinen ett namn.');
  if (!routineDraft.steps.length) throw new Error('Lägg till minst ett steg.');
  if (routineDraft.steps.length > 32)
    throw new Error('En rutin kan ha högst 32 steg.');
  if (
    routineDraft.steps.reduce(
      (total, step) => total + (step.durationMs ?? 0),
      0,
    ) > 21600000
  )
    throw new Error('Stegens sammanlagda tid får vara högst 6 timmar.');
  if (
    routineDraft.schedule &&
    (!/^\d{2}:\d{2}$/.test(routineDraft.schedule.time) ||
      !routineDraft.schedule.weekdays.length)
  )
    throw new Error('Välj en tid och minst en veckodag.');
  for (const step of routineDraft.steps) {
    if (step.type === 'scene' && !step.sceneId)
      throw new Error('Välj ljusscen för varje scensteg.');
    if (
      step.type === 'light' &&
      (!step.targets.length ||
        !Number.isFinite(step.brightness) ||
        step.brightness < 0 ||
        step.brightness > 100)
    )
      throw new Error('Välj lampor och en ljusstyrka mellan 0 och 100 %.');
    if (
      'durationMs' in step &&
      (!Number.isFinite(step.durationMs) || step.durationMs < 0)
    )
      throw new Error('Ange en giltig tid som är minst 0.');
    if (
      (step.type === 'light' || step.type === 'delay') &&
      step.durationMs > 3600000
    )
      throw new Error('Ett ljus- eller väntesteg får ta högst 60 minuter.');
    if (
      step.type === 'volume' &&
      (step.durationMs > 120000 ||
        (step.durationMs > 0 && step.durationMs < 1000))
    )
      throw new Error(
        'Volymändring måste vara direkt (0 sekunder) eller ta 1–120 sekunder.',
      );
    if (step.type !== 'condition' && 'target' in step && !step.target)
      throw new Error('Välj musikspelare för varje musiksteg.');
    if (step.type === 'source' && !step.source.trim())
      throw new Error('Ange ett exakt källnamn.');
    if (
      step.type === 'volume' &&
      (!Number.isFinite(step.volume) || step.volume < 0 || step.volume > 1)
    )
      throw new Error('Volym måste vara mellan 0 och 100 %.');
  }
  const result = clone(routineDraft);
  for (const step of result.steps)
    if (step.type === 'condition' && !step.target) delete step.target;
  return result;
}
async function l2Request(path, body) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${API_ROOT}/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'X-Lugn-CSRF': csrfToken },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409) {
        try {
          await fetchOverview();
          render();
        } catch {
          /* Keep the draft if the recovery read also fails. */
        }
        throw new Error(
          'Ändrat på annat håll. Ditt utkast finns kvar. Kasta utkastet och öppna den sparade versionen innan du sparar igen.',
        );
      }
      if (response.status === 401 || response.status === 403)
        throw new Error(
          'Sessionen har gått ut eller ändrats. Logga in igen. Ditt utkast finns kvar.',
        );
      if (response.status === 404 || response.status === 501)
        throw new Error(
          'Funktionen är inte tillgänglig på den här servern ännu. Ditt utkast finns kvar.',
        );
      const details = Array.isArray(result.issues)
        ? result.issues.map((issue) => issue.message).join(' ')
        : null;
      throw new Error(
        details ||
          result.message ||
          'Begäran misslyckades. Ditt utkast finns kvar. Försök igen.',
      );
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError)
      throw new Error(
        'Servern svarar inte. Utfallet är okänt; kontrollera serverstatus innan du försöker igen. Utkastet finns kvar.',
      );
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
async function l2Mutation(path, body, key) {
  const previous = overview[key];
  const result = await l2Request(path, body);
  const valid =
    typeof result.generation === 'string' &&
    (key === 'routines'
      ? result.version === 1 &&
        Array.isArray(result.definitions) &&
        Array.isArray(result.runs) &&
        Array.isArray(result.next)
      : result.settings?.version === 1 &&
        Array.isArray(result.suggestions) &&
        Array.isArray(result.optical));
  if (!valid)
    throw new Error(
      'Servern tog emot begäran men returnerade ett ogiltigt status. Ditt utkast finns kvar. Hämta aktuell status innan du försöker igen.',
    );
  if (overview[key] === previous || same(overview[key], result))
    overview[key] = result;
  else {
    // Never overwrite a snapshot received while the request was pending with an older response.
    try {
      await fetchOverview();
    } catch {
      throw new Error(
        'Servern tog emot begäran men senaste status kunde inte hämtas. Ditt utkast finns kvar. Kontrollera anslutningen innan du försöker igen.',
      );
    }
  }
  return result;
}
async function l2Operation(key, statusId, work) {
  if (l2Pending.has(key)) return;
  l2Pending.add(key);
  updateLugn2Controls();
  l2(statusId).textContent = 'Väntar på serverns svar…';
  try {
    await work();
  } catch (error) {
    l2(statusId).textContent = error.message;
  } finally {
    l2Pending.delete(key);
    updateLugn2Controls();
  }
}
async function saveRoutine(event) {
  event.preventDefault();
  await l2Operation('routine', 'routine-status', async () => {
    const definition = validateRoutine();
    const saved = await l2Mutation(
      'routines/save',
      {
        definition,
        expectedGeneration: routineGeneration,
      },
      'routines',
    );
    routineDraft = clone(
      saved.definitions.find((item) => item.id === definition.id) ?? definition,
    );
    routineOriginal = clone(routineDraft);
    routineGeneration = saved.generation;
    render();
    l2('routine-delete').hidden = false;
    l2('routine-status').textContent = routineDraft.enabled
      ? 'Sparad och aktiverad. Enhetsläge bekräftas separat.'
      : 'Sparad och avstängd.';
  });
}
async function previewRoutine() {
  if (l2Pending.has('routine-preview')) return;
  const revision = routinePreviewRevision;
  await l2Operation('routine-preview', 'routine-status', async () => {
    const result = await l2Request('routines/preview', {
      definition: validateRoutine(),
    });
    if (revision !== routinePreviewRevision) {
      l2('routine-status').textContent =
        'Utkastet ändrades. Förhandsvisa igen.';
      return;
    }
    if (
      !Array.isArray(result.timeline) ||
      !Array.isArray(result.warnings) ||
      !Number.isFinite(result.durationMs)
    )
      throw new Error('Servern returnerade ett ogiltigt förlopp.');
    l2('routine-timeline').replaceChildren(
      ...result.timeline.map((entry, index) =>
        node(
          'li',
          '',
          `${formatRoutineDuration(entry.atMs)} · ${routineStepLabel(routineDraft.steps[index]) ?? entry.label}`,
        ),
      ),
    );
    l2('routine-preview-summary').textContent =
      `Total tid: ${formatRoutineDuration(result.durationMs)}. ${result.warnings.map(routineWarningLabel).join(' ')}`;
    l2('routine-status').textContent =
      'Förhandsvisning klar. Inga enhetskommandon har skickats.';
  });
}
function routineStepLabel(step) {
  if (!step) return null;
  const target = step.target ? displayMusicTarget(step.target) : '';
  const duration =
    'durationMs' in step && step.durationMs > 0
      ? ` under ${formatRoutineDuration(step.durationMs)}`
      : '';
  switch (step.type) {
    case 'scene':
      return `Välj ${overview.scenes.find((scene) => scene.id === step.sceneId)?.name ?? 'ljusscenen'}`;
    case 'light':
      return `${step.brightness === 0 ? 'Släck' : 'Dimma'} ${step.targets.map(displayTarget).join(', ')}${step.brightness === 0 ? '' : ` till ${step.brightness} %`}${duration}`;
    case 'volume':
      return `Ändra volymen för ${target} till ${Math.round(step.volume * 100)} %${duration}`;
    case 'delay':
      return `Vänta ${formatRoutineDuration(step.durationMs)}`;
    case 'playback':
      return `${step.state === 'playing' ? 'Spela' : 'Pausa'} ${target}`;
    case 'source':
      return `Välj ${step.source} på ${target}`;
    case 'preset':
      return `Välj ${step.preset === 'optical' ? 'Optical' : 'Spotify DJ'} på ${target}`;
    case 'condition':
      return {
        occupied: 'Fortsätt om någon är i rummet',
        home: 'Fortsätt om du är hemma',
        music_idle: `Fortsätt om ${target} inte spelar`,
      }[step.condition];
    default:
      return null;
  }
}
function routineWarningLabel(warning) {
  return (
    {
      'Routine is disabled; enable it explicitly before starting.':
        'Rutinen är avstängd. Aktivera och spara innan du startar.',
      'Europe/Stockholm: missing DST times are skipped; repeated times run once.':
        'Svensk tid: överhoppade klockslag vid sommartid hoppas över; upprepade klockslag körs en gång.',
      'Preview shows requested timing, not device confirmation. Policy and availability are rechecked during execution.':
        'Tiderna visar det planerade förloppet. Enhetsläge och tillåtelse kontrolleras när rutinen körs.',
    }[warning] ?? warning
  );
}
async function deleteRoutine() {
  if (!routineOriginal || !window.confirm(`Radera ”${routineDraft.name}”?`))
    return;
  await l2Operation('routine', 'routines-availability', async () => {
    await l2Mutation(
      'routines/delete',
      {
        id: routineDraft.id,
        expectedGeneration: routineGeneration,
      },
      'routines',
    );
    routineDraft = null;
    routineOriginal = null;
    l2('routine-form').hidden = true;
    render();
    l2('routines-availability').textContent = 'Rutinen är raderad.';
    l2('routine-new').focus();
  });
}
function formatRoutineDuration(ms) {
  return ms < 60000
    ? `${Math.round(ms / 1000)} s`
    : `${Math.round(ms / 6000) / 10} min`;
}
async function routineAction(id, action) {
  await l2Operation(`action:${id}`, 'routines-availability', async () => {
    await l2Mutation(
      'routines/action',
      {
        id,
        action,
        requestId: crypto.randomUUID(),
        ...(action === 'snooze' ? { minutes: 10 } : {}),
      },
      'routines',
    );
    render();
    l2('routines-availability').textContent =
      'Begäran mottagen. Körningsstatus visas från servern; enheternas rapporter bekräftar läget.';
  });
}
function renderRoutines() {
  const data = overview.routines;
  const available =
    data?.version === 1 &&
    typeof data.generation === 'string' &&
    Array.isArray(data.definitions) &&
    Array.isArray(data.runs) &&
    Array.isArray(data.next);
  l2('routines-availability').textContent = available
    ? 'Sparade rutiner. Nya rutiner och mallar är avstängda från början.'
    : 'Rutiner är inte tillgängliga på den här servern ännu. Befintliga ljus- och musikkontroller fungerar som vanligt.';
  for (const id of ['routine-new', 'routine-night', 'routine-morning'])
    l2(id).disabled = !available || overviewStale || l2Pending.has('routine');
  l2('routine-list').replaceChildren();
  l2('routine-runs').replaceChildren();
  if (!available) {
    l2('next-routine').textContent = 'Rutinstatus är inte tillgängligt ännu.';
    return;
  }
  const upcoming = data.next.slice().sort((a, b) => a.at - b.at)[0];
  l2('next-routine').textContent = upcoming
    ? `${data.definitions.find((item) => item.id === upcoming.routineId)?.name ?? 'Rutin'} · ${routineDateFormat.format(upcoming.at)} i Stockholm`
    : 'Ingen schemalagd rutin väntar. Du väljer när rummet ska förändras.';
  if (!data.definitions.length)
    l2('routine-list').append(
      node(
        'p',
        'empty-note',
        'Skapa en egen rutin eller börja med en avstängd mall.',
      ),
    );
  for (const definition of data.definitions) {
    const row = node('article', 'routine-row');
    const copy = node('div');
    copy.append(
      node('h3', '', definition.name),
      node(
        'p',
        'field-help',
        `${definition.enabled ? 'Aktiverad' : 'Avstängd'} · ${definition.steps.length} steg${definition.schedule ? ` · ${definition.schedule.time} Stockholm` : ' · startas manuellt'}`,
      ),
    );
    const actions = node('div', 'inline-actions');
    const disabled = overviewStale || l2Pending.has(`action:${definition.id}`);
    const edit = l2Button(
      'Redigera',
      () => openRoutine(definition),
      l2Pending.has('routine'),
    );
    edit.setAttribute('aria-label', `Redigera ${definition.name}`);
    actions.append(edit);
    actions.append(
      l2Button(
        'Starta',
        () => routineAction(definition.id, 'start'),
        disabled || !definition.enabled,
      ),
    );
    if (data.next.some((item) => item.routineId === definition.id)) {
      actions.append(
        l2Button(
          'Snooza 10 min',
          () => routineAction(definition.id, 'snooze'),
          disabled,
        ),
        l2Button(
          'Hoppa över nästa',
          () => routineAction(definition.id, 'skip'),
          disabled,
        ),
      );
    }
    for (const button of actions.children) {
      button.dataset.focusKey = `routine:${definition.id}:${button.textContent}`;
      button.dataset.l2Pending =
        button.textContent === 'Redigera'
          ? 'routine'
          : `action:${definition.id}`;
      button.dataset.l2Unavailable = String(
        button.textContent === 'Starta' && !definition.enabled,
      );
    }
    row.append(copy, actions);
    l2('routine-list').append(row);
  }
  const statusNames = {
    running: 'Pågår',
    completed: 'Slutförd',
    cancelled: 'Avbruten',
    failed: 'Misslyckad',
  };
  for (const run of data.runs) {
    const row = node('article', 'run-row');
    row.append(
      node(
        'h3',
        '',
        data.definitions.find((item) => item.id === run.routineId)?.name ??
          run.routineId,
      ),
      node(
        'p',
        '',
        `${statusNames[run.status] ?? run.status}${run.status === 'running' || run.status === 'failed' ? ` · steg ${run.stepIndex + 1}` : ''}${run.reason ? ` · ${run.reason}` : ''}`,
      ),
    );
    if (run.status === 'running') {
      const cancel = l2Button(
        'Avbryt körning',
        () => routineAction(run.routineId, 'cancel'),
        overviewStale || l2Pending.has(`action:${run.routineId}`),
      );
      cancel.dataset.focusKey = `run:${run.id}:cancel`;
      cancel.dataset.l2Pending = `action:${run.routineId}`;
      cancel.dataset.l2Unavailable = 'false';
      row.append(cancel);
    }
    l2('routine-runs').append(row);
  }
  // A clean editor may track a new generation; a dirty editor retains its original concurrency token.
  if (routineDraft && !routineDirty() && !l2Pending.has('routine')) {
    const latest = data.definitions.find((item) => item.id === routineDraft.id);
    if (
      latest &&
      (!same(latest, routineDraft) || routineGeneration !== data.generation)
    ) {
      routineOriginal = clone(latest);
      routineDraft = clone(latest);
      routineGeneration = data.generation;
      fillRoutineForm();
    }
  }
}
function fillIntelligence() {
  const data = overview.intelligence;
  intelligenceDraft = clone(data.settings);
  intelligenceOriginal = clone(data.settings);
  intelligenceGeneration = data.generation;
  const settings = intelligenceDraft;
  l2('intelligence-optical-enabled').checked = settings.optical.enabled;
  l2('intelligence-mode').value = settings.optical.mode;
  const fillSelect = (id, options, value) => {
    const select = l2(id);
    select.replaceChildren(node('option', '', 'Välj…'));
    select.firstElementChild.value = '';
    const values = [...new Set([...options, ...(value ? [value] : [])])];
    for (const item of values) {
      const option = node('option', '', item);
      option.value = item;
      select.append(option);
    }
    select.value = value ?? '';
  };
  fillSelect(
    'intelligence-device',
    Object.keys(overview.state?.computer?.devices ?? {}),
    settings.optical.deviceId,
  );
  fillSelect('intelligence-target', musicTargets(), settings.optical.target);
  l2('intelligence-source').value = settings.optical.source ?? '';
  const sources = [
    ...new Set(
      Object.values(overview.state?.music?.devices ?? {}).flatMap(
        (device) => device.allowedSources ?? [],
      ),
    ),
  ];
  l2('intelligence-sources').replaceChildren(
    ...sources.map((source) => {
      const option = node('option');
      option.value = source;
      return option;
    }),
  );
  l2('intelligence-stability').value = settings.optical.stabilityMs / 1000;
  l2('intelligence-optical-cooldown').value =
    settings.optical.cooldownMs / 60000;
  l2('intelligence-activities').value =
    settings.optical.allowedActivities.join(', ');
  l2('intelligence-suggestions-enabled').checked = settings.suggestions.enabled;
  l2('intelligence-suggestions-cooldown').value =
    settings.suggestions.cooldownMs / 60000;
  mappingDraft = Object.entries(settings.suggestions.sceneMappings).map(
    ([activity, scene]) => ({ activity, scene }),
  );
  renderMappings();
}
function renderMappings() {
  l2('intelligence-mappings').replaceChildren();
  mappingDraft.forEach((mapping, index) => {
    const row = node('div', 'mapping-row');
    const input = node('input');
    input.value = mapping.activity;
    input.required = true;
    input.placeholder = 'Aktivitet, till exempel gaming';
    input.addEventListener('input', () => {
      mapping.activity = input.value;
      intelligenceChanged();
    });
    row.append(
      l2Field('Rapporterad aktivitet', input),
      l2Field(
        'Ljusscen',
        l2Select(
          sceneOptions(),
          mapping.scene,
          (value) => {
            mapping.scene = value;
            intelligenceChanged();
          },
          'Ljusscen för aktiviteten',
        ),
      ),
      l2Button('Ta bort koppling', () => {
        mappingDraft.splice(index, 1);
        renderMappings();
        intelligenceChanged();
        l2('intelligence-add-mapping').focus();
      }),
    );
    l2('intelligence-mappings').append(row);
  });
}
function readIntelligenceForm() {
  if (!intelligenceDraft) return;
  const optical = intelligenceDraft.optical;
  optical.enabled = l2('intelligence-optical-enabled').checked;
  optical.mode = l2('intelligence-mode').value;
  optical.deviceId = l2('intelligence-device').value || null;
  optical.target = l2('intelligence-target').value || null;
  optical.source = l2('intelligence-source').value.trim() || null;
  optical.stabilityMs = Math.round(
    l2('intelligence-stability').valueAsNumber * 1000,
  );
  optical.cooldownMs = Math.round(
    l2('intelligence-optical-cooldown').valueAsNumber * 60000,
  );
  optical.allowedActivities = [
    ...new Set(
      l2('intelligence-activities')
        .value.split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  optical.respectManual = true;
  intelligenceDraft.suggestions.enabled = l2(
    'intelligence-suggestions-enabled',
  ).checked;
  intelligenceDraft.suggestions.cooldownMs = Math.round(
    l2('intelligence-suggestions-cooldown').valueAsNumber * 60000,
  );
  intelligenceChanged();
}
function intelligenceChanged() {
  intelligenceDraft.suggestions.sceneMappings = Object.fromEntries(
    mappingDraft.map(({ activity, scene }) => [activity.trim(), scene]),
  );
  l2('intelligence-status').textContent = intelligenceDirty()
    ? 'Osparade ändringar. Sparade regler gäller tills du sparar.'
    : 'Inga osparade ändringar.';
  updateLugn2Controls();
}
async function saveIntelligence(event) {
  event.preventDefault();
  await l2Operation('intelligence', 'intelligence-status', async () => {
    readIntelligenceForm();
    const settings = clone(intelligenceDraft);
    if (
      !Number.isInteger(settings.optical.stabilityMs) ||
      settings.optical.stabilityMs < 1000 ||
      settings.optical.stabilityMs > 300000 ||
      [settings.optical.cooldownMs, settings.suggestions.cooldownMs].some(
        (value) => !Number.isInteger(value) || value < 1000 || value > 86400000,
      )
    )
      throw new Error(
        'Stabil aktivitet måste vara 1–300 sekunder. Pausen mellan beslut eller förslag måste vara 1 sekund–24 timmar.',
      );
    if (
      settings.optical.enabled &&
      (!settings.optical.deviceId ||
        !settings.optical.target ||
        !settings.optical.source ||
        !settings.optical.allowedActivities.length)
    )
      throw new Error(
        'Välj dator, spelare, exakt källa och tillåtna aktiviteter innan du aktiverar Optical.',
      );
    const activities = new Set([
      'gaming',
      'video',
      'music',
      'desktop',
      'idle',
      'unknown',
    ]);
    if (
      settings.optical.allowedActivities.some(
        (activity) => !activities.has(activity),
      ) ||
      mappingDraft.some((mapping) => !activities.has(mapping.activity.trim()))
    )
      throw new Error(
        'Välj en rapporterad aktivitet: gaming, video, music, desktop, idle eller unknown.',
      );
    if (
      mappingDraft.some(
        (mapping) => !mapping.activity.trim() || !mapping.scene,
      ) ||
      new Set(mappingDraft.map((mapping) => mapping.activity.trim())).size !==
        mappingDraft.length
    )
      throw new Error(
        'Varje scenkoppling behöver en unik aktivitet och en ljusscen.',
      );
    const saved = await l2Mutation(
      'intelligence/settings',
      {
        settings,
        expectedGeneration: intelligenceGeneration,
      },
      'intelligence',
    );
    intelligenceDraft = clone(saved.settings);
    intelligenceOriginal = clone(saved.settings);
    intelligenceGeneration = saved.generation;
    render();
    l2('intelligence-status').textContent =
      'Inställningarna är sparade. Serverns beslut visas ovan.';
  });
}
async function suggestionAction(id, action) {
  await l2Operation(
    `suggestion:${id}`,
    'intelligence-availability',
    async () => {
      await l2Mutation(
        'intelligence/suggestion',
        { id, action },
        'intelligence',
      );
      render();
      l2('intelligence-availability').textContent =
        action === 'accept'
          ? 'Begäran mottagen. Servern kontrollerar tillgänglighet och gällande regler; enhetens rapport bekräftar läget.'
          : 'Förslaget har hanterats. Servern avgör när ett nytt förslag kan visas.';
    },
  );
}
function renderIntelligence() {
  const data = overview.intelligence;
  const available =
    data?.settings?.version === 1 &&
    typeof data.generation === 'string' &&
    data.settings.optical &&
    data.settings.suggestions &&
    Array.isArray(data.suggestions) &&
    Array.isArray(data.optical);
  l2('intelligence-form').hidden = !available;
  l2('intelligence-availability').textContent = available
    ? 'Optical och förslag är frivilliga. Inget nytt aktiveras utan ditt sparade val.'
    : 'Intelligensinställningar är inte tillgängliga på den här servern ännu.';
  l2('intelligence-suggestions').replaceChildren();
  l2('optical-decisions').replaceChildren();
  l2('optical-evidence').hidden = !available;
  if (!available) return;
  if (
    !intelligenceDraft ||
    (!intelligenceDirty() &&
      intelligenceGeneration !== data.generation &&
      !l2Pending.has('intelligence'))
  )
    fillIntelligence();
  if (!data.suggestions.length)
    l2('intelligence-suggestions').append(
      node(
        'p',
        'empty-note',
        'Inga aktuella förslag. Bara konfigurerade scenkopplingar kan ge scenförslag.',
      ),
    );
  for (const suggestion of data.suggestions) {
    const row = node('article', 'suggestion-row');
    row.append(
      node('h3', '', suggestion.title),
      node('p', '', suggestion.reason),
      node(
        'p',
        'field-help',
        `Dator: ${suggestion.deviceId ?? 'okänd'}${suggestion.target ? ` · spelare: ${suggestion.target}` : ''}${suggestion.source ? ` · källa: ${suggestion.source}` : ''}`,
      ),
    );
    const actions = node('div', 'inline-actions');
    for (const [label, action] of [
      ['Acceptera', 'accept'],
      ['Avvisa', 'reject'],
      ['Stäng förslaget', 'dismiss'],
    ])
      actions.append(
        l2Button(
          label,
          () => suggestionAction(suggestion.id, action),
          overviewStale || l2Pending.has(`suggestion:${suggestion.id}`),
        ),
      );
    for (const button of actions.children) {
      button.dataset.focusKey = `suggestion:${suggestion.id}:${button.textContent}`;
      button.dataset.l2Pending = `suggestion:${suggestion.id}`;
      button.dataset.l2Unavailable = 'false';
    }
    row.append(actions);
    l2('intelligence-suggestions').append(row);
  }
  if (!data.optical.length)
    l2('optical-decisions').append(
      node(
        'p',
        'field-help',
        'Inget Optical-beslut är rapporterat. Uppspelning från PipeWire bevisar inte att ljud hörs.',
      ),
    );
  for (const decision of data.optical) {
    const row = node('div', 'evidence-row');
    row.append(
      node(
        'p',
        '',
        `${decision.deviceId ?? 'Dator'} · ${decision.status ?? decision.state ?? 'Bedömning'}${decision.reason ? ` · ${decision.reason}` : ''}`,
      ),
    );
    const details = node('details');
    details.append(
      node('summary', '', 'Serverns underlag'),
      node('pre', 'evidence-data', JSON.stringify(decision, null, 2)),
    );
    row.append(details);
    l2('optical-decisions').append(row);
  }
}
function updateLugn2Controls() {
  l2('routine-add').disabled =
    !routineDraft ||
    routineDraft.steps.length >= 32 ||
    l2Pending.has('routine');
  for (const button of document.querySelectorAll('[data-l2-pending]')) {
    button.disabled =
      overviewStale ||
      button.dataset.l2Unavailable === 'true' ||
      l2Pending.has(button.dataset.l2Pending);
  }
  const routinesAvailable =
    overview?.routines?.version === 1 &&
    typeof overview.routines.generation === 'string';
  l2('routine-fields').disabled = l2Pending.has('routine');
  l2('routine-save').disabled =
    !routinesAvailable ||
    overviewStale ||
    !routineDirty() ||
    l2Pending.has('routine');
  l2('routine-delete').disabled =
    !routinesAvailable || overviewStale || l2Pending.has('routine');
  l2('routine-preview').disabled =
    !routinesAvailable ||
    overviewStale ||
    l2Pending.has('routine-preview') ||
    l2Pending.has('routine');
  l2('intelligence-fields').disabled = l2Pending.has('intelligence');
  l2('intelligence-save').disabled =
    !overview?.intelligence ||
    overviewStale ||
    !intelligenceDirty() ||
    l2Pending.has('intelligence');
}
function renderLugn2() {
  l2('snapshot-notice').hidden = !overviewStale;
  l2('snapshot-notice').textContent =
    'Anslutningen är osäker. Senast kända värden visas. Nya rutiner och intelligensändringar väntar tills kontakten är återställd.';
  l2('system-snapshot').textContent =
    `Tillståndsrevision ${overview.state.revision}. ${overviewStale ? 'Inaktuellt tillstånd.' : 'Senaste mottagna serverstatus.'}`;
  renderRoutines();
  renderIntelligence();
  updateLugn2Controls();
}

function settingsElement(id) {
  return document.getElementById(`settings-${id}`);
}
function volumeSettingsDirty() {
  return (
    volumeSettingsDraft !== null &&
    JSON.stringify(volumeSettingsDraft) !==
      JSON.stringify(volumeSettingsOriginal)
  );
}
function volumePercent(value) {
  return value === null ? 'okänd' : `${Math.round(value * 1000) / 10} %`;
}
function volumeOffset(value) {
  return `${Math.round(value * 1000) / 10} pp`;
}
function volumeOwner(owner) {
  return { manual: 'manuell', lugn: 'Lugn', none: 'ingen' }[owner] ?? 'okänd';
}
function settingsMinute(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}
function settingsTime(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
function renderMusicSettings() {
  const available =
    overview.musicSettingsEnabled &&
    Object.keys(overview.state?.music?.devices ?? {}).length > 0;
  document.getElementById('music-settings-section').hidden = !available;
  if (!available) return;
  const targets = Object.keys(overview.state.music.devices);
  const select = settingsElement('preview-target');
  if (
    Array.from(select.options)
      .map((option) => option.value)
      .join() !== targets.join()
  ) {
    select.replaceChildren(
      ...targets.map((target) => {
        const option = document.createElement('option');
        option.value = target;
        option.textContent = target;
        return option;
      }),
    );
  }
  const target = select.value;
  const policy = overview.musicVolumePolicies?.[target];
  const current =
    !overviewStale &&
    overview.musicObservationTrust?.[target] !== false &&
    overview.state.music.devices[target]?.availability === 'available' &&
    (overview.health?.integrations?.home_assistant === undefined ||
      overview.health.integrations.home_assistant === 'connected');
  document.getElementById('music-settings-current').textContent = policy
    ? `${current ? 'Nu' : 'Senast rapporterat'} · Rapporterad volym ${volumePercent(overview.state.music.devices[target].observed.volume)} · Läge: ${policy.mode === 'manual' ? 'Manuellt' : 'Auto'} · Sparad Auto-bas ${volumePercent(policy.configuredBaseline ?? policy.baseline)} · Manuell referens ${volumePercent(policy.manualReference ?? null)} · Dygn ${volumeOffset(policy.dailyOffset)} · Personer ${volumeOffset(policy.personOffset)} · Optical ${volumeOffset(policy.sourceOffset ?? 0)} · Automatiskt mål ${volumePercent(policy.target)} · Aktivt mål ${volumePercent(policy.effectiveTarget ?? null)} · ${settingsVolumeReason(policy.activityReason)}`
    : 'Väntar på volympolicy.';
  if (
    !volumeSettingsDraft ||
    (!volumeSettingsBusy &&
      !volumeSettingsDirty() &&
      JSON.stringify(volumeSettingsOriginal) !==
        JSON.stringify(overview.musicSettings))
  ) {
    volumeSettingsOriginal = structuredClone(overview.musicSettings);
    volumeSettingsDraft = structuredClone(volumeSettingsOriginal);
    fillMusicSettings();
  }
}
function fillMusicSettings() {
  settingsElement('enabled').checked = volumeSettingsDraft.enabled;
  settingsElement('passive-reduction').checked =
    volumeSettingsDraft.passiveMultiPersonReductionEnabled === true;
  const bases = settingsElement('auto-bases');
  bases.replaceChildren();
  for (const target of Object.keys(overview.state.music.devices)) {
    const label = document.createElement('label');
    label.textContent = `${target} · Auto-bas (%)`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '100';
    input.step = '0.1';
    input.required = true;
    input.value =
      Math.round(
        (volumeSettingsDraft.autoBaseVolumes?.[target] ?? 0.3) * 1000,
      ) / 10;
    input.addEventListener('input', () => {
      volumeSettingsDraft.autoBaseVolumes ??= {};
      volumeSettingsDraft.autoBaseVolumes[target] = Number.isFinite(
        input.valueAsNumber,
      )
        ? input.valueAsNumber / 100
        : null;
      updateVolumeSettingsStatus();
    });
    label.append(input);
    bases.append(label);
  }
  for (const [id, key] of [
    ['person', 'personOffset'],
    ['minimum', 'minimum'],
    ['maximum', 'maximum'],
  ])
    settingsElement(id).value =
      Math.round(volumeSettingsDraft[key] * 1000) / 10;
  fillOpticalOffsets();
  renderVolumePoints();
  updateVolumeSettingsStatus();
}
function fillOpticalOffsets() {
  const container = settingsElement('optical-offsets');
  container.replaceChildren();
  for (const [target, device] of Object.entries(overview.state.music.devices)) {
    const saved = volumeSettingsDraft.opticalOffsets?.[target];
    const sources = [
      ...new Set([
        ...(device.allowedSources ?? []),
        ...(saved?.source ? [saved.source] : []),
      ]),
    ];
    const group = document.createElement('div');
    group.className = 'settings-grid optical-offset-row';
    group.dataset.target = target;
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'settings-toggle';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = saved?.enabled === true;
    enabled.setAttribute('aria-describedby', 'settings-optical-help');
    toggleLabel.append(enabled);
    const toggleText = document.createElement('span');
    toggleText.textContent = `Kompensera Optical · ${target}`;
    toggleLabel.append(toggleText);
    const sourceLabel = document.createElement('label');
    sourceLabel.textContent = 'Optical-ingång';
    const source = document.createElement('select');
    source.setAttribute('aria-label', `Optical-ingång för ${target}`);
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Välj ingång';
    source.append(placeholder);
    for (const name of sources) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      source.append(option);
    }
    source.value =
      saved?.source ??
      sources.find((name) => /^optical(?: in)?$/i.test(name)) ??
      '';
    sourceLabel.append(source);
    const offsetLabel = document.createElement('label');
    offsetLabel.textContent = 'Tillägg på Optical (procentenheter)';
    const offset = document.createElement('input');
    offset.type = 'number';
    offset.min = '0';
    offset.max = '20';
    offset.step = '0.1';
    offset.required = true;
    offset.value = Math.round((saved?.offset ?? 0.07) * 1000) / 10;
    offset.setAttribute(
      'aria-label',
      `Optical-tillägg för ${target} (procentenheter)`,
    );
    offsetLabel.append(offset);
    const sync = () => {
      enabled.disabled = !source.value;
      offset.disabled = !source.value;
    };
    const update = () => {
      sync();
      if (!source.value) {
        enabled.checked = false;
        if (volumeSettingsDraft.opticalOffsets)
          delete volumeSettingsDraft.opticalOffsets[target];
      } else {
        volumeSettingsDraft.opticalOffsets ??= {};
        volumeSettingsDraft.opticalOffsets[target] = {
          enabled: enabled.checked,
          source: source.value,
          offset: Number.isFinite(offset.valueAsNumber)
            ? offset.valueAsNumber / 100
            : null,
        };
      }
      updateVolumeSettingsStatus();
    };
    enabled.addEventListener('change', update);
    source.addEventListener('change', update);
    offset.addEventListener('input', update);
    sync();
    group.append(toggleLabel, sourceLabel, offsetLabel);
    container.append(group);
  }
}
function settingsVolumeReason(reason) {
  return (
    {
      active: 'Auto styr volymen',
      manual_hold:
        'Manuellt läge · välj Auto för att lämna tillbaka styrningen',
      automation_disabled: 'Volymautomatiken är av',
      presence_unknown: 'Volymstyrningen väntar på närvaro',
      person_count_unknown:
        'Manuellt läge · personsänkningen väntar på antal personer',
      confirmed_empty: 'Volymstyrningen väntar · rummet tomt',
      home_away: 'Volymstyrningen väntar · borta',
      fade_active: 'Volymen tonas',
      volume_unavailable: 'Inväntar tillförlitlig spelarvolym',
    }[reason] ?? 'Inväntar volymstatus'
  );
}
function renderVolumePoints() {
  const container = settingsElement('points');
  container.replaceChildren();
  volumeSettingsDraft.dailyCurve.forEach((point, index, points) => {
    const row = document.createElement('div');
    row.className = 'settings-point';
    const timeLabel = document.createElement('label');
    timeLabel.textContent = `Tidpunkt ${index + 1}`;
    const time = document.createElement('input');
    time.type = index === points.length - 1 ? 'text' : 'time';
    time.value = settingsTime(point.minute);
    time.required = true;
    time.disabled = index === 0 || index === points.length - 1;
    timeLabel.append(time);
    const numberLabel = document.createElement('label');
    numberLabel.textContent = 'Tillägg (pp)';
    const number = document.createElement('input');
    number.type = 'number';
    number.min = '-100';
    number.max = '100';
    number.step = '0.1';
    number.required = true;
    number.value = Math.round(point.offset * 1000) / 10;
    numberLabel.append(number);
    const sliderLabel = document.createElement('label');
    sliderLabel.className = 'settings-point-slider';

    const sliderLabelText = document.createElement('span');
    sliderLabelText.textContent = `Justera tillägg vid ${settingsTime(point.minute)}`;
    sliderLabel.append(sliderLabelText);

    const sliderId = `settings-point-slider-${index}`;
    const slider = document.createElement('input');
    slider.id = sliderId;
    slider.type = 'range';
    slider.min = '-100';
    slider.max = '100';
    slider.step = '0.1';
    slider.value = number.value;
    slider.setAttribute('aria-valuetext', `${slider.value} procentenheter`);

    sliderLabel.append(slider);
    function changeOffset(value) {
      point.offset = Number.isFinite(value) ? value / 100 : null;
      if (index === 0 || index === points.length - 1) {
        points[0].offset = point.offset;
        points.at(-1).offset = point.offset;
        for (const endpoint of [
          container.firstElementChild,
          container.lastElementChild,
        ]) {
          if (!endpoint) continue;
          endpoint.querySelector('input[type=number]').value = Number.isFinite(
            value,
          )
            ? value
            : '';
          const endSlider = endpoint.querySelector('input[type=range]');
          endSlider.value = Number.isFinite(value) ? value : 0;
          endSlider.setAttribute(
            'aria-valuetext',
            `${endSlider.value} procentenheter`,
          );
        }
      }
      slider.setAttribute('aria-valuetext', `${slider.value} procentenheter`);
      updateVolumeSettingsStatus();
    }
    number.addEventListener('input', () => {
      slider.value = number.value;
      slider.setAttribute('aria-valuetext', `${slider.value} procentenheter`);
      changeOffset(number.valueAsNumber);
    });
    slider.addEventListener('input', () => {
      number.value = slider.value;
      slider.setAttribute('aria-valuetext', `${slider.value} procentenheter`);
      changeOffset(slider.valueAsNumber);
    });
    time.addEventListener('input', () => {
      point.minute = time.value ? settingsMinute(time.value) : null;
      sliderLabel.firstChild.textContent = `Justera tillägg vid ${time.value || 'okänd tid'}`;
      updateVolumeSettingsStatus();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button button-quiet';
    remove.textContent = 'Ta bort';
    remove.setAttribute('aria-label', `Ta bort tidpunkt ${index + 1}`);
    remove.disabled = index === 0 || index === points.length - 1;
    remove.addEventListener('click', () => {
      points.splice(index, 1);
      renderVolumePoints();
      updateVolumeSettingsStatus();
    });
    row.append(timeLabel, numberLabel, sliderLabel, remove);
    container.append(row);
  });
}
function drawVolumeCurve() {
  const svg = settingsElement('curve');
  const points = volumeSettingsDraft.dailyCurve;
  const values = points.map((point) => point.offset).filter(Number.isFinite);
  const min = Math.min(-0.2, ...values),
    max = Math.max(0.05, ...values);
  const y = (value) => 140 - ((value - min) / (max - min)) * 100;
  const create = (tag, attributes) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes))
      node.setAttribute(key, value);
    svg.append(node);
    return node;
  };
  svg.replaceChildren();
  create('line', {
    x1: 40,
    x2: 680,
    y1: y(0),
    y2: y(0),
    stroke: 'currentColor',
    'stroke-opacity': 0.4,
  });
  create('polyline', {
    points: points
      .filter((p) => Number.isFinite(p.minute) && Number.isFinite(p.offset))
      .map((p) => `${40 + (p.minute / 1440) * 640},${y(p.offset)}`)
      .join(' '),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
  });
  points.forEach((p) => {
    if (Number.isFinite(p.minute) && Number.isFinite(p.offset))
      create('circle', {
        cx: 40 + (p.minute / 1440) * 640,
        cy: y(p.offset),
        r: 4,
        fill: 'currentColor',
      });
  });
  for (const [hour, x] of [
    ['00', 40],
    ['06', 200],
    ['12', 360],
    ['18', 520],
    ['24', 680],
  ])
    create('text', {
      x,
      y: 185,
      'text-anchor': 'middle',
      fill: 'currentColor',
    }).textContent = `${hour}:00`;
  create('text', { x: 40, y: 25, fill: 'currentColor' }).textContent =
    `${Math.round(max * 100)} pp`;
  create('text', { x: 40, y: 160, fill: 'currentColor' }).textContent =
    `${Math.round(min * 100)} pp`;
}
function updateVolumeSettingsStatus() {
  volumePreviewRevision++;
  settingsElement('preview-result').textContent =
    'Förhandsvisningen behöver beräknas för detta utkast.';
  settingsElement('status').textContent = volumeSettingsDirty()
    ? 'Osparade ändringar. Spelarens volym har inte ändrats av utkastet.'
    : 'Inga osparade ändringar.';
  settingsElement('status').removeAttribute('data-tone');
  settingsElement('save').disabled =
    volumeSettingsBusy || !volumeSettingsDirty();
  settingsElement('cancel').disabled =
    volumeSettingsBusy || !volumeSettingsDirty();
  settingsElement('add-point').disabled =
    volumeSettingsDraft.dailyCurve.length >= 48;
  drawVolumeCurve();
}
async function musicSettingsRequest(path, body) {
  const response = await fetch(`${API_ROOT}/music-settings${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'X-Lugn-CSRF': csrfToken },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const messages = {
      volume_settings_changed:
        'Inställningarna har ändrats någon annanstans. Ditt utkast finns kvar. Avbryt ändringarna för att hämta senaste versionen.',
      volume_settings_save_failed:
        'Kunde inte lagra inställningarna. Ditt utkast finns kvar. Försök igen.',
      invalid_optical_offset_source:
        'Välj en ingång som finns på den valda spelaren. Ditt utkast finns kvar.',
      unauthorized:
        'Sessionen har gått ut. Logga in igen; utkastet finns kvar.',
      csrf_failed: 'Sessionen har ändrats. Försök igen eller logga in igen.',
    };
    const details = result.issues
      ?.map((issue) => `${issue.path}: ${issue.message}`)
      .join(' ');
    throw new Error(
      messages[result.error] ?? details ?? 'Begäran misslyckades. Försök igen.',
    );
  }
  return result;
}
for (const [id, key] of [
  ['person', 'personOffset'],
  ['minimum', 'minimum'],
  ['maximum', 'maximum'],
])
  settingsElement(id).addEventListener('input', (event) => {
    volumeSettingsDraft[key] = Number.isFinite(event.target.valueAsNumber)
      ? event.target.valueAsNumber / 100
      : null;
    updateVolumeSettingsStatus();
  });
settingsElement('enabled').addEventListener('change', (event) => {
  volumeSettingsDraft.enabled = event.target.checked;
  updateVolumeSettingsStatus();
});
settingsElement('passive-reduction').addEventListener('change', (event) => {
  volumeSettingsDraft.passiveMultiPersonReductionEnabled = event.target.checked;
  updateVolumeSettingsStatus();
});
settingsElement('add-point').addEventListener('click', () => {
  const points = volumeSettingsDraft.dailyCurve;
  let index = 1;
  for (let i = 2; i < points.length; i++)
    if (
      points[i].minute - points[i - 1].minute >
      points[index].minute - points[index - 1].minute
    )
      index = i;
  if (points[index].minute - points[index - 1].minute < 2) return;
  points.splice(index, 0, {
    minute: Math.floor((points[index].minute + points[index - 1].minute) / 2),
    offset: points[index - 1].offset,
  });
  renderVolumePoints();
  updateVolumeSettingsStatus();
});
settingsElement('cancel').addEventListener('click', () => {
  volumeSettingsOriginal = structuredClone(overview.musicSettings);
  volumeSettingsDraft = structuredClone(volumeSettingsOriginal);
  fillMusicSettings();
});
settingsElement('reset').addEventListener('click', () => {
  volumeSettingsDraft = structuredClone(overview.musicSettingsDefaults);
  fillMusicSettings();
  settingsElement('status').textContent =
    'Standardvärden i utkastet. Spara för att tillämpa dem, eller avbryt.';
});
for (const id of ['preview-target', 'preview-time', 'preview-people'])
  settingsElement(id).addEventListener('input', () => {
    volumePreviewRevision++;
    settingsElement('preview-result').textContent =
      'Förhandsvisningen behöver beräknas igen.';
  });
settingsElement('preview-button').addEventListener('click', async () => {
  const revision = ++volumePreviewRevision;
  settingsElement('preview-button').disabled = true;
  settingsElement('preview-result').textContent = 'Beräknar…';
  try {
    const result = await musicSettingsRequest('/preview', {
      settings: volumeSettingsDraft,
      target: settingsElement('preview-target').value,
      minute: settingsElement('preview-time').value
        ? settingsMinute(settingsElement('preview-time').value)
        : null,
      personCount: settingsElement('preview-people').valueAsNumber,
    });
    if (revision !== volumePreviewRevision) return;
    settingsElement('preview-result').textContent =
      `Baslinje ${volumePercent(result.baseline)} + dygn ${volumeOffset(result.dailyOffset)} + personer ${volumeOffset(result.personOffset)} + Optical ${volumeOffset(result.sourceOffset ?? 0)} → automatiskt mål ${volumePercent(result.target)} (inom utkastets gränser). Rapporterad volym: ${volumePercent(result.observedVolume)}. Nuvarande volymägare: ${volumeOwner(result.activeOwner)}. ${result.enabled ? '' : 'Automatiken är avstängd i utkastet.'} Inga kommandon skickades.`;
  } catch (error) {
    if (revision === volumePreviewRevision)
      settingsElement('preview-result').textContent = error.message;
  } finally {
    settingsElement('preview-button').disabled = false;
  }
});
document
  .getElementById('music-settings-form')
  .addEventListener('submit', async (event) => {
    event.preventDefault();
    if (volumeSettingsBusy || !volumeSettingsDirty()) return;
    volumeSettingsBusy = true;
    settingsElement('fields').disabled = true;
    for (const id of ['save', 'cancel', 'reset', 'preview-button'])
      settingsElement(id).disabled = true;
    settingsElement('save').textContent = 'Sparar…';
    settingsElement('status').textContent = 'Sparar inställningar…';
    try {
      const result = await musicSettingsRequest('', {
        settings: volumeSettingsDraft,
        expectedSettings: volumeSettingsOriginal,
      });
      overview.musicSettings = result.settings;
      volumeSettingsOriginal = structuredClone(result.settings);
      volumeSettingsDraft = structuredClone(result.settings);
      volumeSettingsBusy = false;
      fillMusicSettings();
      settingsElement('status').textContent =
        'Sparat och tillämpat. Manuella volymhållningar behålls.';
    } catch (error) {
      settingsElement('status').textContent = error.message;
      settingsElement('status').dataset.tone = 'bad';
    } finally {
      volumeSettingsBusy = false;
      settingsElement('fields').disabled = false;
      settingsElement('save').textContent = 'Spara och tillämpa';
      settingsElement('save').disabled = !volumeSettingsDirty();
      settingsElement('cancel').disabled = !volumeSettingsDirty();
      settingsElement('reset').disabled = false;
      settingsElement('preview-button').disabled = false;
    }
  });
window.addEventListener('beforeunload', (event) => {
  if (volumeSettingsDirty() || volumeSettingsBusy) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// Camera settings keep an independent local draft while live room state changes.
function cameraWebDirty() {
  return (
    cameraWebDraft !== null &&
    JSON.stringify(cameraWebDraft) !== JSON.stringify(cameraWebOriginal)
  );
}
function cameraWebNow() {
  return Number.isFinite(overview?.generatedAt)
    ? overview.generatedAt + Date.now() - lastOverviewAt
    : Date.now();
}
function cameraWebSafeUrl(value) {
  if (typeof value !== 'string' || !/^(\/|\.\/)/.test(value)) return null;
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function stopCameraWebMedia() {
  cameraWebMediaEpoch += 1;
  window.clearTimeout(cameraWebImageTimer);
  window.clearTimeout(cameraWebImageTimeout);
  cameraWebController?.abort();
  cameraWebController = null;
  const image = l2('camera-web-image');
  image.onload = null;
  image.onerror = null;
  image.removeAttribute('src');
  image.hidden = true;
  if (cameraWebObjectUrl) URL.revokeObjectURL(cameraWebObjectUrl);
  cameraWebObjectUrl = null;
  cameraWebMediaKey = null;
}
function cameraWebCanRun(epoch) {
  return (
    epoch === cameraWebMediaEpoch &&
    !overviewStale &&
    csrfToken &&
    !dashboardView.hidden &&
    document.visibilityState !== 'hidden' &&
    !l2('camera-web-panel').hidden &&
    ['oversikt', 'intelligens'].includes(dashboardView.dataset.page) &&
    overview?.cameraDashboard?.active?.expiresAt > cameraWebNow()
  );
}
function startCameraWebMedia(active) {
  stopCameraWebMedia();
  const epoch = cameraWebMediaEpoch;
  cameraWebMediaKey = `${active.id}|${active.imageUrl ?? ''}`;
  const image = l2('camera-web-image');
  const placeholder = l2('camera-web-placeholder');
  const status = l2('camera-web-media-status');
  placeholder.hidden = false;
  placeholder.textContent = 'Hämtar kamerabild …';
  status.textContent = 'Tyst kameravy · uppdateras varje sekund';
  const imageUrl = cameraWebSafeUrl(active.imageUrl);
  if (!imageUrl) {
    placeholder.textContent = 'Kamerabilden är inte tillgänglig.';
    return;
  }
  let failures = 0;
  const frame = async () => {
    if (!cameraWebCanRun(epoch)) return;
    const controller = new AbortController();
    cameraWebController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    cameraWebImageTimeout = timeout;
    try {
      const response = await fetch(imageUrl, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (
        !response.ok ||
        !response.headers.get('content-type')?.startsWith('image/')
      )
        throw new Error('image_unavailable');
      const blob = await response.blob();
      if (!cameraWebCanRun(epoch)) return;
      if (blob.size > 8 * 1024 * 1024) throw new Error('image_too_large');
      const nextUrl = URL.createObjectURL(blob);
      if (cameraWebObjectUrl) URL.revokeObjectURL(cameraWebObjectUrl);
      cameraWebObjectUrl = nextUrl;
      image.onload = () => {
        if (!cameraWebCanRun(epoch)) return;
        failures = 0;
        image.hidden = false;
        placeholder.hidden = true;
        status.textContent = `Uppdaterad bild kl. ${new Date().toLocaleTimeString('sv-SE')}`;
        cameraWebImageTimer = window.setTimeout(frame, 1000);
      };
      image.onerror = () => {
        if (!cameraWebCanRun(epoch)) return;
        status.textContent = 'Kamerabilden kunde inte visas.';
      };
      image.src = nextUrl;
    } catch {
      if (!cameraWebCanRun(epoch)) return;
      failures += 1;
      status.textContent =
        failures < 3
          ? 'Ingen ny bild. Försöker igen …'
          : 'Kameran svarar inte. Stäng och öppna vyn för att försöka igen.';
      if (!image.hidden) status.textContent += ' Bilden är inaktuell.';
      if (failures < 3) cameraWebImageTimer = window.setTimeout(frame, 2000);
    } finally {
      window.clearTimeout(timeout);
      if (cameraWebController === controller) cameraWebController = null;
    }
  };
  void frame();
}
function cameraWebCheckbox(container, label, value, checked, onChange) {
  const row = node('label', 'check-label');
  const input = node('input');
  input.type = 'checkbox';
  input.value = value;
  input.checked = checked;
  input.addEventListener('change', () => {
    onChange(input.checked);
    updateCameraWebControls();
  });
  row.append(input, node('span', '', label));
  container.append(row);
  return row;
}
function fillCameraWebSettings(data) {
  cameraWebOriginal = structuredClone(data.settings);
  cameraWebDraft = structuredClone(data.settings);
  cameraWebGeneration = data.generation;
  l2('camera-enabled').checked = cameraWebDraft.enabled;
  l2('camera-automatic').checked = cameraWebDraft.automaticEnabled;
  l2('camera-duration').value = String(cameraWebDraft.durationSeconds);
  const cameras = l2('camera-camera-fields');
  cameras.replaceChildren();
  for (const camera of data.definitions) {
    const row = cameraWebCheckbox(
      cameras,
      `${camera.name}${camera.available ? '' : ' (otillgänglig)'}`,
      camera.id,
      cameraWebDraft.cameras[camera.id] === true,
      (checked) => {
        cameraWebDraft.cameras[camera.id] = checked;
      },
    );
    row.dataset.cameraId = camera.id;
  }
  const triggers = l2('camera-trigger-fields');
  triggers.replaceChildren();
  for (const trigger of data.triggers)
    cameraWebCheckbox(
      triggers,
      trigger.name,
      trigger.id,
      cameraWebDraft.triggers[trigger.id] === true,
      (checked) => {
        cameraWebDraft.triggers[trigger.id] = checked;
      },
    );
  if (!data.triggers.length)
    triggers.append(node('p', '', 'Inga kamerahändelser är konfigurerade.'));
  const viewers = l2('camera-viewer-fields');
  viewers.replaceChildren();
  for (const [id, label] of [
    ['bed', 'Bed'],
    ['desk', 'Desk'],
    ['web', 'Webb'],
  ])
    cameraWebCheckbox(
      viewers,
      label,
      id,
      cameraWebDraft.viewers.includes(id),
      (checked) => {
        cameraWebDraft.viewers = checked
          ? [...cameraWebDraft.viewers, id]
          : cameraWebDraft.viewers.filter((item) => item !== id);
      },
    );
}
function updateCameraWebControls() {
  const dirty = cameraWebDirty();
  l2('camera-save').disabled = !dirty || cameraWebBusy || overviewStale;
  l2('camera-discard').disabled = !dirty || cameraWebBusy;
  l2('camera-fields').disabled = cameraWebBusy;
  l2('camera-save').textContent = cameraWebBusy
    ? 'Sparar …'
    : 'Spara kamerainställningar';
}
function renderCameraWeb() {
  const data = overview?.cameraDashboard;
  l2('cameras-section').hidden = !data;
  if (!data) {
    if (cameraWebMediaKey) stopCameraWebMedia();
    return;
  }
  if (
    !cameraWebDraft ||
    (!cameraWebDirty() &&
      !cameraWebBusy &&
      cameraWebGeneration !== data.generation)
  )
    fillCameraWebSettings(data);
  for (const row of l2('camera-camera-fields').children) {
    const camera = data.definitions.find(
      (item) => item.id === row.dataset.cameraId,
    );
    if (camera && row.children[1])
      row.children[1].textContent = `${camera.name}${camera.available ? '' : ' (otillgänglig)'}`;
  }
  l2('camera-web-summary').textContent = !data.settings.enabled
    ? 'Kameravisning är avstängd.'
    : data.settings.automaticEnabled
      ? `Händelsestyrd kameravy är på · ${data.settings.durationSeconds} sekunder`
      : 'Manuell kameravisning är på. Automatisk visning är avstängd.';
  const choices = l2('camera-web-choices');
  const definitions = data.definitions.filter(
    (item) => item.enabled && item.available,
  );
  const key = JSON.stringify(definitions);
  if (cameraWebChoicesKey !== key) {
    cameraWebChoicesKey = key;
    choices.replaceChildren(
      ...definitions.map((camera) => {
        const button = node(
          'button',
          'button button-quiet',
          `Visa ${camera.name}`,
        );
        button.type = 'button';
        button.addEventListener('click', () => {
          void cameraWebAction('show', camera.id);
        });
        return button;
      }),
    );
  }
  choices.hidden =
    !data.settings.enabled || !data.settings.viewers.includes('web');
  for (const button of choices.children)
    button.disabled =
      cameraWebActionPending || cameraWebActionRequests > 0 || overviewStale;
  if (data.active?.id && cameraWebCloseHoldUntil > cameraWebNow()) {
    cameraWebDismissedIds.add(data.active.id);
    if (cameraWebDismissedIds.size > 32)
      cameraWebDismissedIds.delete(cameraWebDismissedIds.values().next().value);
  }
  const showingPending =
    cameraWebActionPending &&
    cameraWebPendingShow &&
    cameraWebCloseHoldUntil <= cameraWebNow() &&
    data.settings.enabled &&
    data.settings.viewers.includes('web');
  const active =
    data.settings.enabled &&
    data.settings.viewers.includes('web') &&
    cameraWebCloseHoldUntil <= cameraWebNow() &&
    !cameraWebDismissedIds.has(data.active?.id) &&
    data.active?.expiresAt > cameraWebNow()
      ? data.active
      : null;
  l2('camera-web-panel').hidden = !active && !showingPending;
  if (active) {
    l2('camera-web-name').textContent = active.name;
    l2('camera-web-reason').textContent = active.reason || 'Manuellt öppnad';
    l2('camera-web-countdown').textContent =
      `${Math.max(0, Math.ceil((active.expiresAt - cameraWebNow()) / 1000))} s`;
    l2('camera-web-image').alt = `${active.name}, senast hämtade kamerabild`;
  }
  const keyActive = active ? `${active.id}|${active.imageUrl ?? ''}` : null;
  if (!active || !cameraWebCanRun(cameraWebMediaEpoch)) {
    if (cameraWebMediaKey) stopCameraWebMedia();
    if (showingPending && !active) {
      l2('camera-web-name').textContent =
        definitions.find((item) => item.id === cameraWebPendingShow)?.name ||
        'Kamera';
      l2('camera-web-reason').textContent = 'Väntar på servern';
      l2('camera-web-countdown').textContent = '';
      l2('camera-web-placeholder').hidden = false;
      l2('camera-web-placeholder').textContent = 'Öppnar kameravyn …';
      l2('camera-web-media-status').textContent =
        'Du kan stänga vyn medan den öppnas.';
    }
    if (active && overviewStale)
      l2('camera-web-media-status').textContent =
        'Kontakten med Lugn bröts. Kameran har stoppats.';
  } else if (cameraWebMediaKey !== keyActive) startCameraWebMedia(active);
  updateCameraWebControls();
}
async function cameraWebRequest(path, method, body) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${API_ROOT}/cameras/${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'X-Lugn-CSRF': csrfToken },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409)
        throw new Error(
          'Ändrat på annat håll eller inte tillgängligt. Ditt utkast finns kvar. Kasta utkastet för att hämta de sparade inställningarna.',
        );
      if (response.status === 401 || response.status === 403)
        throw new Error(
          'Sessionen saknar åtkomst. Logga in igen. Ditt utkast finns kvar.',
        );
      throw new Error(
        'Kameran eller servern är inte tillgänglig. Försök igen.',
      );
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError)
      throw new Error(
        'Servern svarar inte. Utfallet är okänt; kontrollera anslutningen innan du försöker igen.',
      );
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
async function cameraWebAction(action, cameraId) {
  if (
    !csrfToken ||
    (action === 'show' &&
      (cameraWebActionPending || cameraWebActionRequests > 0 || overviewStale))
  )
    return;
  cameraWebActionRequests += 1;
  const operation = ++cameraWebActionEpoch;
  if (action === 'hide') {
    cameraWebCloseHoldUntil = cameraWebNow() + 60000;
    if (overview?.cameraDashboard?.active?.id)
      cameraWebDismissedIds.add(overview.cameraDashboard.active.id);
    cameraWebPendingShow = null;
    stopCameraWebMedia();
    l2('camera-web-panel').hidden = true;
    l2('camera-web-choices').children[0]?.focus?.();
  } else {
    cameraWebCloseHoldUntil = 0;
    cameraWebDismissedIds.clear();
    cameraWebPendingShow = cameraId;
  }
  cameraWebActionPending = true;
  renderCameraWeb();
  try {
    const result = await cameraWebRequest('action', 'POST', {
      action,
      ...(cameraId ? { cameraId } : {}),
    });
    if (operation !== cameraWebActionEpoch) {
      if (action === 'show' && cameraWebCloseHoldUntil > cameraWebNow()) {
        await cameraWebRequest('action', 'POST', { action: 'hide' });
      }
      return;
    }
    if (result.cameraDashboard && overview)
      overview.cameraDashboard = result.cameraDashboard;
  } catch (error) {
    if (operation === cameraWebActionEpoch)
      setActionMessage(error.message, 'bad');
  } finally {
    cameraWebActionRequests -= 1;
    if (operation === cameraWebActionEpoch) {
      cameraWebActionPending = false;
      cameraWebPendingShow = null;
    }
    renderCameraWeb();
  }
}
function initializeCameraWeb() {
  if (!l2('camera-form')) return;
  l2('camera-enabled').addEventListener('change', () => {
    if (cameraWebDraft) cameraWebDraft.enabled = l2('camera-enabled').checked;
    updateCameraWebControls();
  });
  l2('camera-automatic').addEventListener('change', () => {
    if (cameraWebDraft)
      cameraWebDraft.automaticEnabled = l2('camera-automatic').checked;
    updateCameraWebControls();
  });
  l2('camera-duration').addEventListener('input', () => {
    if (cameraWebDraft)
      cameraWebDraft.durationSeconds = Number(l2('camera-duration').value);
    updateCameraWebControls();
  });
  l2('camera-discard').addEventListener('click', async () => {
    try {
      await fetchOverview();
      fillCameraWebSettings(overview.cameraDashboard);
      l2('camera-settings-status').textContent = 'Utkastet är borttaget.';
      renderCameraWeb();
    } catch {
      l2('camera-settings-status').textContent =
        'De sparade inställningarna kunde inte hämtas. Utkastet finns kvar.';
    }
  });
  l2('camera-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (
      !cameraWebDirty() ||
      cameraWebBusy ||
      !l2('camera-form').checkValidity()
    )
      return;
    cameraWebBusy = true;
    updateCameraWebControls();
    const status = l2('camera-settings-status');
    status.textContent = 'Sparar kamerainställningar …';
    status.dataset.tone = 'neutral';
    try {
      const result = await cameraWebRequest('settings', 'PUT', {
        generation: cameraWebGeneration,
        settings: structuredClone(cameraWebDraft),
      });
      if (
        !result.cameraDashboard?.settings ||
        typeof result.cameraDashboard.generation !== 'string'
      )
        throw new Error(
          'Servern kunde inte bekräfta inställningarna. Utkastet finns kvar.',
        );
      overview.cameraDashboard = result.cameraDashboard;
      fillCameraWebSettings(result.cameraDashboard);
      status.textContent = 'Kamerainställningarna är sparade.';
    } catch (error) {
      status.textContent = error.message;
      status.dataset.tone = 'bad';
    } finally {
      cameraWebBusy = false;
      renderCameraWeb();
    }
  });
  l2('camera-web-close').addEventListener('click', () => {
    void cameraWebAction('hide');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopCameraWebMedia();
    else renderCameraWeb();
  });
  window.addEventListener('pagehide', stopCameraWebMedia);
  window.addEventListener('beforeunload', (event) => {
    if (cameraWebDirty() || cameraWebBusy) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.setInterval(() => {
    if (overview?.cameraDashboard?.active) renderCameraWeb();
  }, 1000);
}
