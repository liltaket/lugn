import sharp from 'sharp';
import {
  DETECTOR_SIZE,
  alignedCrop,
  decodeYuNet,
  frontalness,
  normalize,
  type DetectedFace,
  type YuNetOutputs,
} from './faces.js';
import type { ModelPaths } from './models.js';

import type * as OrtNamespace from 'onnxruntime-node';

type Ort = typeof OrtNamespace;
type Session = OrtNamespace.InferenceSession;

export type AnalysedFace = {
  /** Box as fractions of the picture (0–1), so it survives any rescaling. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Detector confidence, 0–1. */
  score: number;
  /** 0 (profile) to 1 (straight on). */
  front: number;
  /** Unit-length SFace embedding. */
  embedding: Float32Array;
};
export type Analysis = {
  /** Unit-length CLIP image embedding. */
  embedding: Float32Array;
  faces: AnalysedFace[];
};

const CLIP_SIZE = 224;
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];
/** Faces narrower than this (in the analysed picture) give unusable embeddings. */
const MIN_FACE_PIXELS = 30;
const MIN_FACE_SCORE = 0.6;
const MAX_FACES = 12;

// The worker shares a small machine with the room controller and the sensor:
// one libvips thread and no operation cache.
sharp.concurrency(1);
sharp.cache(false);

/**
 * One loaded set of models. Single-threaded and without a memory arena: the
 * analysis shares a Raspberry Pi with the room controller and the sensor.
 */
export class PhotoInference {
  private constructor(
    private readonly ort: Ort,
    private readonly clip: Session,
    private readonly detector: Session,
    private readonly recognizer: Session,
  ) {}

  static async load(paths: ModelPaths): Promise<PhotoInference> {
    const ort = await import('onnxruntime-node');
    // Small and slow beats fast and big on a machine with 1 GB: no memory
    // arena, one thread, and the weights are not copied into a packed layout
    // (that alone is about 50 MB less resident for these three models).
    const options = {
      executionProviders: ['cpu'],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      enableCpuMemArena: false,
      enableMemPattern: false,
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
      extra: { session: { disable_prepacking: '1' } },
    } as const;
    const [clip, detector, recognizer] = await Promise.all([
      ort.InferenceSession.create(paths.clip, options),
      ort.InferenceSession.create(paths.detector, options),
      ort.InferenceSession.create(paths.recognizer, options),
    ]);
    return new PhotoInference(ort, clip, detector, recognizer);
  }

  async analyse(jpeg: Uint8Array): Promise<Analysis> {
    const source = await sharp(jpeg, { failOn: 'error' })
      .rotate()
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = source.info;
    const embedding = await this.embed(jpeg);
    const faces = await this.faces(source.data, width, height);
    return { embedding, faces };
  }

  /** CLIP: centre-cropped 224 × 224, normalised, one forward pass. */
  async embed(jpeg: Uint8Array): Promise<Float32Array> {
    const raw = await sharp(jpeg, { failOn: 'error' })
      .rotate()
      .removeAlpha()
      .toColourspace('srgb')
      .resize(CLIP_SIZE, CLIP_SIZE, { fit: 'cover', kernel: 'cubic' })
      .raw()
      .toBuffer();
    const plane = CLIP_SIZE * CLIP_SIZE;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i += 1)
      for (let c = 0; c < 3; c += 1)
        input[c * plane + i] =
          (raw[i * 3 + c]! / 255 - CLIP_MEAN[c]!) / CLIP_STD[c]!;
    const result = await this.clip.run({
      [this.clip.inputNames[0]!]: new this.ort.Tensor('float32', input, [
        1,
        3,
        CLIP_SIZE,
        CLIP_SIZE,
      ]),
    });
    return normalize(result[this.clip.outputNames[0]!]!.data as Float32Array);
  }

  private async faces(
    rgb: Uint8Array,
    width: number,
    height: number,
  ): Promise<AnalysedFace[]> {
    const scale = DETECTOR_SIZE / Math.max(width, height);
    const scaledWidth = Math.max(1, Math.round(width * scale));
    const scaledHeight = Math.max(1, Math.round(height * scale));
    const small = await sharp(rgb, {
      raw: { width, height, channels: 3 },
    })
      .resize(scaledWidth, scaledHeight, { kernel: 'lanczos3' })
      .raw()
      .toBuffer();
    // BGR, 0–255, picture at the top left of a black square.
    const plane = DETECTOR_SIZE * DETECTOR_SIZE;
    const input = new Float32Array(3 * plane);
    for (let y = 0; y < scaledHeight; y += 1)
      for (let x = 0; x < scaledWidth; x += 1) {
        const from = (y * scaledWidth + x) * 3;
        const to = y * DETECTOR_SIZE + x;
        input[to] = small[from + 2]!;
        input[plane + to] = small[from + 1]!;
        input[2 * plane + to] = small[from]!;
      }
    const result = await this.detector.run({
      [this.detector.inputNames[0]!]: new this.ort.Tensor('float32', input, [
        1,
        3,
        DETECTOR_SIZE,
        DETECTOR_SIZE,
      ]),
    });
    const grab = (prefix: string): Float32Array[] =>
      [8, 16, 32].map(
        (stride) => result[`${prefix}_${stride}`]!.data as Float32Array,
      );
    const outputs: YuNetOutputs = {
      cls: grab('cls'),
      obj: grab('obj'),
      bbox: grab('bbox'),
      kps: grab('kps'),
    };
    const found = decodeYuNet(outputs, DETECTOR_SIZE, MIN_FACE_SCORE)
      .map((face) => toPicture(face, 1 / scale))
      .filter((face) => Math.min(face.w, face.h) >= MIN_FACE_PIXELS)
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, MAX_FACES);
    const out: AnalysedFace[] = [];
    for (const face of found) {
      const crop = alignedCrop(rgb, width, height, face.landmarks);
      const features = await this.recognizer.run({
        [this.recognizer.inputNames[0]!]: new this.ort.Tensor(
          'float32',
          crop,
          [1, 3, 112, 112],
        ),
      });
      const x0 = Math.max(0, face.x);
      const y0 = Math.max(0, face.y);
      const x1 = Math.min(width, face.x + face.w);
      const y1 = Math.min(height, face.y + face.h);
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      out.push({
        x: round4(x0 / width),
        y: round4(y0 / height),
        w: round4((x1 - x0) / width),
        h: round4((y1 - y0) / height),
        score: round4(face.score),
        front: round4(frontalness(face.landmarks)),
        embedding: normalize(
          features[this.recognizer.outputNames[0]!]!.data as Float32Array,
        ),
      });
    }
    return out;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([
      this.clip.release(),
      this.detector.release(),
      this.recognizer.release(),
    ]);
  }
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

function toPicture(face: DetectedFace, factor: number): DetectedFace {
  return {
    x: face.x * factor,
    y: face.y * factor,
    w: face.w * factor,
    h: face.h * factor,
    score: face.score,
    landmarks: face.landmarks.map((p) => ({
      x: p.x * factor,
      y: p.y * factor,
    })) as DetectedFace['landmarks'],
  };
}
