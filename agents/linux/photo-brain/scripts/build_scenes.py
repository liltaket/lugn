#!/usr/bin/env python3
"""Builds data/photo-scenes*.json from data/photo-scenes.source.json with the
SigLIP 2 TEXT tower, so the photo brain needs only the image tower at run time.

Run through build-scenes.sh (it makes a throw-away venv). By hand:

    python build_scenes.py --model so400m [--text int8|fp32] [--cache DIR]

The fp16 text tower is the default: on base it gives the same vectors as fp32
(checked with --dump), while the int8 one is visibly off. Each scene's vector is the normalised mean of its prompts' unit-length text
embeddings. Prompts are lowercased and tokenised with the model's Gemma
tokenizer exactly as SigLIP 2 was trained: <eos> appended, right-padded with
<pad> to the fixed length 64 (the text pooler reads the last position, so the
padding is part of the model's input contract).

Output (schema 2): {"schema": 2, "model", "embedIds", "dim", "kind": "sigmoid",
"scale", "bias", "encoding": "f16", "scenes": [{"key", "sv", "junk"?, "vector"}]}
where vector is base64 of little-endian IEEE half floats. A picture's
probability for a scene is sigmoid(scale * cos(picture, vector) + bias).
"""
import argparse, base64, hashlib, json, pathlib, sys, urllib.request

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[3]

# Pinned to the same commits as src/infer/models.toml. `scale` = exp(logit_scale)
# and `bias` = logit_bias, read from the full model's ONNX graph (model.onnx:
# the Mul by the folded Exp constant and the Add before logits_per_text);
# `--verify-logits` re-reads them.
MODELS = {
    "so400m": {
        "hf": "google/siglip2-so400m-patch16-384",
        "repo": "onnx-community/siglip2-so400m-patch16-384-ONNX",
        "commit": "29f74e673c298fd07482d8e20138179282001eb7",
        "embed_ids": ["siglip2-so400m-patch16-384-q4", "siglip2-so400m-patch16-384-fp16", "siglip2-so400m-patch16-384-int8"],
        "dim": 1152,
        "scale": 109.85502624511719,
        "bias": -15.932409286499023,
        "out": "photo-scenes.json",
        "full": "8be7cd1cc62dd1281d7874ba1ee5b3fbba006d5d5283d7ae194518c500294caa",  # model.onnx, 1.2 MB
        "text": {
            "int8": ("onnx/text_model_int8.onnx", "96bb04c4987f7e0d35ae64c4ef1a3121f833c2d0ad95faaae223c59dbbdd639c"),
            "fp16": ("onnx/text_model_fp16.onnx", "6aed8a7f6fbfbbc1464e57ac7dc3582557bd9da8d7abe761163e2eaf7ad66994"),
            "fp32": ("onnx/text_model.onnx", "1be6a35f94aa0d1aa15024569ccb7637c7157809624922e50e22d746d43745a5"),
        },
        "fp32_data": ("onnx/text_model.onnx_data", "80d50b22c6a56758717e6acdbf03f3e564b3a701d152b6741d8b62181cae7983"),
    },
    "base": {
        "hf": "google/siglip2-base-patch16-384",
        "repo": "onnx-community/siglip2-base-patch16-384-ONNX",
        "commit": "99f5d40afb5331b81eecee4bb02c360fbb9cdf8a",
        "embed_ids": ["siglip2-base-patch16-384-fp32", "siglip2-base-patch16-384-fp16", "siglip2-base-patch16-384-int8"],
        "dim": 768,
        "scale": 112.84600830078125,
        "bias": -16.77224349975586,
        "out": "photo-scenes.siglip2-base.json",
        "full": "4d9c77de445c705c7ce0bd692139af1912f86b07dde1a2972ca6752ad2df5aae",  # model.onnx, 1.5 GB
        "text": {
            "int8": ("onnx/text_model_int8.onnx", "30a94b43b9ddc39c04ab67f80cba4b808262682b2fa1a2a8b924bf1e7bd84c61"),
            "fp16": ("onnx/text_model_fp16.onnx", "70fc4406fb2972672aacfc9e32855ff676fda25c031b9c99429746d53a438cfa"),
            "fp32": ("onnx/text_model.onnx", "d28c21c7f12c38b0ec43aacb7ce2228fba6bd6b20641802ef2b29809ece46af8"),
        },
    },
}
TOKENIZER = ("tokenizer.json", "cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322")
MAX_LEN, PAD_ID, EOS_ID = 64, 0, 1


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(spec, name, digest, cache):
    target = cache / spec["repo"].replace("/", "__") / name
    if target.is_file() and sha256(target) == digest:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://huggingface.co/{spec['repo']}/resolve/{spec['commit']}/{name}"
    print(f"downloading {url}", file=sys.stderr)
    part = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "lugn-scene-builder"})) as r, open(part, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    if sha256(part) != digest:
        part.unlink()
        sys.exit(f"{name}: checksum mismatch")
    part.rename(target)
    return target


def tokenizer(path):
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(str(path))
    tok.enable_truncation(MAX_LEN)
    tok.enable_padding(length=MAX_LEN, pad_id=PAD_ID, pad_token="<pad>", direction="right")
    return tok


def encode(tok, texts):
    ids = []
    for text in texts:
        enc = tok.encode(text.lower())
        row = enc.ids
        assert len(row) == MAX_LEN and EOS_ID in row, row
        ids.append(row)
    return np.array(ids, dtype=np.int64)


def text_embeddings(session, ids):
    out = []
    for row in ids:  # one at a time: bounded memory
        (pooled,) = session.run(["pooler_output"], {"input_ids": row[None, :]})
        v = pooled[0].astype(np.float64)
        out.append(v / np.linalg.norm(v))
    return np.stack(out)


def verify_logits(spec, cache):
    """Reads exp(logit_scale) and logit_bias from the full model's graph."""
    import math
    import onnx
    import onnx.numpy_helper as nh
    path = fetch(spec, "onnx/model.onnx", spec["full"], cache)
    graph = onnx.load(str(path), load_external_data=False).graph
    inits = {i.name: i for i in graph.initializer}
    producers = {o: n for n in graph.node for o in n.output}
    add = next(n for n in graph.node if n.op_type == "Add" and "logits_per_text" in n.output)
    mul = producers[add.input[0]]
    # The scale is either the folded exp(logit_scale) constant or Exp(logit_scale).
    scale = None
    for name in mul.input:
        if name in inits and inits[name].dims in ([], [1]):
            scale = float(nh.to_array(inits[name]).ravel()[0])
        elif name in producers and producers[name].op_type == "Exp":
            scale = math.exp(float(nh.to_array(inits[producers[name].input[0]]).ravel()[0]))
    if scale is None:
        sys.exit("could not find the logit scale in model.onnx")
    bias = float(nh.to_array(inits[add.input[1]]).ravel()[0])
    return scale, bias


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=MODELS, required=True)
    # int8 text towers are measurably off (base: per-scene cosine to fp32 0.907-0.99);
    # fp16 matches fp32 on the CPU provider.
    ap.add_argument("--text", choices=["fp16", "fp32", "int8"], default="fp16")
    ap.add_argument("--cache", type=pathlib.Path, default=pathlib.Path.home() / ".cache/lugn-photo-brain/scene-build")
    ap.add_argument("--source", type=pathlib.Path, default=REPO / "data/photo-scenes.source.json")
    ap.add_argument("--out", type=pathlib.Path)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--dump", type=pathlib.Path, help="also write the float32 vectors (.npy) for checks")
    ap.add_argument("--verify-logits", action="store_true", help="re-read scale and bias from the full model (base: 1.5 GB download)")
    args = ap.parse_args()
    spec = MODELS[args.model]
    if args.verify_logits:
        scale, bias = verify_logits(spec, args.cache)
        print(f"model.onnx: scale {scale} bias {bias}; pinned: scale {spec['scale']} bias {spec['bias']}", file=sys.stderr)
        if abs(scale - spec["scale"]) > 1e-3 or abs(bias - spec["bias"]) > 1e-3:
            sys.exit("the pinned scale/bias differ from the model")

    import onnxruntime as ort
    tok = tokenizer(fetch(spec, *TOKENIZER, args.cache))
    name, digest = spec["text"][args.text]
    model = fetch(spec, name, digest, args.cache)
    if args.text == "fp32" and "fp32_data" in spec:
        fetch(spec, *spec["fp32_data"], args.cache)
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.enable_cpu_mem_arena = False
    session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])

    source = json.loads(args.source.read_text())
    scenes, dumped = [], []
    for scene in source["scenes"]:
        vectors = text_embeddings(session, encode(tok, scene["prompts"]))
        mean = vectors.mean(axis=0)
        mean /= np.linalg.norm(mean)
        dumped.append(mean)
        entry = {"key": scene["key"], "sv": scene["sv"]}
        if scene.get("junk"):
            entry["junk"] = scene["junk"]
        entry["vector"] = base64.b64encode(mean.astype("<f2").tobytes()).decode()
        scenes.append(entry)
    doc = {
        "schema": 2,
        "model": spec["hf"],
        "embedIds": spec["embed_ids"],
        "text": f"{spec['repo']}@{spec['commit'][:12]} {name}",
        "dim": spec["dim"],
        "kind": "sigmoid",
        "scale": spec["scale"],
        "bias": spec["bias"],
        "encoding": "f16",
        "scenes": scenes,
    }
    out = args.out or REPO / "data" / spec["out"]
    # Indented like the repository's Prettier formatting, so `npm run format:check` passes.
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    if args.dump:
        np.save(args.dump, np.stack(dumped).astype(np.float32))
    print(f"wrote {len(scenes)} scenes to {out} ({out.stat().st_size} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
