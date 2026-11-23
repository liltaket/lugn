import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  readCapped,
  readSharedAlbum,
  type FetchLike,
} from './icloud-shared-album.js';
import {
  PhotoLibrary,
  type CountryLookup,
  type PhotoProcessor,
  type PlaceLookup,
} from './photo-library.js';
import { PhotoInsight } from './photo-intel/insight.js';

// The sensor shares this machine: one libvips thread, no operation cache.
sharp.concurrency(1);
sharp.cache(false);

/** Largest picture Apple serves for a browser is a few MB; refuse more. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Landscape fills the 1024 px width; portrait keeps a little over the 600 px height. */
const LANDSCAPE_WIDTH = 1024;
const PORTRAIT_HEIGHT = 640;
const MAX_PLACE_DISTANCE_KM = 30;

export type PhotoFrameConfig = {
  albumUrl: string;
  cacheDir: string;
  refreshMinutes: number;
  maxPhotos: number;
  /** Image analysis and smarter grouping; absent means the defaults. */
  intelligence?: {
    enabled: boolean;
    modelsDir?: string;
    home?: { lat: number; lon: number };
  };
};

/** The share of a picture's width and height that counts as one of its corners. */
const CORNER_WIDTH = 0.3;
const CORNER_HEIGHT = 0.25;

/**
 * How bright the picture is in its upper right, lower right and lower left
 * corner, 0–99: where a Hub puts the clock, the name and the music widget, so
 * it can shade each corner as much as that picture needs. Measured once.
 */
export async function measureCorners(
  source: Uint8Array,
): Promise<[number, number, number]> {
  const size = 64;
  const { data } = await sharp(source, {
    failOn: 'error',
    limitInputPixels: 40_000_000,
  })
    .rotate()
    .resize(size, size, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cols = Math.round(size * CORNER_WIDTH);
  const rows = Math.round(size * CORNER_HEIGHT);
  const mean = (left: number, top: number): number => {
    let sum = 0;
    for (let y = top; y < top + rows; y += 1)
      for (let x = left; x < left + cols; x += 1) sum += data[y * size + x]!;
    return Math.round((sum / (cols * rows) / 255) * 99);
  };
  return [
    mean(size - cols, 0),
    mean(size - cols, size - rows),
    mean(0, size - rows),
  ];
}

/** Each picture is scaled once, here, so a Hub never decodes more than it shows. */
export const processPhoto: PhotoProcessor = async (source) => {
  const image = sharp(source, {
    failOn: 'error',
    limitInputPixels: 40_000_000,
  }).rotate();
  const meta = await image.metadata();
  const upright = (meta.orientation ?? 1) >= 5;
  const width = (upright ? meta.height : meta.width) ?? 0;
  const height = (upright ? meta.width : meta.height) ?? 0;
  if (width <= 0 || height <= 0) throw new Error('unreadable image size');
  const landscape = width >= height;
  const main = await image
    .clone()
    .resize(
      landscape
        ? { width: LANDSCAPE_WIDTH, withoutEnlargement: true }
        : { height: PORTRAIT_HEIGHT, withoutEnlargement: true },
    )
    .jpeg({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  // A tiny, already blurred copy; the page scales it up behind a picture that
  // does not fill the screen, so no blur is ever computed on a Hub.
  const backdrop = await image
    .clone()
    .resize(192, 112, { fit: 'cover' })
    .blur(8)
    .jpeg({ quality: 60 })
    .toBuffer();
  return {
    main: main.data,
    backdrop,
    width: main.info.width,
    height: main.info.height,
    corners: await measureCorners(main.data),
  };
};

type PlaceRow = { name: string; lat: number; lon: number; country: string };

export function loadPlaces(path: string): {
  place: PlaceLookup;
  country: CountryLookup;
} {
  const rows: PlaceRow[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [name, lat, lon, country] = line.split('\t');
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (name && Number.isFinite(latitude) && Number.isFinite(longitude))
      rows.push({
        name,
        lat: latitude,
        lon: longitude,
        country: /^[A-Z]{2}$/.test(country?.trim() ?? '')
          ? country!.trim()
          : '',
      });
  }
  const nearest = (latitude: number, longitude: number): PlaceRow | null => {
    const scale = Math.cos((latitude * Math.PI) / 180);
    let best: { row: PlaceRow; distance: number } | null = null;
    for (const row of rows) {
      const dy = (row.lat - latitude) * 111.32;
      const dx = (row.lon - longitude) * 111.32 * scale;
      const distance = Math.hypot(dx, dy);
      if (!best || distance < best.distance) best = { row, distance };
    }
    return best && best.distance <= MAX_PLACE_DISTANCE_KM ? best.row : null;
  };
  return {
    place: (latitude, longitude) => nearest(latitude, longitude)?.name ?? null,
    country: (latitude, longitude) => {
      const near = nearest(latitude, longitude);
      return near ? near.country || null : null;
    },
  };
}

export function loadPlaceLookup(path: string): PlaceLookup {
  return loadPlaces(path).place;
}

function findPlacesFile(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, '../../data/places.tsv'),
    resolve(process.cwd(), 'data/places.tsv'),
  ]) {
    try {
      readFileSync(candidate, { encoding: 'utf8', flag: 'r' }).slice(0, 1);
      return candidate;
    } catch {
      /* try the next */
    }
  }
  return undefined;
}

export function createPhotoFrame(
  config: PhotoFrameConfig,
  options: {
    fetch?: FetchLike;
    warn?: (message: string) => void;
    log?: (message: string) => void;
  } = {},
): PhotoLibrary {
  const fetcher: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init));
  const placesFile = findPlacesFile();
  const places = placesFile
    ? loadPlaces(placesFile)
    : {
        place: () => {
          options.warn?.(
            'photo frame: data/places.tsv not found; no place names',
          );
          return null;
        },
        country: () => null,
      };
  const intelligence = config.intelligence ?? { enabled: true };
  const holder: { library?: PhotoLibrary } = {};
  const insight = new PhotoInsight({
    cacheDir: config.cacheDir,
    modelsDir:
      intelligence.modelsDir ?? join(dirname(config.cacheDir), 'photo-models'),
    enabled: intelligence.enabled,
    ...(intelligence.home ? { home: intelligence.home } : {}),
    readPhoto: async (id) => (await holder.library?.readMain(id)) ?? null,
    ...(options.log ? { log: options.log } : {}),
    ...(options.warn ? { warn: options.warn } : {}),
  });
  const library = new PhotoLibrary({
    insight,
    cacheDir: config.cacheDir,
    refreshMs: config.refreshMinutes * 60_000,
    maxPhotos: config.maxPhotos,
    list: () => readSharedAlbum(config.albumUrl, fetcher),
    download: async (url) => {
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      return readCapped(response, MAX_DOWNLOAD_BYTES);
    },
    process: processPhoto,
    measure: measureCorners,
    pauseMs: 300,
    ...(options.log ? { log: options.log } : {}),
    place: places.place,
    country: places.country,
    ...(options.warn ? { warn: options.warn } : {}),
  });
  holder.library = library;
  return library;
}
