#!/usr/bin/env bash
# Downloads the Whisper-tiny.en model into tests/local-assets so the opt-in
# `?whisper=1` inference test can run offline. Not needed for the app itself —
# the app downloads the model from Hugging Face at runtime.
set -euo pipefail
BASE="https://huggingface.co/Xenova/whisper-tiny.en/resolve/main"
DEST="$(dirname "$0")/local-assets/models/Xenova/whisper-tiny.en"
mkdir -p "$DEST/onnx"
for f in config.json tokenizer.json tokenizer_config.json preprocessor_config.json generation_config.json; do
  echo "→ $f"; curl -sSL -o "$DEST/$f" "$BASE/$f"
done
for f in onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx; do
  echo "→ $f"; curl -sSL -o "$DEST/$f" "$BASE/$f"
done
echo "Done. Run: npm run dev  then open /tests/harness.html?whisper=1"
