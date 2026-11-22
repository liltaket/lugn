import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  readCapped,
  readSharedAlbum,
  type FetchLike,
} from './icloud-shared-album.js';
import {
  PhotoLibrary,
  type PhotoProcessor,
  type PlaceLookup,
} from './photo-library.js';

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
};

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
  };
};

export function loadPlaceLookup(path: string): PlaceLookup {
  const rows: Array<{ name: string; lat: number; lon: number }> = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [name, lat, lon] = line.split('\t');
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (name && Number.isFinite(latitude) && Number.isFinite(longitude))
      rows.push({ name, lat: latitude, lon: longitude });
  }
  return (latitude, longitude) => {
    const scale = Math.cos((latitude * Math.PI) / 180);
    let best: { name: string; distance: number } | null = null;
    for (const row of rows) {
      const dy = (row.lat - latitude) * 111.32;
      const dx = (row.lon - longitude) * 111.32 * scale;
      const distance = Math.hypot(dx, dy);
      if (!best || distance < best.distance)
        best = { name: row.name, distance };
    }
    return best && best.distance <= MAX_PLACE_DISTANCE_KM ? best.name : null;
  };
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
  const place = placesFile
    ? loadPlaceLookup(placesFile)
    : () => {
        options.warn?.(
          'photo frame: data/places.tsv not found; no place names',
        );
        return null;
      };
  return new PhotoLibrary({
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
    pauseMs: 300,
    ...(options.log ? { log: options.log } : {}),
    place,
    ...(options.warn ? { warn: options.warn } : {}),
  });
}
