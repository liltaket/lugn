/**
 * Anonymous read of an iCloud shared album that has its public link turned on
 * (Photos → album → people → public website). Apple publishes no API for
 * this; the web page itself reads the album in the three steps mirrored here:
 *
 *   records/resolve  → short-lived anonymous token, database partition, zone
 *   records/query    → CPLAsset + CPLMaster records with signed JPEG URLs
 *
 * Only the CloudKit form of the link (`photos.icloud.com/shared/album/<id>`)
 * is read. The older `sharedalbum/#B…` streams are rejected with a clear
 * error. Every host Apple names in a response is checked before it is used.
 */
export type AlbumPhoto = {
  /** Stable CPLAsset record name. */
  id: string;
  /** Upright JPEG rendition Apple serves for the browser. */
  url: string;
  width: number;
  height: number;
  /** Capture time, ms since the epoch, if the record carries one. */
  takenAt: number | null;
  /** Apple's fingerprint of the rendition; changes when the picture is edited. */
  version: string;
  /** Seconds east of UTC at the place the photo was taken. */
  utcOffsetSeconds: number;
  latitude: number | null;
  longitude: number | null;
};
export type AlbumListing = {
  title: string;
  photos: AlbumPhoto[];
  /** More pages were announced than are read; the newest pictures may be missing. */
  truncated: boolean;
};

export class AlbumError extends Error {
  constructor(
    readonly code:
      | 'unsupported_link'
      | 'not_found'
      | 'not_public'
      | 'refused'
      | 'unexpected_response'
      | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'AlbumError';
  }
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Apple's hosts are checked before use, so a redirect to anywhere else is an error. */
    redirect?: 'error';
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
}>;

const RESOLVE_URL =
  'https://p01-ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production/public/records/resolve';
const DATABASE_PATH = '/database/1/com.apple.photos.cloud/production/shared/';
const QUERY_TYPE = 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted';
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 20_000;
const PARTITION_HOST = /^p\d{1,3}-ckdatabasews\.icloud\.com$/;
const DOWNLOAD_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.icloud-content\.com$/;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['public.jpeg', 'public.png']);
const RENDITIONS: ReadonlyArray<readonly ['asset' | 'master', string]> = [
  ['asset', 'resJPEGMed'],
  ['master', 'resJPEGMed'],
  ['asset', 'resJPEGFull'],
  ['master', 'resJPEGFull'],
];

/** The short album id from any of Apple's CloudKit-style public links. */
export function parseAlbumToken(link: string): string {
  const trimmed = link.trim();
  const patterns = [
    /^https:\/\/photos\.icloud\.com\/shared\/album\/([A-Za-z0-9_-]{8,64})\/?(?:[?#].*)?$/,
    /^https:\/\/share\.icloud\.com\/photos\/([A-Za-z0-9_-]{8,64})\/?(?:[?#].*)?$/,
    /^https:\/\/www\.icloud\.com\/photos\/#([A-Za-z0-9_-]{8,64})$/,
  ];
  for (const pattern of patterns) {
    const token = pattern.exec(trimmed)?.[1];
    if (token) return token;
  }
  if (/^https:\/\/www\.icloud\.com\/sharedalbum\/#/.test(trimmed))
    throw new AlbumError(
      'unsupported_link',
      'This is a legacy shared-album link; use the photos.icloud.com/shared/album link of an upgraded album.',
    );
  throw new AlbumError(
    'unsupported_link',
    'Unrecognised iCloud shared-album link.',
  );
}

type CloudRecord = {
  recordName?: string;
  recordType?: string;
  serverErrorCode?: string;
  fields?: Record<string, { value?: unknown } | undefined>;
};
const value = (record: CloudRecord | undefined, field: string): unknown =>
  record?.fields?.[field]?.value;
const num = (input: unknown): number =>
  typeof input === 'number' && Number.isFinite(input) ? input : 0;

/** The body of a response, read with a running byte cap; throws past it. */
export async function readCapped(
  response: Awaited<ReturnType<FetchLike>>,
  maxBytes: number,
): Promise<Uint8Array> {
  const announced = Number(response.headers.get('content-length') ?? 0);
  if (announced > maxBytes) throw new Error('response too large');
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('response too large');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function post(
  fetcher: FetchLike,
  url: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  let response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'text/plain' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw new AlbumError('unavailable', 'iCloud did not answer.');
  }
  let json: unknown = null;
  try {
    json = JSON.parse(
      new TextDecoder().decode(await readCapped(response, MAX_JSON_BYTES)),
    );
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/** Binary property list the album stores a photo's location in (base64). */
function decodeLocation(
  encoded: unknown,
): { latitude: number; longitude: number } | null {
  if (typeof encoded !== 'string') return null;
  const parsed = parseBinaryPlistReals(Buffer.from(encoded, 'base64'));
  const latitude = parsed.get('lat');
  const longitude = parsed.get('lon');
  if (
    latitude === undefined ||
    longitude === undefined ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    (latitude === 0 && longitude === 0)
  )
    return null;
  return { latitude, longitude };
}

/**
 * The location blob is a tiny `bplist00` dictionary of short ASCII keys and
 * doubles. Only that shape is read; anything else yields an empty map.
 */
export function parseBinaryPlistReals(data: Buffer): Map<string, number> {
  const out = new Map<string, number>();
  // Every read is checked against the buffer, and the dictionary size against
  // the object count, so a hostile blob ends in a thrown error, never a loop.
  const byte = (at: number): number => {
    if (!Number.isInteger(at) || at < 0 || at >= data.length)
      throw new RangeError('bplist out of range');
    return data[at]!;
  };
  const readUInt = (at: number, size: number): number => {
    if (size < 1 || size > 4) throw new RangeError('bplist integer size');
    let n = 0;
    for (let i = 0; i < size; i += 1) n = n * 256 + byte(at + i);
    return n;
  };
  try {
    if (
      data.length < 40 ||
      data.length > 4096 ||
      data.subarray(0, 8).toString('latin1') !== 'bplist00'
    )
      return out;
    const trailer = data.subarray(data.length - 32);
    const offsetSize = trailer[6]!;
    const refSize = trailer[7]!;
    const objectCount = Number(trailer.readBigUInt64BE(8));
    const topObject = Number(trailer.readBigUInt64BE(16));
    const tableOffset = Number(trailer.readBigUInt64BE(24));
    if (
      objectCount < 1 ||
      objectCount > 64 ||
      topObject >= objectCount ||
      offsetSize < 1 ||
      offsetSize > 4 ||
      refSize < 1 ||
      refSize > 2 ||
      tableOffset + objectCount * offsetSize > data.length - 32
    )
      return out;
    const offsetOf = (index: number): number => {
      if (index < 0 || index >= objectCount)
        throw new RangeError('bplist object index');
      return readUInt(tableOffset + index * offsetSize, offsetSize);
    };
    const lengthAndStart = (at: number): { length: number; start: number } => {
      const nibble = byte(at) & 0x0f;
      if (nibble !== 0x0f) return { length: nibble, start: at + 1 };
      const sizeLog = byte(at + 1) & 0x0f;
      if (sizeLog > 2) throw new RangeError('bplist length size');
      const sizeBytes = 1 << sizeLog;
      return {
        length: readUInt(at + 2, sizeBytes),
        start: at + 2 + sizeBytes,
      };
    };
    const top = offsetOf(topObject);
    if ((byte(top) & 0xf0) !== 0xd0) return out;
    const { length: count, start } = lengthAndStart(top);
    if (count > objectCount) return out;
    for (let i = 0; i < count; i += 1) {
      const keyAt = offsetOf(readUInt(start + i * refSize, refSize));
      const valueAt = offsetOf(
        readUInt(start + (count + i) * refSize, refSize),
      );
      if ((byte(keyAt) & 0xf0) !== 0x50) continue;
      const key = lengthAndStart(keyAt);
      if (key.length > 32 || key.start + key.length > data.length) continue;
      const name = data
        .subarray(key.start, key.start + key.length)
        .toString('latin1');
      const marker = byte(valueAt);
      if (marker === 0x23 && valueAt + 9 <= data.length)
        out.set(name, data.readDoubleBE(valueAt + 1));
      else if (marker === 0x22 && valueAt + 5 <= data.length)
        out.set(name, data.readFloatBE(valueAt + 1));
    }
  } catch {
    out.clear();
  }
  return out;
}

function pickRendition(
  asset: CloudRecord | undefined,
  master: CloudRecord,
): { url: string; width: number; height: number; version: string } | null {
  const records = { asset, master };
  for (const [on, prefix] of RENDITIONS) {
    const record = records[on];
    const resource = value(record, `${prefix}Res`) as
      { downloadURL?: unknown } | undefined;
    if (typeof resource?.downloadURL !== 'string') continue;
    const type = value(record, `${prefix}FileType`);
    if (type !== undefined && !IMAGE_TYPES.has(String(type))) continue;
    const width = num(value(record, `${prefix}Width`));
    const height = num(value(record, `${prefix}Height`));
    if (width <= 0 || height <= 0) continue;
    const url = resource.downloadURL.replace('${f}', 'photo.jpg');
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol !== 'https:' ||
        (parsed.port !== '' && parsed.port !== '443') ||
        parsed.username !== '' ||
        !DOWNLOAD_HOST.test(parsed.hostname)
      )
        continue;
    } catch {
      continue;
    }
    return {
      url,
      width,
      height,
      version: String(value(record, `${prefix}Fingerprint`) ?? ''),
    };
  }
  return null;
}

const isVideo = (master: CloudRecord): boolean => {
  const type = String(value(master, 'itemType') ?? '').toLowerCase();
  return /movie|video|mpeg|avi|3gpp/.test(type);
};

export async function readSharedAlbum(
  link: string,
  fetcher: FetchLike,
): Promise<AlbumListing> {
  const token = parseAlbumToken(link);
  const resolved = await post(fetcher, RESOLVE_URL, {
    shortGUIDs: [{ value: token, shouldFetchRootRecord: true }],
  });
  const item = (
    resolved.json as { results?: Array<Record<string, unknown>> } | null
  )?.results?.[0];
  if (resolved.status >= 400 || !item)
    throw new AlbumError(
      'unexpected_response',
      'iCloud could not look up the album.',
    );
  if (item['serverErrorCode'] === 'NOT_FOUND')
    throw new AlbumError('not_found', 'iCloud does not know this album link.');
  if (item['serverErrorCode'])
    throw new AlbumError('refused', 'iCloud refused the album link.');
  const access = item['anonymousPublicAccess'] as
    { token?: unknown; databasePartition?: unknown } | undefined;
  if (
    item['requireAppleLogin'] ||
    item['minimallyResolved'] ||
    typeof access?.token !== 'string'
  )
    throw new AlbumError('not_public', 'The album has no public link.');
  const zone = item['zoneID'] as { zoneName?: unknown } | undefined;
  if (item['databaseScope'] !== 'SHARED' || typeof zone?.zoneName !== 'string')
    throw new AlbumError(
      'unexpected_response',
      'Unexpected album description.',
    );
  let partition: URL;
  try {
    partition = new URL(
      typeof access.databasePartition === 'string'
        ? access.databasePartition
        : 'https://p01-ckdatabasews.icloud.com:443',
    );
  } catch {
    throw new AlbumError('unexpected_response', 'Unexpected album partition.');
  }
  if (
    partition.protocol !== 'https:' ||
    (partition.port !== '' && partition.port !== '443') ||
    !PARTITION_HOST.test(partition.hostname)
  )
    throw new AlbumError('unexpected_response', 'Unexpected album partition.');
  const queryUrl = `https://${partition.host}${DATABASE_PATH}records/query?${new URLSearchParams(
    { publicAccessAuthToken: access.token, sharing_url_key: token },
  ).toString()}`;

  const records: CloudRecord[] = [];
  let marker: unknown;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = await post(fetcher, queryUrl, {
      zoneID: item['zoneID'],
      resultsLimit: PAGE_SIZE,
      query: {
        recordType: QUERY_TYPE,
        filterBy: [
          {
            fieldName: 'direction',
            comparator: 'EQUALS',
            fieldValue: { value: 'ASCENDING', type: 'STRING' },
          },
        ],
      },
      ...(marker === undefined ? {} : { continuationMarker: marker }),
    });
    if (answer.status === 401 || answer.status === 403)
      throw new AlbumError('refused', 'iCloud refused anonymous access.');
    const body = answer.json as {
      records?: CloudRecord[];
      continuationMarker?: unknown;
    } | null;
    if (answer.status >= 400 || !Array.isArray(body?.records))
      throw new AlbumError('unexpected_response', 'iCloud query failed.');
    records.push(...body.records);
    marker = body.continuationMarker;
    if (!marker) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  const masters = new Map<string, CloudRecord>();
  for (const record of records)
    if (record.recordType === 'CPLMaster' && !record.serverErrorCode)
      masters.set(String(record.recordName), record);
  const photos: AlbumPhoto[] = [];
  const seen = new Set<string>();
  for (const asset of records) {
    if (asset.recordType !== 'CPLAsset' || asset.serverErrorCode) continue;
    const id = String(asset.recordName ?? '');
    const ref = value(asset, 'masterRef') as
      { recordName?: unknown } | undefined;
    const master = masters.get(String(ref?.recordName));
    if (!id || seen.has(id) || !master || isVideo(master)) continue;
    const rendition = pickRendition(asset, master);
    if (!rendition) continue;
    seen.add(id);
    const date = num(
      value(asset, 'assetDate') ?? value(master, 'originalCreationDate'),
    );
    const location = decodeLocation(value(asset, 'locationEnc'));
    photos.push({
      id,
      ...rendition,
      takenAt: date > 0 ? date : null,
      utcOffsetSeconds: num(value(asset, 'timeZoneOffset')),
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
    });
  }
  const title = (
    (
      item['share'] as
        { fields?: Record<string, { value?: unknown }> } | undefined
    )?.fields?.['cloudkit.title']?.value ?? ''
  ).toString();
  return { title, photos, truncated };
}
