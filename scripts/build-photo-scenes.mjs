#!/usr/bin/env node
// Turns data/photo-scenes.source.json into data/photo-scenes.json: one unit-length
// CLIP text vector per scene (the prompts' mean), stored as base64 int8 so the
// runtime needs only the image model and never the text model or a tokenizer.
//
//   cd "$(mktemp -d)" && npm init -y && npm i @huggingface/transformers@3 --ignore-scripts
//   node /path/to/lugn/scripts/build-photo-scenes.mjs --from "$PWD"
//
// The text tower must be the one the image tower was trained with: CLIP
// ViT-B/32 (Xenova/clip-vit-base-patch32), the same weights the Hub photo
// analysis runs. Changing the image model means rebuilding this file.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(
  process.argv[process.argv.indexOf('--from') + 1] ?? process.cwd(),
);
// Import by package path from the scratch directory, as an ES module.
const { AutoTokenizer, CLIPTextModelWithProjection } = await import(
  pathToFileURL(
    join(from, 'node_modules/@huggingface/transformers/src/transformers.js'),
  ).href
);
const MODEL = 'Xenova/clip-vit-base-patch32';
const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
const model = await CLIPTextModelWithProjection.from_pretrained(MODEL, {
  dtype: 'fp32',
});

const source = JSON.parse(
  readFileSync(join(here, '../data/photo-scenes.source.json'), 'utf8'),
);
const scenes = [];
for (const scene of source.scenes) {
  const inputs = tokenizer(scene.prompts, { padding: true, truncation: true });
  const { text_embeds } = await model(inputs);
  const dim = text_embeds.dims[1];
  const sum = new Float64Array(dim);
  for (let p = 0; p < scene.prompts.length; p += 1) {
    let norm = 0;
    for (let i = 0; i < dim; i += 1) norm += text_embeds.data[p * dim + i] ** 2;
    norm = Math.sqrt(norm);
    for (let i = 0; i < dim; i += 1)
      sum[i] += text_embeds.data[p * dim + i] / norm;
  }
  let norm = 0;
  for (const v of sum) norm += v * v;
  norm = Math.sqrt(norm);
  const bytes = Buffer.alloc(dim);
  for (let i = 0; i < dim; i += 1)
    bytes.writeInt8(
      Math.max(-127, Math.min(127, Math.round((sum[i] / norm) * 127 * 4))),
      i,
    );
  scenes.push({
    key: scene.key,
    sv: scene.sv,
    vector: bytes.toString('base64'),
  });
}
writeFileSync(
  join(here, '../data/photo-scenes.json'),
  `${JSON.stringify({ model: MODEL, dim: 512, scale: 4 * 127, scenes })}\n`,
);
console.log(`wrote ${scenes.length} scenes`);
