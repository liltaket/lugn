import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
  open,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { PresenceBlackbox } from '../src/runtime/presence-blackbox.js';
import { FakeClock } from '../src/core/clock.js';
import { Stl27lPresenceControlAdapter } from '../src/adapters/stl27l-presence-control.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-blackbox-'));
  directories.push(directory);
  const clock = new FakeClock(1_800_000_000_000);
  const warn = vi.fn();
  const recorder = new PresenceBlackbox(
    join(directory, 'captures'),
    warn,
    clock,
  );
  return { directory, clock, warn, recorder };
}

async function captures(recorder: PresenceBlackbox) {
  await recorder.flush();
  const names = (await readdir(recorder.directory))
    .filter((name) => name.endsWith('.jsonl.gz'))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const contents = gunzipSync(
        await readFile(join(recorder.directory, name)),
      ).toString('utf8');
      return contents
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    }),
  );
}

it('keeps exactly the preceding minute, freezes before the POST, and marks acknowledgement', async () => {
  const { recorder, clock } = await setup();
  recorder.accept({ type: 'frame', data: '{"scan_id":0}' });
  clock.advanceBy(1);
  recorder.accept({ type: 'frame', data: '{"scan_id":1}' });
  clock.advanceBy(60_000);
  recorder.accept({ type: 'status', data: '{"connected":false}' });
  const finish = recorder.beginCapture();
  recorder.accept({ type: 'frame', data: '{"scan_id":2,"state":{"count":1}}' });
  clock.advanceBy(2_000);
  finish(true);
  const [capture] = await captures(recorder);
  expect(capture![0]).toMatchObject({
    schemaVersion: 1,
    requestedCount: 1,
    acknowledged: true,
    frameCount: 1,
    availableHistoryMs: 60_000,
    bufferTruncated: false,
  });
  expect(capture!.slice(1)).toEqual([
    {
      type: 'frame',
      receivedAt: 1_800_000_000_001,
      offsetMs: -60_000,
      data: { scan_id: 1 },
    },
    {
      type: 'status',
      receivedAt: 1_800_000_060_001,
      offsetMs: 0,
      data: { connected: false },
    },
  ]);
  const [file] = await readdir(recorder.directory);
  expect((await stat(join(recorder.directory, file!))).mode & 0o777).toBe(
    0o600,
  );
});

it('records failed corrections and both ways of setting one, but not other counts', async () => {
  const { recorder, clock } = await setup();
  recorder.accept({ type: 'frame', data: '{"state":{"count":0}}' });
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ok: true, count: 1 }))
    .mockResolvedValueOnce(Response.json({ ok: true, count: 1 }))
    .mockResolvedValueOnce(Response.json({ ok: true, count: 2 }))
    .mockRejectedValueOnce(new Error('offline'));
  const adapter = new Stl27lPresenceControlAdapter(
    'http://sensor.local',
    transport,
    () => recorder.beginCapture(),
  );
  await adapter.setCountOne();
  await recorder.flush();
  clock.advanceBy(1);
  await adapter.setCount(1);
  await recorder.flush();
  clock.advanceBy(1);
  await adapter.setCount(2);
  await expect(adapter.setCountOne()).rejects.toThrow('offline');
  const saved = await captures(recorder);
  expect(saved.map((capture) => capture[0].acknowledged)).toEqual([
    true,
    true,
    false,
  ]);
  expect(saved[0]![0].availableHistoryMs).toBe(0);
});

it('bounds frame bursts, byte usage, and pending captures without writing the rolling window', async () => {
  const { recorder, directory, warn } = await setup();
  for (let i = 0; i < 500; i++)
    recorder.accept({ type: 'frame', data: `{"scan_id":${i}}` });
  expect(await readdir(directory)).toEqual([]);
  const first = recorder.beginCapture();
  for (let i = 0; i < 20; i++)
    recorder.accept({
      type: 'frame',
      data: JSON.stringify({ payload: 'a'.repeat(500_000) }),
    });
  const second = recorder.beginCapture();
  recorder.beginCapture()(true);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('busy'));
  first(true);
  first(true); // duplicate completion must not duplicate a sample
  second(false);
  const saved = await captures(recorder);
  expect(saved).toHaveLength(2);
  const countBound = saved.find((capture) => capture[0].acknowledged)!;
  expect(countBound[0]).toMatchObject({
    frameCount: 400,
    bufferTruncated: true,
  });
  expect(countBound[1].data.scan_id).toBe(100);
  const byteBound = saved.find((capture) => !capture[0].acknowledged)!;
  expect(byteBound[0].bufferTruncated).toBe(true);
  expect(byteBound[0].frameCount).toBeLessThan(20);
});

it('expires stale data on capture even when the sensor stops sending', async () => {
  const { recorder, clock } = await setup();
  recorder.accept({ type: 'frame', data: '{}' });
  clock.advanceBy(60_001);
  recorder.beginCapture()(false);
  expect((await captures(recorder))[0]).toHaveLength(1);
});

it('rotates only owned captures by bytes and leaves unrelated files intact', async () => {
  const { recorder, clock } = await setup();
  recorder.beginCapture()(true);
  await recorder.flush();
  const [oldName] = await readdir(recorder.directory);
  const old = await open(join(recorder.directory, oldName!), 'r+');
  await old.truncate(128 * 1024 * 1024);
  await old.close();
  await writeFile(join(recorder.directory, 'keep.txt'), 'training notes');
  clock.advanceBy(1);
  recorder.beginCapture()(true);
  await recorder.flush();
  const names = await readdir(recorder.directory);
  expect(names).not.toContain(oldName);
  expect(names).toContain('keep.txt');
  expect(names).toHaveLength(2);
});

it('reports disk failure without failing the correction or leaking a rejected write', async () => {
  const { directory, clock, warn } = await setup();
  const blocked = join(directory, 'blocked');
  await writeFile(blocked, 'not a directory');
  const recorder = new PresenceBlackbox(blocked, warn, clock);
  const adapter = new Stl27lPresenceControlAdapter(
    'http://sensor.local',
    async () => Response.json({ ok: true, count: 1 }),
    () => recorder.beginCapture(),
  );
  await expect(adapter.setCountOne()).resolves.toBeUndefined();
  await recorder.flush();
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('could not be saved'),
  );
});

it('bounds clip count and recovers owned temporary files after an interrupted write', async () => {
  const { recorder, clock } = await setup();
  recorder.beginCapture()(true);
  await recorder.flush();
  const oldest = (await readdir(recorder.directory))[0]!;
  await Promise.all(
    Array.from({ length: 499 }, (_, index) =>
      writeFile(
        join(
          recorder.directory,
          `${clock.now() + index + 1}-00000000-0000-0000-0000-000000000000.jsonl.gz`,
        ),
        '',
      ),
    ),
  );
  const temporary = `${clock.now()}-00000000-0000-0000-0000-000000000000.tmp`;
  await writeFile(join(recorder.directory, temporary), 'interrupted write');
  clock.advanceBy(1000);
  recorder.beginCapture()(true);
  await recorder.flush();
  const files = await readdir(recorder.directory);
  expect(files).toHaveLength(500);
  expect(files).not.toContain(oldest);
  expect(files).not.toContain(temporary);
});
