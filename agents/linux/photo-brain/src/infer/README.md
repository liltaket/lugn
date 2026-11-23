# Photo brain inference

`infer::open(models_dir, threads)` (or `infer::open_with(&InferConfig)`) returns a
`PictureAnalyzer` that turns one picture file into a `PictureAnalysis`
(`src/analysis.rs`): a unit-length picture embedding, the faces with box, score,
frontalness, quality and a unit-length face embedding, and the picture's sharpness
and darkness.

```text
file ─► decode (upright RGB, full size) ─┬─► quality: Laplacian on a 768 px copy, luminance percentiles
                                         ├─► SigLIP 2 vision tower on a 384 x 384 squash ─► embedding
                                         └─► YuNet at 1600 + 640 + 320 px ─► NMS ─► landmark refinement
                                              ─► 112 px ArcFace alignment from the full picture ─► recogniser
```

## Setting up

```sh
export PATH=$HOME/.cargo/bin:$PATH
cd agents/linux/photo-brain
# Runtime library + the default model set (~1.0 GB) into <dir>, <dir>/../lib:
cargo run --release --example fetch -- ~/.local/share/lugn-photo-brain/models
cargo run --release --example analyse -- ~/.local/share/lugn-photo-brain/models \
  --scenes ../../../data/photo-scenes.json some.heic other.jpg
cargo run --release --example compare_faces -- ~/.local/share/lugn-photo-brain/models a.jpg b.heic
cargo run --release --example crops -- ~/.local/share/lugn-photo-brain/models out/ group.jpg
```

`analyse` prints one JSON line per picture (size, faces, quality, timings per
stage, optional top scenes) and the peak RSS; `--dump-embeddings f.jsonl` writes the
vectors, `--embed KEY` / `--face KEY` pick other `models.toml` entries. `crops` saves
the aligned face crops the recogniser sees.

The integration test runs the real models on public-domain pictures it downloads
into a temporary directory (nothing is committed; it skips with a message when the
models or the network are missing):

```sh
LUGN_PHOTO_BRAIN_MODELS=~/.local/share/lugn-photo-brain/models \
  cargo test --release infer::it -- --nocapture
# LUGN_PHOTO_BRAIN_EMBED / LUGN_PHOTO_BRAIN_FACE pick other entries;
# LUGN_PHOTO_BRAIN_SAMPLES=<dir> reuses already downloaded pictures
# (Wikimedia answers repeated anonymous downloads with HTTP 429).
```

## Models (`models.toml`)

The manifest is compiled in; a `models.toml` in the models directory overrides it,
so switching a model is a file edit (`[use]`) and a restart. Every file is pinned by
a commit in its URL and a SHA-256; `infer::models::ensure(dir, &Which::Default)`
downloads what is missing and refuses a file whose hash differs. `ModelIds::embed`
and `ModelIds::face` are the manifest keys; `ModelIds::detector` also carries the
detector settings (`yunet-2026may@1600px-s0.65`).

| key                                     | file size | licence                                                   | default set | notes                                   |
| --------------------------------------- | --------: | --------------------------------------------------------- | :---------: | --------------------------------------- |
| `runtime` (libonnxruntime.so.1.31.1)    |     29 MB | MIT                                                       |     yes     | from the official PyPI wheel, see below |
| `siglip2-so400m-patch16-384-q4` **use** |    280 MB | Apache-2.0                                                |     yes     | 1152-d, 4-bit weights                   |
| `siglip2-so400m-patch16-384-fp16`       |    857 MB | Apache-2.0                                                |             | 1152-d, full precision, 2.3 GB RSS      |
| `siglip2-base-patch16-384-fp32`         |    373 MB | Apache-2.0                                                |     yes     | 768-d, the fast one                     |
| `siglip2-base-patch16-384-fp16`         |    187 MB | Apache-2.0                                                |             | 768-d, same vectors as fp32, slower     |
| `…-int8` (both sizes)                   | 434/96 MB | Apache-2.0                                                |             | broken by quantisation, comparison only |
| `yunet-2026may` **use**                 |    0.2 MB | MIT                                                       |     yes     | dynamic H/W                             |
| `sface-2021dec` **use**                 |     39 MB | Apache-2.0                                                |     yes     | 128-d                                   |
| `auraface-v1-glintr100`                 |    261 MB | Apache-2.0 (model card)                                   |     yes     | 512-d, recogniser file only             |
| `buffalo_l-w600k-r50`                   |    174 MB | **non-commercial research only** (InsightFace pretrained) |   **no**    | 512-d; only when named, never committed |

Sources: SigLIP 2 ONNX exports from `onnx-community/siglip2-{so400m,base}-patch16-384-ONNX`
(of `google/siglip2-*`, Apache-2.0); YuNet and SFace from OpenCV Zoo
(`opencv/opencv_zoo@48b10fa5`); AuraFace from `fal/AuraFace-v1@af6d057c`; buffalo_l
from `deepinsight/insightface` release v0.7 (`buffalo_l.zip`, member `w600k_r50.onnx`).

Switching the recogniser, e.g. to compare on the household's own labelled faces:

```toml
# <models_dir>/models.toml: a copy of src/infer/models.toml with
[use]
face = "auraface-v1-glintr100"   # or "buffalo_l-w600k-r50" (fetch it by name first)
```

The face grouping's thresholds belong to the recogniser: they must be recalibrated
whenever `ModelIds::face` changes (cosine scales differ, see below).

### ONNX Runtime

`ort` 2.0.0-rc.15 with `load-dynamic` and `api-31` (rc.15's default API level; ORT's
C API version equals the minor version, so 1.31.x provides API 31; a higher `api-XX`
feature would fail at start-up). No build-time download. The library is found in this
order: `InferConfig::onnxruntime_lib`, `ORT_DYLIB_PATH`, the manifest's
`[runtime] file` (`<models_dir>/../lib/libonnxruntime.so.1.31.1`). The fetcher takes
it from the official `onnxruntime==1.31.1` cp312 manylinux wheel on PyPI (pinned by
PyPI's SHA-256, then the extracted `.so` by its own); the GitHub release asset was not
reachable when this was written. The extracted file is byte-identical to the one in
a pip-installed 1.31.1 and depends only on libc/libstdc++/libm.

Telemetry: ORT 1.31 on Linux contains a 1DS client (`telemetry_1ds.cc`, endpoint
`mobile.events.data.microsoft.com`) that reads `ORT_DISABLE_TELEMETRY`. The program
sets `ORT_DISABLE_TELEMETRY=1` before loading the library (when unset) and disables
telemetry events through the API; the service unit should set the variable too. An
`strace -f -e trace=connect,socket,sendto` of a full `analyse` run shows no socket
at all.

Sessions: CPU provider, `intra_op_threads = threads`, one inter-op thread, no CPU
memory arena, no memory pattern, no spinning, full graph optimisation. Only the three
models in use are loaded.

## Picture embedding (SigLIP 2)

Preprocessing follows the models' `preprocessor_config.json` (SiglipImageProcessor):
resize to exactly 384 x 384 ignoring the aspect ratio (no crop), `resample = 2`
(bilinear; implemented as PIL's antialiased triangle filter), rescale 1/255, mean 0.5,
std 0.5, RGB. The output is `pooler_output`, L2-normalised. The scene vocabulary
(`data/photo-scenes*.json`, format in `docs/PHOTO-BRAIN.md`) comes from the matching
text tower and gives per-scene `sigmoid(scale·cos + bias)`.

### Quantisation

Measured on 21 test pictures against the full-precision embedding (fp16 and fp32 give
cosine 1.0000 to each other on base):

| export      | cosine to full precision (min / mean) | pairwise-similarity rank corr. | embed ms\* | peak RSS\*\* |
| ----------- | ------------------------------------: | -----------------------------: | ---------: | -----------: |
| so400m fp16 |                       1.0000 / 1.0000 |                          1.000 |       1300 |      2340 MB |
| so400m q4   |                         0.957 / 0.976 |                          0.979 |       1040 |   620-665 MB |
| so400m bnb4 |                         0.907 / 0.961 |                          0.935 |       1135 |       590 MB |
| so400m int8 |                         0.349 / 0.771 |                          0.426 |        770 |       930 MB |
| base fp32   |                                1.0000 |                          1.000 |        245 |       810 MB |
| base q4     |                         0.947 / 0.972 |                          0.981 |        226 |       380 MB |
| base int8   |                         0.573 / 0.830 |                          0.700 |        172 |       390 MB |

\* 8 threads, median; \*\* whole process with SFace and YuNet loaded.

The int8 exports quantise every activation dynamically (`DynamicQuantizeLinear` →
`ConvInteger`/`MatMulInteger`); SigLIP's large activation outliers do not survive
that, and scene ranking goes wrong (base int8: the birthday cake, receipt, Christmas
tree and screenshot all get the wrong top scene, fp32 gets all four right). The q4
export quantises only weights (`MatMulNBits`, activations stay fp32), which keeps the
structure. fp16 is exact but ONNX Runtime's CPU provider computes in fp32 and holds
fp32 copies of the weights while running (2.3 GB peak; no session option changed
that: prepacking off, constant folding off). Hence the default so400m q4 within the
~2 GB budget; so400m fp16 when memory allows; base fp32 for speed.

## Faces

- **Detector**: YuNet `2026may` (dynamic input shape; the `2023mar` file is fixed at
  1 x 3 x 640 x 640). Input BGR 0-255, padded to multiples of 32. YuNet is trained on
  faces of about 10-300 px, so it runs on the full-size picture scaled to a 1600 px
  long edge (small faces in group pictures) and again at 640 and 320 px for big faces;
  each pass keeps faces up to 160 px, the last pass any size, and the two coarse
  passes need score ≥ 0.8 (at 320 px a helmet or a knee reaches 0.67). Then greedy
  NMS by score (IoU 0.4, plus "80 % inside a better box"), score ≥ 0.65, short side
  ≥ 20 px of the original, at most 32 faces, biggest first (a deterministic order, so
  face ids `<pictureId>.<index>` are stable).
- **Landmark refinement**: YuNet's landmarks follow the box but hardly the head's roll
  (a 30° tilted head comes back with level eyes, so the "aligned" crop stays tilted and
  SFace's cosine to the upright face fell to 0.36). Each face is looked at again in a
  192 px view of twice its box, turned by 0, ±30, ±60 and ±90°; the best-scoring turn,
  corrected by the eye angle found there, is looked at once more and those landmarks
  are mapped back. Upright faces (best turn 0°, residual roll < 10°) keep their
  original, higher-resolution landmarks. After: cosine to the upright face 0.94-0.99
  at ±30° and 0.92-0.97 at 90° for the three recognisers.
- **Alignment**: least-squares similarity (Umeyama, rotation + uniform scale) of the 5
  landmarks onto the ArcFace 112 x 112 template, sampled from the full-size picture;
  a face much bigger than 112 px is first reduced with an antialiasing filter.
- **`front`**: the nose's offset from the eyes' midpoint measured along the eye axis,
  as a fraction of the eye distance, `1 − 2.2·|offset|` clamped to 0-1. Roll does not
  change it (unit test: identical at 0° and 40°).
- **`quality`** 0-100: `100 × size × (0.35 + 0.65·sharp) × (0.3 + 0.7·front) × (0.5 + 0.5·conf)`
  with size = short box side in original pixels (24 → 0, ≥ 112 → 1), sharp =
  Laplacian variance of the aligned crop (log10 1.3 → 0, 2.7 → 1), conf = detector
  score (0.5 → 0, 1 → 1). A heuristic; the grouping should treat it as a ranking.

### Recognisers

All go through the same path; the manifest gives channel order and normalisation.
The input conventions were checked on 33 faces of public-domain pictures (NASA crew
portraits, official White House portraits and group photos: 13 same-person pairs
across pictures, 419 different-person pairs):

| recogniser                    | input                    | same person min / mean | different max / mean |   d′ |
| ----------------------------- | ------------------------ | ---------------------: | -------------------: | ---: |
| SFace                         | **RGB**, 0-255 raw       |          0.494 / 0.769 |        0.305 / 0.096 | 6.90 |
| SFace                         | BGR                      |          0.423 / 0.728 |        0.372 / 0.078 | 5.76 |
| AuraFace glintr100            | **RGB**, (x−127.5)/127.5 |          0.389 / 0.704 |        0.303 / 0.058 | 5.55 |
| AuraFace glintr100            | BGR                      |          0.260 / 0.649 |        0.263 / 0.063 | 4.35 |
| AuraFace glintr100            | RGB, 0-255 raw           |          0.936 / 0.973 |        0.981 / 0.930 | 1.51 |
| buffalo_l w600k_r50 (private) | **RGB**, (x−127.5)/127.5 |          0.412 / 0.731 |        0.190 / 0.004 | 6.60 |
| buffalo_l w600k_r50 (private) | BGR                      |          0.346 / 0.707 |        0.173 / 0.007 | 5.49 |

SFace's graph starts with `Sub 127.5` and `Mul 1/128` (its own normalisation), so it
gets raw 0-255 values, and it wants RGB (as OpenCV feeds it: `blobFromImage(…,
swapRB=true)` on a BGR image). The two others have no normalisation in the graph.
The set is far too small to rank the three; it only fixes their input conventions.
Cosine scales differ (buffalo_l's different-person pairs sit near 0, SFace's near
0.1), so thresholds do not carry over.

AuraFace: the model card says Apache-2.0 and "trained on commercially and publicly
available data"; `LICENSE.md` is the generic choosealicense.com Apache-2.0 text with
no copyright holder. Its `scrfd_10g_bnkps.onnx`, `2d106det.onnx`, `1k3d68.onnx` and
`genderage.onnx` are byte-identical to InsightFace's (non-commercial) `buffalo_l`
files, which is why only `glintr100.onnx` is used. That file is not a copy of
InsightFace's antelopev2 `glintr100.onnx`: different bytes and unrelated weights (the
largest tensor, 512 x 25088, has correlation −0.0003 with antelopev2's; none of the 40
largest tensors match).

## Quality

`sharp` = variance of the 4-neighbour Laplacian of the luminance on a copy with a
768 px long edge, `50 × (log10(var) − 1)` clamped (var 10 → 0, 100 → 50, 1000 → 100).
`dark` from the luminance median and 90th percentile, `b = (p50 + p90) / 2`,
`100 × (128 − b) / 128` clamped. On real pictures with Gaussian blur r = 2 and 5 px
(at 2048 px): forest 100 → 79 → 9, old town 100 → 64 → 6, portrait 71 → 32 → 0;
darkened to 35 % / 12 %: dark 0 → 55 → 85.

## Speed and memory on Kuffe

16 cores shared with other jobs (load ≈ 6), 8 threads, `nice -n 15`, release build,
medians over five pictures each, ~5 faces per picture. HEIC = 3024 x 4032 / 4032 x 3024
(x265, single image), JPEG = 1536 x 2048 (Apple's rendition size).

| embedding + recogniser | HEIC total | JPEG total | decode H/J | embed | detect + refine | recognise | peak RSS |
| ---------------------- | ---------: | ---------: | ---------: | ----: | --------------: | --------: | -------: |
| so400m q4 + SFace      |     2.09 s |     1.23 s |   816 / 12 |  1050 |       244 / 150 |        40 |   624 MB |
| so400m q4 + AuraFace   |     2.18 s |     1.37 s |   779 / 13 |  1047 |       231 / 147 |       188 |   843 MB |
| so400m q4 + buffalo_l  |     2.23 s |     1.37 s |   799 / 15 |  1036 |       243 / 152 |       185 |   836 MB |
| so400m fp16 + SFace    |     2.31 s |     1.50 s |   801 / 13 |  1314 |       225 / 144 |        40 |  2341 MB |
| base fp32 + SFace      |     1.29 s |     0.48 s |   793 / 13 |   245 |       251 / 155 |        37 |   808 MB |

(milliseconds unless marked). With 4 threads so400m q4 + SFace takes 2.58 s / 1.76 s
(embed 1.54 s) at 613 MB. Model loading takes 0.6-1.1 s.

## Known weaknesses

- **HEIC decode** is single-threaded for a single-image HEIC (~0.8 s per 12 MP
  picture here). iPhone files are 512 px tile grids that libheif decodes in parallel;
  not measured, because no real iPhone file was available.
- **Colour**: iPhone HEICs are Display P3; pixels are used as decoded, without
  conversion to sRGB. Slightly shifted colours for the embedding.
- **Orientation** was verified with synthetic files (an HEIC with `irot` plus an EXIF
  orientation 6, a JPEG with EXIF orientation 6; unit tests), not with a real iPhone
  picture. Pictures stored sideways without any orientation tag stay sideways
  (faces up to 90° are still found and aligned; upside-down faces are not tried).
- **Faces**: profiles score low and `front` is near 0 for heads turned more than ~60°;
  masks, hands and heavy occlusion are found (YuNet is tolerant) but recognised
  poorly. Faces under 20 px are dropped. The refinement picks the turn by YuNet's
  score, whose margins are small (0.91 vs 0.94); a wrong pick falls back to a
  slightly tilted crop.
- **Quality numbers** (face `quality`, `sharp`) are heuristics calibrated on a handful
  of pictures; `sharp` also falls with exposure (a picture darkened to 35 % loses
  10-45 points), so read it together with `dark`.
- **Scenes**: SigLIP's per-scene sigmoid values are small with these prompts (a clear
  beach ≈ 0.01); see `docs/PHOTO-BRAIN.md` for using logits or a softmax over the
  vocabulary. The vocabulary was checked on ~20 pictures only.
- **Recogniser choice** is open: the comparison above is 33 faces of public figures,
  mostly in official portraits; the household's own labelled faces decide.
- **q4 vs fp16**: the default q4 embedding moves picture-to-picture cosines by up to
  0.1 compared with full precision; thresholds tuned on one must not be reused on the
  other (a different `ModelIds::embed` forces recomputation anyway).
