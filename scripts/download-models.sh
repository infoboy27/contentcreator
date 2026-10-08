#!/bin/bash
# Descarga los modelos de imagen (~6.7 GB) y, con --video, los de video (~8.5 GB).
# Reanuda descargas cortadas. Uso: scripts/download-models.sh [--video] [carpeta]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VIDEO=0
DEST="$ROOT/stack/models"
for arg in "$@"; do
  case "$arg" in
    --video) VIDEO=1 ;;
    *) DEST="$arg" ;;
  esac
done
mkdir -p "$DEST/video"

get() {
  local url=$1 out=$2
  if [ -s "$out" ] && [ ! -f "$out.part" ]; then echo "ya existe: $(basename "$out")"; return; fi
  echo "descargando $(basename "$out")…"
  touch "$out.part"
  curl -fL --retry 5 -C - -o "$out" "$url"
  rm -f "$out.part"
}

HF=https://huggingface.co
get "$HF/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q4_K.gguf" "$DEST/z_image_turbo-Q4_K.gguf"
get "$HF/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf" "$DEST/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
get "$HF/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors" "$DEST/ae.safetensors"

if [ "$VIDEO" = 1 ]; then
  get "$HF/QuantStack/Wan2.2-TI2V-5B-GGUF/resolve/main/Wan2.2-TI2V-5B-Q4_K_M.gguf" "$DEST/video/Wan2.2-TI2V-5B-Q4_K_M.gguf"
  get "$HF/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q4_K_M.gguf" "$DEST/video/umt5-xxl-encoder-Q4_K_M.gguf"
  get "$HF/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors" "$DEST/video/wan2.2_vae.safetensors"
fi
echo "Modelos listos en $DEST"
