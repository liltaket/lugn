import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { systemClock, type Clock } from '../core/clock.js';
import {
  AllDeviceScopes,
  DeviceIdSchema,
  DevicePlatformSchema,
  DeviceScopeSchema,
  PairRequestSchema,
  type DeviceScope,
  type DeviceSummary,
  type PairingCodeResponse,
  type PairResponse,
  DEVICE_API_VERSION,
} from '../core/device-api.js';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_DEVICES = 32;
const MAX_PENDING_CODES = 4;
const MAX_FAILED_PAIRING_ATTEMPTS = 10;
const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
const TOKEN_PREFIX = 'lgn1';
// Crockford base32 without I, L, O and U, so a code survives being read aloud.
const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEVICE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const StoredDeviceSchema = z
  .object({
    id: DeviceIdSchema,
    name: z.string().min(1).max(64),
    platform: DevicePlatformSchema,
    appVersion: z.string().max(32).nullable(),
    scopes: z.array(DeviceScopeSchema),
    /** Hex SHA-256 of the 32-byte random secret; the secret itself is never stored. */
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative(),
    revokedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
type StoredDevice = z.infer<typeof StoredDeviceSchema>;
const RegistryFileSchema = z
  .object({
    version: z.literal(1),
    devices: z.array(StoredDeviceSchema).max(MAX_DEVICES),
  })
  .strict();

export class DeviceRegistryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'DeviceRegistryError';
  }
}

export type AuthenticatedDevice = {
  id: string;
  name: string;
  platform: 'ios';
  scopes: readonly DeviceScope[];
};

type PendingCode = {
  code: string;
  scopes: DeviceScope[];
  expiresAt: number;
};

/**
 * Paired native clients and their revocable bearer tokens. Only token digests
 * are persisted, next to the lighting intent, in a private atomically replaced
 * file. Pairing codes are one-time, short-lived and memory-only, so a restart
 * invalidates any code that was not used.
 */
export class DeviceRegistry {
  private devices = new Map<string, StoredDevice>();
  private readonly lastSeen = new Map<string, number>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly listeners = new Set<(event: RegistryEvent) => void>();
  private failedPairingAttempts = 0;
  private loaded = false;
  private writable = true;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly dummyHash = randomBytes(32);

  constructor(
    private readonly filePath: string,
    private readonly options: {
      clock?: Clock;
      onWarning?: (message: string) => void;
    } = {},
  ) {}

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const info = await lstat(this.filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES)
        throw new Error('Invalid device registry file');
      handle = await open(
        this.filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const parsed = RegistryFileSchema.parse(
        JSON.parse(await handle.readFile('utf8')),
      );
      this.devices = new Map(
        parsed.devices.map((device) => [device.id, device]),
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )) {
        // Fail closed: an unreadable registry authenticates nobody and is
        // never overwritten, so a repaired file is not lost.
        this.writable = false;
        this.devices.clear();
        this.options.onWarning?.(
          'Paired device registry could not be read; device access is disabled and pairing is blocked.',
        );
      }
    } finally {
      await handle?.close();
      this.loaded = true;
    }
  }

  subscribe(listener: (event: RegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): DeviceSummary[] {
    return [...this.devices.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((device) => ({
        id: device.id,
        name: device.name,
        platform: device.platform,
        appVersion: device.appVersion,
        scopes: [...device.scopes],
        createdAt: device.createdAt,
        lastSeenAt: this.lastSeen.get(device.id) ?? null,
        revokedAt: device.revokedAt,
      }));
  }

  /** Operator action from the authenticated control panel or loopback API. */
  createPairingCode(
    input: {
      scopes?: DeviceScope[] | undefined;
      ttlSeconds?: number | undefined;
    } = {},
  ): PairingCodeResponse {
    this.assertWritable();
    this.pruneCodes();
    if (this.activeDeviceCount() >= MAX_DEVICES)
      throw new DeviceRegistryError(409, 'device_limit_reached');
    if (this.codes.size >= MAX_PENDING_CODES)
      throw new DeviceRegistryError(429, 'too_many_pairing_codes');
    const scopes = input.scopes
      ? [...new Set(input.scopes)]
      : [...AllDeviceScopes];
    let code: string;
    do code = randomString(PAIRING_ALPHABET, 8);
    while (this.codes.has(code));
    const expiresAt =
      this.clock.now() +
      (input.ttlSeconds === undefined
        ? DEFAULT_PAIRING_TTL_MS
        : input.ttlSeconds * 1000);
    this.codes.set(code, { code, scopes, expiresAt });
    // A new code resets the brute-force budget for the codes it supersedes.
    this.failedPairingAttempts = 0;
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt, scopes };
  }

  /** Exchanges a one-time code for a device identity and its only token copy. */
  pair(rawInput: unknown): Promise<PairResponse> {
    const input = PairRequestSchema.parse(rawInput);
    const operation = this.pending.then(async () => {
      this.assertWritable();
      this.pruneCodes();
      const normalized = input.code.replace('-', '').toUpperCase();
      const pending = this.codes.get(normalized);
      if (!pending) {
        this.failedPairingAttempts += 1;
        // Too many guesses invalidate every outstanding code.
        if (this.failedPairingAttempts >= MAX_FAILED_PAIRING_ATTEMPTS)
          this.codes.clear();
        throw new DeviceRegistryError(401, 'invalid_pairing_code');
      }
      this.codes.delete(normalized);
      if (this.activeDeviceCount() >= MAX_DEVICES)
        throw new DeviceRegistryError(409, 'device_limit_reached');
      let id: string;
      do id = `dev_${randomString(DEVICE_ID_ALPHABET, 16)}`;
      while (this.devices.has(id));
      const secret = randomBytes(32).toString('base64url');
      const now = this.clock.now();
      const device: StoredDevice = {
        id,
        name: input.name,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        scopes: pending.scopes,
        tokenHash: digest(secret).toString('hex'),
        createdAt: now,
        revokedAt: null,
      };
      const next = new Map(this.devices);
      next.set(id, device);
      await this.persist(next);
      this.devices = next;
      this.emit({ type: 'paired', deviceId: id });
      return {
        apiVersion: DEVICE_API_VERSION,
        deviceId: id,
        token: `${TOKEN_PREFIX}.${id}.${secret}`,
        tokenType: 'Bearer' as const,
        scopes: [...device.scopes],
        issuedAt: now,
      };
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  revoke(deviceId: string): Promise<DeviceSummary> {
    const operation = this.pending.then(async () => {
      this.assertWritable();
      const device = this.devices.get(deviceId);
      if (!device) throw new DeviceRegistryError(404, 'device_not_found');
      if (device.revokedAt === null) {
        const next = new Map(this.devices);
        next.set(deviceId, { ...device, revokedAt: this.clock.now() });
        await this.persist(next);
        this.devices = next;
      }
      this.emit({ type: 'revoked', deviceId });
      return this.list().find((entry) => entry.id === deviceId)!;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  /**
   * Resolves a bearer token in constant time with respect to the secret. An
   * unknown or revoked device still performs one digest comparison.
   */
  authenticate(token: string): AuthenticatedDevice | undefined {
    const match = /^lgn1\.(dev_[a-z2-7]{16})\.([A-Za-z0-9_-]{43})$/.exec(token);
    const device = match ? this.devices.get(match[1]!) : undefined;
    const expected = device
      ? Buffer.from(device.tokenHash, 'hex')
      : this.dummyHash;
    const provided = digest(match?.[2] ?? token);
    const equal = timingSafeEqual(provided, expected);
    if (!equal || !device || device.revokedAt !== null) return undefined;
    this.lastSeen.set(device.id, this.clock.now());
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      scopes: [...device.scopes],
    };
  }

  /** Whether a device is still paired and not revoked; used to end live streams. */
  isActive(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    return device !== undefined && device.revokedAt === null;
  }

  private activeDeviceCount(): number {
    return [...this.devices.values()].filter((d) => d.revokedAt === null)
      .length;
  }

  private pruneCodes(): void {
    const now = this.clock.now();
    for (const [code, pending] of this.codes)
      if (pending.expiresAt <= now) this.codes.delete(code);
  }

  private assertWritable(): void {
    if (!this.loaded || !this.writable)
      throw new DeviceRegistryError(503, 'device_registry_unavailable');
  }

  private emit(event: RegistryEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async persist(devices: Map<string, StoredDevice>): Promise<void> {
    const text =
      JSON.stringify(
        RegistryFileSchema.parse({
          version: 1,
          devices: [...devices.values()],
        }),
      ) + '\n';
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Invalid directory');
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
    } catch {
      throw new DeviceRegistryError(503, 'device_registry_save_failed');
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export type RegistryEvent =
  { type: 'paired'; deviceId: string } | { type: 'revoked'; deviceId: string };

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Unbiased selection: the alphabets used here have 32 symbols. */
function randomString(alphabet: string, length: number): string {
  if (alphabet.length !== 32) throw new Error('Alphabet must have 32 symbols');
  const bytes = randomBytes(length);
  let result = '';
  for (const byte of bytes) result += alphabet[byte & 31];
  return result;
}
