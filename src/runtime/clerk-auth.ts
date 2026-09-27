import { verifyToken } from '@clerk/backend';

const PUBLISHABLE_KEY_PATTERN = /^pk_(?:test|live)_([A-Za-z0-9_-]+={0,2})$/;

/** Returns the HTTPS Frontend API origin encoded in a Clerk publishable key. */
export function clerkFrontendApiOrigin(publishableKey: string): string {
  const match = PUBLISHABLE_KEY_PATTERN.exec(publishableKey);
  const encodedDomain = match?.[1]?.replace(/=+$/, '');
  if (!encodedDomain) throw new Error('Invalid Clerk publishable key');

  const decodedBytes = Buffer.from(encodedDomain, 'base64url');
  if (decodedBytes.toString('base64url') !== encodedDomain)
    throw new Error('Invalid Clerk publishable key');

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes);
  } catch {
    throw new Error('Invalid Clerk publishable key');
  }
  if (!decoded.endsWith('$') || decoded.slice(0, -1).includes('$'))
    throw new Error('Invalid Clerk publishable key');

  const hostname = decoded.slice(0, -1);
  if (
    hostname.length > 253 ||
    hostname !== hostname.toLowerCase() ||
    !hostname.includes('.') ||
    hostname
      .split('.')
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      )
  ) {
    throw new Error('Invalid Clerk Frontend API domain');
  }

  const origin = new URL(`https://${hostname}`);
  if (origin.hostname !== hostname || origin.port !== '')
    throw new Error('Invalid Clerk Frontend API domain');
  return origin.origin;
}

/** Verifies a Clerk session JWT and checks its subject against the configured policy. */
export async function verifyClerkSessionToken(
  sessionToken: string,
  options: {
    secretKey: string;
    allowedUserIds: readonly string[];
    allowAnyUser: boolean;
    authorizedParty: string;
  },
): Promise<ClerkSessionVerification> {
  try {
    const payload = await verifyToken(sessionToken, {
      secretKey: options.secretKey,
      authorizedParties: [options.authorizedParty],
      headerType: 'JWT',
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      payload.sid.length === 0 ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp * 1000 <= Date.now() ||
      payload.sts === 'pending'
    ) {
      return { status: 'invalid' };
    }

    return {
      status:
        options.allowAnyUser || options.allowedUserIds.includes(payload.sub)
        ? 'authorized'
        : 'forbidden',
      sid: payload.sid,
      exp: payload.exp,
    };
  } catch {
    return { status: 'invalid' };
  }
}

type ClerkSessionVerification =
  | { status: 'invalid' }
  | { status: 'authorized' | 'forbidden'; sid: string; exp: number };
