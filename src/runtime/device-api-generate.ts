import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildOpenApiDocument, toYaml } from './device-openapi.js';

/** Writes the committed device API contract. Run with `npm run api:generate`. */
export async function generateDeviceApiContract(root: string): Promise<void> {
  const target = join(root, 'docs', 'api', 'openapi.v1.yaml');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, toYaml(buildOpenApiDocument()), 'utf8');
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await generateDeviceApiContract(process.cwd());
}
