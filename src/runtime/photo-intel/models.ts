import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The three small models the photo analysis uses, all permissively licensed
 * so the same files can be used for a household product:
 *
 * - CLIP ViT-B/32 image tower (OpenAI, MIT; ONNX export and int8 quantisation
 *   by Xenova) → one 512-number description of what a picture shows.
 * - YuNet (Shiqi Yu, MIT; OpenCV Zoo) → face boxes and five landmarks.
 * - SFace (Zhong et al., Apache-2.0; OpenCV Zoo) → 128 numbers per face.
 *
 * Apple's MobileCLIP2 and InsightFace's pretrained weights are faster or
 * stronger on paper, but both are released for research use only, so they are
 * not shipped; any model with the same inputs and outputs can be dropped in
 * by file name.
 */
export type ModelSpec = {
  key: 'clip' | 'detector' | 'recognizer';
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  license: string;
};

export const MODEL_VERSION = 'clip-b32-int8+yunet-2023mar+sface-2021dec-1';

export const MODELS: readonly ModelSpec[] = [
  {
    key: 'clip',
    file: 'clip-vit-b32-vision-int8.onnx',
    url: 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx',
    sha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299',
    bytes: 89_117_001,
    license: 'MIT (OpenAI CLIP)',
  },
  {
    key: 'detector',
    file: 'yunet-2023mar.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    bytes: 232_589,
    license: 'MIT (YuNet)',
  },
  {
    key: 'recognizer',
    file: 'sface-2021dec-int8.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec_int8.onnx',
    sha256: '2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a',
    bytes: 9_896_933,
    license: 'Apache-2.0 (SFace)',
  },
];

export type ModelPaths = Record<ModelSpec['key'], string>;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Which model files are in `dir` (by name and size; checksums are for `verify`). */
export async function findModels(dir: string): Promise<{
  paths: ModelPaths | null;
  missing: string[];
}> {
  const paths: Partial<ModelPaths> = {};
  const missing: string[] = [];
  for (const spec of MODELS) {
    const path = join(dir, spec.file);
    try {
      const info = await stat(path);
      if (info.isFile() && info.size === spec.bytes) paths[spec.key] = path;
      else missing.push(spec.file);
    } catch {
      missing.push(spec.file);
    }
  }
  return missing.length === 0
    ? { paths: paths as ModelPaths, missing }
    : { paths: null, missing };
}

export async function verifyModels(dir: string): Promise<string[]> {
  const bad: string[] = [];
  for (const spec of MODELS) {
    try {
      if ((await sha256File(join(dir, spec.file))) !== spec.sha256)
        bad.push(spec.file);
    } catch {
      bad.push(spec.file);
    }
  }
  return bad;
}
