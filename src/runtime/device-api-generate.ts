import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDeviceApiFixtures } from './device-api-fixtures.js';
import { buildOpenApiDocument, toYaml } from './device-openapi.js';

/** Writes the committed device API contract. Run with `npm run api:generate`. */
export async function generateDeviceApiContract(root: string): Promise<void> {
  const directory = join(root, 'docs', 'api');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'openapi.v1.yaml'),
    toYaml(buildOpenApiDocument()),
    'utf8',
  );
  const fixtures = join(directory, 'fixtures');
  await rm(fixtures, { recursive: true, force: true });
  await mkdir(fixtures, { recursive: true });
  for (const fixture of await buildDeviceApiFixtures()) {
    const text =
      typeof fixture.content === 'string'
        ? fixture.content
        : `${JSON.stringify(fixture.content, null, 2)}\n`;
    await writeFile(
      join(
        fixtures,
        `${fixture.name}.${typeof fixture.content === 'string' ? 'txt' : 'json'}`,
      ),
      text,
      'utf8',
    );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await generateDeviceApiContract(process.cwd());
}
