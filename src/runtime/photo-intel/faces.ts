/**
 * The pure parts of face analysis: decoding YuNet's output, merging
 * overlapping boxes, estimating how frontal a face is, and cutting an aligned
 * 112 × 112 crop for SFace. Nothing here touches a model or the disk, so all
 * of it is tested with plain numbers.
 */
export type Point = { x: number; y: number };
export type DetectedFace = {
  /** Box in the analysed picture's pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Right eye, left eye, nose, right and left mouth corner (image coordinates). */
  landmarks: [Point, Point, Point, Point, Point];
  score: number;
};

export const DETECTOR_SIZE = 640;
const STRIDES = [8, 16, 32] as const;
const NMS_IOU = 0.3;

/** The five points of an upright 112 × 112 ArcFace/SFace crop. */
export const ALIGN_TEMPLATE: ReadonlyArray<Point> = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];

export type YuNetOutputs = {
  cls: Float32Array[];
  obj: Float32Array[];
  bbox: Float32Array[];
  kps: Float32Array[];
};

const clamp01 = (value: number): number =>
  value < 0 ? 0 : value > 1 ? 1 : value;

/**
 * Decodes the 12 YuNet tensors (strides 8, 16 and 32) into boxes in the
 * detector's own 640-pixel space. Same arithmetic as OpenCV's FaceDetectorYN.
 */
export function decodeYuNet(
  outputs: YuNetOutputs,
  size = DETECTOR_SIZE,
  minScore = 0.6,
): DetectedFace[] {
  const faces: DetectedFace[] = [];
  STRIDES.forEach((stride, level) => {
    const cols = Math.floor(size / stride);
    const rows = cols;
    const cls = outputs.cls[level]!;
    const obj = outputs.obj[level]!;
    const bbox = outputs.bbox[level]!;
    const kps = outputs.kps[level]!;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const index = row * cols + col;
        const score = Math.sqrt(clamp01(cls[index]!) * clamp01(obj[index]!));
        if (score < minScore) continue;
        const cx = (col + bbox[index * 4]!) * stride;
        const cy = (row + bbox[index * 4 + 1]!) * stride;
        const w = Math.exp(bbox[index * 4 + 2]!) * stride;
        const h = Math.exp(bbox[index * 4 + 3]!) * stride;
        const points: Point[] = [];
        for (let n = 0; n < 5; n += 1)
          points.push({
            x: (kps[index * 10 + n * 2]! + col) * stride,
            y: (kps[index * 10 + n * 2 + 1]! + row) * stride,
          });
        faces.push({
          x: cx - w / 2,
          y: cy - h / 2,
          w,
          h,
          landmarks: points as DetectedFace['landmarks'],
          score,
        });
      }
    }
  });
  return nonMaxSuppression(faces);
}

function iou(a: DetectedFace, b: DetectedFace): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.w * a.h + b.w * b.h - overlap;
  return union <= 0 ? 0 : overlap / union;
}

export function nonMaxSuppression(
  faces: DetectedFace[],
  threshold = NMS_IOU,
): DetectedFace[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept: DetectedFace[] = [];
  for (const face of sorted)
    if (kept.every((other) => iou(face, other) <= threshold)) kept.push(face);
  return kept;
}

/**
 * How frontal a face is, 0 (profile) to 1 (straight on): the nose sits
 * midway between the eyes in a frontal face and slides toward one eye as the
 * head turns.
 */
export function frontalness(landmarks: DetectedFace['landmarks']): number {
  const [rightEye, leftEye, nose] = landmarks;
  const span = leftEye.x - rightEye.x;
  if (!(span > 1)) return 0;
  const offset = Math.abs(nose.x - (rightEye.x + leftEye.x) / 2) / span;
  return clamp01(1 - offset * 2.2);
}

/** Similarity transform (scale, rotation, shift) mapping `from` onto `to`. */
export type Similarity = { a: number; b: number; tx: number; ty: number };

/** Least-squares similarity transform (Umeyama, no reflection). */
export function fitSimilarity(
  from: ReadonlyArray<Point>,
  to: ReadonlyArray<Point>,
): Similarity {
  const n = from.length;
  let fx = 0;
  let fy = 0;
  let tx = 0;
  let ty = 0;
  for (let i = 0; i < n; i += 1) {
    fx += from[i]!.x;
    fy += from[i]!.y;
    tx += to[i]!.x;
    ty += to[i]!.y;
  }
  fx /= n;
  fy /= n;
  tx /= n;
  ty /= n;
  let numA = 0;
  let numB = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const px = from[i]!.x - fx;
    const py = from[i]!.y - fy;
    const qx = to[i]!.x - tx;
    const qy = to[i]!.y - ty;
    numA += px * qx + py * qy;
    numB += px * qy - py * qx;
    denominator += px * px + py * py;
  }
  if (denominator === 0) return { a: 1, b: 0, tx: 0, ty: 0 };
  const a = numA / denominator;
  const b = numB / denominator;
  return { a, b, tx: tx - (a * fx - b * fy), ty: ty - (b * fx + a * fy) };
}

export const applySimilarity = (m: Similarity, p: Point): Point => ({
  x: m.a * p.x - m.b * p.y + m.tx,
  y: m.b * p.x + m.a * p.y + m.ty,
});

/**
 * The aligned crop as planar RGB floats (0–255), 3 × size × size, sampled
 * bilinearly from an interleaved RGB image. Outside the picture is grey.
 */
export function alignedCrop(
  rgb: Uint8Array,
  width: number,
  height: number,
  landmarks: DetectedFace['landmarks'],
  size = 112,
): Float32Array {
  const forward = fitSimilarity(landmarks, ALIGN_TEMPLATE);
  // Inverse of x' = M x: output pixel → source pixel.
  const scale = forward.a * forward.a + forward.b * forward.b;
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - forward.tx;
      const dy = y - forward.ty;
      const sx = (forward.a * dx + forward.b * dy) / scale;
      const sy = (-forward.b * dx + forward.a * dy) / scale;
      const index = y * size + x;
      if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) {
        out[index] = out[plane + index] = out[2 * plane + index] = 128;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let channel = 0; channel < 3; channel += 1) {
        const top =
          rgb[(y0 * width + x0) * 3 + channel]! * (1 - fx) +
          rgb[(y0 * width + x1) * 3 + channel]! * fx;
        const bottom =
          rgb[(y1 * width + x0) * 3 + channel]! * (1 - fx) +
          rgb[(y1 * width + x1) * 3 + channel]! * fx;
        out[channel * plane + index] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return out;
}

export function normalize(vector: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i]! * vector[i]!;
  const length = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i]! / length;
  return out;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i]! * b[i]!;
  return sum;
}
