/**
 * Downloads the photo analysis models once, checks each against its known
 * SHA-256 and keeps them in one directory. Nothing else in Lugn talks to the
 * internet for this; the models are plain files the analysis loads locally.
 *
 *   npm run photos:models -- [directory]
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MODELS, sha256File, type ModelSpec } from './models.js';

export type Fetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export async function fetchModels(
  directory: string,
  options: {
    fetcher?: Fetcher;
    specs?: readonly ModelSpec[];
    log?: (message: string) => void;
  } = {},
): Promise<{ downloaded: string[]; kept: string[] }> {
  const fetcher: Fetcher =
    options.fetcher ?? ((url) => fetch(url, { redirect: 'follow' }));
  const log = options.log ?? (() => undefined);
  await mkdir(directory, { recursive: true });
  const downloaded: string[] = [];
  const kept: string[] = [];
  for (const spec of options.specs ?? MODELS) {
    const target = join(directory, spec.file);
    try {
      if (
        (await stat(target)).size === spec.bytes &&
        (await sha256File(target)) === spec.sha256
      ) {
        kept.push(spec.file);
        log(`${spec.file}: already there`);
        continue;
      }
    } catch {
      /* not there yet */
    }
    log(
      `${spec.file}: downloading (${Math.round(spec.bytes / 1e6)} MB, ${spec.license})`,
    );
    const response = await fetcher(spec.url);
    if (!response.ok)
      throw new Error(`${spec.file}: download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== spec.sha256)
      throw new Error(
        `${spec.file}: checksum mismatch (got ${actual.slice(0, 12)}…); not installed`,
      );
    const temporary = `${target}.download`;
    await writeFile(temporary, bytes);
    await rename(temporary, target).catch(async (error: unknown) => {
      await rm(temporary, { force: true });
      throw error;
    });
    downloaded.push(spec.file);
  }
  return { downloaded, kept };
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked && import.meta.url === new URL(`file://${invoked}`).href) {
  const directory = resolve(
    process.argv[2] ??
      join(process.env['HOME'] ?? '.', '.local/state/lugn/photo-models'),
  );
  fetchModels(directory, { log: (message) => console.log(message) })
    .then(({ downloaded }) =>
      console.log(
        `${downloaded.length} downloaded; models are in ${directory}`,
      ),
    )
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
