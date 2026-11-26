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
import { parseBinaryPlist, plistNumbers, type PlistValue } from './bplist.js';

export type AlbumPhotoDetails = {
  /** Original file name, e.g. `IMG_9347.HEIC`. */
  filename: string | null;
  /** A caption or description somebody wrote in Photos. */
  caption: string | null;
  keywords: string[];
  favorite: boolean;
  /** Apple's asset subtype flags: 1 panorama, 2 HDR, 4 screenshot, 8 live, 16 depth. */
  subtype: number;
  burst: boolean;
  /** When the picture was added to the album, ms since the epoch. */
  addedAt: number | null;
  /** Pictures added in one go share a batch. */
  batch: string | null;
  /** The camera, e.g. `iPhone 14 Pro Max`. */
  device: string | null;
  lens: 'front' | 'ultrawide' | 'wide' | 'tele' | null;
  /** ISO speed, exposure brightness value (EV, dark is negative) and flash fired. */
  iso: number | null;
  brightness: number | null;
  flash: boolean | null;
  /** Metres above sea level, compass heading in degrees, speed in m/s. */
  altitude: number | null;
  heading: number | null;
  speed: number | null;
  /** How many faces the phone itself found. */
  deviceFaces: number;
};
/** One downloadable version of a picture. */
export type AlbumRendition = {
  /** `jpeg`: the browser rendition (1536 × 2048 at most); `original`: full size. */
  kind: 'jpeg' | 'original';
  url: string;
  width: number;
  height: number;
  /** Apple's file type, e.g. `public.heic`; absent when not stated. */
  type?: string;
};
export type AlbumPhoto = {
  /** Stable CPLAsset record name. */
  id: string;
  /** Upright JPEG rendition Apple serves for the browser. */
  url: string;
  width: number;
  height: number;
  /** Every version offered, for the machine that analyses the pictures at full size. */
  renditions?: AlbumRendition[];
  /** Capture time, ms since the epoch, if the record carries one. */
  takenAt: number | null;
  /** Apple's fingerprint of the rendition; changes when the picture is edited. */
  version: string;
  /** Seconds east of UTC at the place the photo was taken. */
  utcOffsetSeconds: number;
  latitude: number | null;
  longitude: number | null;
  /** What the record says beyond time and place; absent when it could not be read. */
  details?: AlbumPhotoDetails;
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
// A shared album holds at most about 5000 pictures; each is a CPLAsset plus a
// CPLMaster record, 200 records to a page.
const MAX_PAGES = 60;
const REQUEST_TIMEOUT_MS = 20_000;
const PARTITION_HOST = /^p\d{1,3}-ckdatabasews\.icloud\.com$/;
const DOWNLOAD_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.icloud-content\.com$/;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['public.jpeg', 'public.png']);
const ORIGINAL_TYPES = new Set([
  'public.jpeg',
  'public.png',
  'public.heic',
  'public.heif',
]);
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
 * doubles. Only its numbers are read; anything else yields an empty map.
 */
export function parseBinaryPlistReals(data: Buffer): Map<string, number> {
  return plistNumbers(data, 4096);
}

const text = (input: unknown): string | null => {
  if (typeof input !== 'string' || input === '') return null;
  const bytes = Buffer.from(input, 'base64');
  if (bytes.length === 0 || bytes.length > 8192) return null;
  // Text fields are UTF-8, or a property list holding the string.
  const parsed = parseBinaryPlist(bytes, { maxBytes: 8192, maxDepth: 2 });
  const raw = typeof parsed === 'string' ? parsed : bytes.toString('utf8');
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean === '' ? null : clean.slice(0, 300);
};

const dict = (input: PlistValue | undefined): Record<string, PlistValue> =>
  input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, PlistValue>)
    : {};
const numeric = (input: PlistValue | undefined): number | null =>
  typeof input === 'number' && Number.isFinite(input) ? input : null;

function lensOf(
  model: unknown,
  equivalent: number | null,
): AlbumPhotoDetails['lens'] {
  if (typeof model === 'string' && /front/i.test(model)) return 'front';
  if (equivalent === null || equivalent <= 0) return null;
  if (equivalent < 20) return 'ultrawide';
  if (equivalent > 45) return 'tele';
  return 'wide';
}

/**
 * Everything beyond time and place that an album record says about a picture:
 * the phone's own image properties (camera, lens, exposure, compass heading,
 * altitude), what somebody wrote or marked in Photos, and how many faces the
 * phone found.
 */
export function extractDetails(
  asset: CloudRecord,
  master: CloudRecord,
): AlbumPhotoDetails {
  const blob = value(master, 'mediaMetaDataEnc');
  const properties = dict(
    typeof blob === 'string'
      ? parseBinaryPlist(Buffer.from(blob, 'base64'), {
          maxBytes: 64 * 1024,
          maxDepth: 6,
        })
      : undefined,
  );
  const tiff = dict(properties['{TIFF}']);
  const exif = dict(properties['{Exif}']);
  const gps = dict(properties['{GPS}']);
  const regions = dict(dict(properties['{ExifAux}'])['Regions']);
  const faceList = regions['RegionList'];
  const keywords = parseBinaryPlist(
    Buffer.from(String(value(asset, 'keywordsEnc') ?? ''), 'base64'),
    { maxBytes: 8192, maxDepth: 2 },
  );
  const iso = Array.isArray(exif['ISOSpeedRatings'])
    ? numeric(exif['ISOSpeedRatings'][0])
    : null;
  const flash = numeric(exif['Flash']);
  const device = typeof tiff['Model'] === 'string' ? tiff['Model'].trim() : '';
  const altitude = numeric(gps['Altitude']);
  const below = numeric(gps['AltitudeRef']) === 1;
  const subtype = num(value(asset, 'assetSubtypeV2'));
  return {
    filename: text(value(master, 'filenameEnc')),
    caption:
      text(value(asset, 'captionEnc')) ?? text(value(asset, 'extendedDescEnc')),
    keywords: Array.isArray(keywords)
      ? keywords.filter((k): k is string => typeof k === 'string').slice(0, 20)
      : [],
    favorite: num(value(asset, 'isFavorite')) === 1,
    subtype,
    burst: num(value(asset, 'burstFlags')) > 0,
    addedAt: num(value(asset, 'addedDate')) || null,
    batch: String(value(asset, 'assetBatchId') ?? '') || null,
    device: device === '' ? null : device.slice(0, 60),
    lens: lensOf(exif['LensModel'], numeric(exif['FocalLenIn35mmFilm'])),
    iso,
    brightness: numeric(exif['BrightnessValue']),
    flash: flash === null ? null : (flash & 1) === 1,
    altitude: altitude === null ? null : below ? -altitude : altitude,
    heading: numeric(gps['ImgDirection']),
    speed: numeric(gps['Speed']),
    deviceFaces: Array.isArray(faceList) ? Math.min(faceList.length, 20) : 0,
  };
}

function downloadUrl(resource: unknown): string | null {
  const download = (resource as { downloadURL?: unknown } | undefined)
    ?.downloadURL;
  if (typeof download !== 'string') return null;
  const url = download.replace('${f}', 'photo.jpg');
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      (parsed.port !== '' && parsed.port !== '443') ||
      parsed.username !== '' ||
      !DOWNLOAD_HOST.test(parsed.hostname)
    )
      return null;
  } catch {
    return null;
  }
  return url;
}

function pickRendition(
  asset: CloudRecord | undefined,
  master: CloudRecord,
): { url: string; width: number; height: number; version: string } | null {
  const records = { asset, master };
  for (const [on, prefix] of RENDITIONS) {
    const record = records[on];
    const url = downloadUrl(value(record, `${prefix}Res`));
    if (url === null) continue;
    const type = value(record, `${prefix}FileType`);
    if (type !== undefined && !IMAGE_TYPES.has(String(type))) continue;
    const width = num(value(record, `${prefix}Width`));
    const height = num(value(record, `${prefix}Height`));
    if (width <= 0 || height <= 0) continue;
    return {
      url,
      width,
      height,
      version: String(value(record, `${prefix}Fingerprint`) ?? ''),
    };
  }
  return null;
}

/**
 * The full-size picture, when Apple offers it: the asset's own full rendition
 * (upright, edits applied), else the master's original. HEIC for iPhone
 * pictures. Only the machine that analyses pictures at full size asks for it.
 */
function pickOriginal(
  asset: CloudRecord | undefined,
  master: CloudRecord,
): AlbumRendition | null {
  const candidates: Array<[CloudRecord | undefined, string]> = [
    [asset, 'resJPEGFull'],
    [master, 'resOriginal'],
  ];
  for (const [record, prefix] of candidates) {
    const url = downloadUrl(value(record, `${prefix}Res`));
    if (url === null) continue;
    const type = String(value(record, `${prefix}FileType`) ?? '');
    if (type !== '' && !ORIGINAL_TYPES.has(type)) continue;
    const width = num(value(record, `${prefix}Width`));
    const height = num(value(record, `${prefix}Height`));
    if (width <= 0 || height <= 0) continue;
    return {
      kind: 'original',
      url,
      width,
      height,
      ...(type === '' ? {} : { type }),
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
    const original = pickOriginal(asset, master);
    photos.push({
      id,
      ...rendition,
      renditions: [
        {
          kind: 'jpeg',
          url: rendition.url,
          width: rendition.width,
          height: rendition.height,
        },
        ...(original ? [original] : []),
      ],
      takenAt: date > 0 ? date : null,
      utcOffsetSeconds: num(value(asset, 'timeZoneOffset')),
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      details: extractDetails(asset, master),
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
