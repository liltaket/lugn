/**
 * The analysis worker: a separate, low-priority process that loads the models,
 * answers one picture at a time and exits when it is told to. It never reads
 * the cache or the network; it is handed a file path and returns numbers, so
 * a crash or a memory spike here cannot touch the room controller.
 */
import { readFile } from 'node:fs/promises';
import { PhotoInference } from './inference.js';
import type { ModelPaths } from './models.js';

export type WorkerRequest =
  { type: 'analyse'; id: string; path: string } | { type: 'stop' };
export type WorkerReply =
  | { type: 'ready' }
  | {
      type: 'result';
      id: string;
      embedding: Float32Array;
      faces: Array<{
        x: number;
        y: number;
        w: number;
        h: number;
        score: number;
        front: number;
        embedding: Float32Array;
      }>;
      ms: number;
    }
  | { type: 'error'; id: string | null; message: string };

const send = (reply: WorkerReply): void => {
  process.send?.(reply);
};

async function main(): Promise<void> {
  const raw = process.env['LUGN_PHOTO_MODEL_PATHS'];
  if (!raw || !process.send) {
    process.exitCode = 2;
    return;
  }
  const inference = await PhotoInference.load(JSON.parse(raw) as ModelPaths);
  let chain: Promise<void> = Promise.resolve();
  process.on('message', (message: WorkerRequest) => {
    if (message.type === 'stop') {
      chain = chain.then(async () => {
        await inference.dispose();
        process.exit(0);
      });
      return;
    }
    chain = chain.then(async () => {
      const started = performance.now();
      try {
        const analysis = await inference.analyse(await readFile(message.path));
        send({
          type: 'result',
          id: message.id,
          embedding: analysis.embedding,
          faces: analysis.faces,
          ms: Math.round(performance.now() - started),
        });
      } catch (error) {
        send({
          type: 'error',
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
  send({ type: 'ready' });
}

main().catch((error: unknown) => {
  send({
    type: 'error',
    id: null,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
