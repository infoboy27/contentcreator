#!/bin/bash
# Instalación completa en un equipo nuevo (Ubuntu 24.04 + Docker).
# Uso: scripts/install.sh [--video] [--no-models]
#   --video      también descarga los modelos de video Wan2.2 (~8.5 GB extra)
#   --no-models  no descarga modelos (si ya los copiaste a stack/models)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
VIDEO=""
MODELS=1
for arg in "$@"; do
  case "$arg" in
    --video) VIDEO="--video" ;;
    --no-models) MODELS=0 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "Falta '$1'. Instálalo y vuelve a correr el script." >&2; exit 1; }; }

step "Comprobando requisitos"
need docker
need curl
docker compose version >/dev/null || { echo "Falta el plugin docker compose." >&2; exit 1; }
FREE_GB=$(df -BG --output=avail "$ROOT" | tail -1 | tr -dc 0-9)
NEEDED=$([ -n "$VIDEO" ] && echo 35 || echo 25)
if [ "$FREE_GB" -lt "$NEEDED" ]; then
  echo "Aviso: hay ${FREE_GB} GB libres y se recomiendan ${NEEDED} GB (modelos + imágenes Docker)."
fi

if [ -e /dev/kfd ]; then VENDOR=amd
elif command -v nvidia-smi >/dev/null; then VENDOR=nvidia
else
  echo "No encontré una GPU AMD (/dev/kfd) ni NVIDIA (nvidia-smi)." >&2
  exit 1
fi
echo "GPU detectada: $VENDOR"

step "Preparando .env"
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  rand() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  sed -i "s|^STUDIO_PASSWORD=.*|STUDIO_PASSWORD=$(rand 10)|" .env
  sed -i "s|^CONTENTCREATOR_INTERNAL_TOKEN=.*|CONTENTCREATOR_INTERNAL_TOKEN=$(rand 24)|" .env
  sed -i "s|^N8N_ENCRYPTION_KEY=.*|N8N_ENCRYPTION_KEY=$(rand 24)|" .env
  sed -i "s|^GPU_VENDOR=.*|GPU_VENDOR=$VENDOR|" .env
  sed -i "s|^VIDEO_GID=.*|VIDEO_GID=$(getent group video | cut -d: -f3 || echo 44)|" .env
  sed -i "s|^RENDER_GID=.*|RENDER_GID=$(getent group render | cut -d: -f3 || echo 991)|" .env
  if [ "$VENDOR" = amd ] && ! grep -qiE 'gfx1031|6700 XT|6750 XT' <(cat /sys/class/drm/card*/device/product_name 2>/dev/null; lspci 2>/dev/null); then
    sed -i "s|^HSA_OVERRIDE_GFX_VERSION=.*|HSA_OVERRIDE_GFX_VERSION=|" .env
  fi
  echo "Creé .env con claves nuevas. Completa OPENAI_API_KEY, YOUTUBE_*, TELEGRAM_* y las URLs públicas."
else
  echo ".env ya existe; no lo toco."
fi
mkdir -p data

if [ "$MODELS" = 1 ]; then
  step "Descargando modelos de imagen${VIDEO:+ y video}"
  scripts/download-models.sh $VIDEO "$ROOT/stack/models"
fi

step "Construyendo y levantando el stack"
scripts/stack.sh build sdcpp
scripts/stack.sh up -d ollama speaches sdcpp contentcreator n8n
grep -qE '^CLOUDFLARE_TUNNEL_TOKEN=.+' .env && scripts/stack.sh --profile tunnel up -d cloudflared

step "Esperando a que ContentCreator arranque"
for _ in $(seq 1 60); do
  scripts/stack.sh logs contentcreator 2>/dev/null | grep -q listening && break
  sleep 3
done

step "Instalando modelos de IA (qwen, voz y Whisper)"
scripts/setup-ai.sh

step "Importando los workflows de n8n"
sleep 10
scripts/import-n8n.sh || echo "No se pudieron importar los workflows; repite con scripts/import-n8n.sh"

if [ "$VENDOR" = amd ]; then
  step "Curva de ventiladores (opcional, requiere sudo)"
  read -r -p "¿Instalar la curva agresiva de ventiladores para la GPU? [s/N] " answer
  if [[ "$answer" =~ ^[sS] ]]; then
    sudo install -m 755 scripts/gpu-fan-curve.sh /usr/local/sbin/gpu-fan-curve.sh
    sudo install -m 644 scripts/gpu-fan-curve.service /etc/systemd/system/gpu-fan-curve.service
    sudo systemctl daemon-reload && sudo systemctl enable --now gpu-fan-curve
  fi
fi

step "Listo"
cat <<EOF
Studio local:  http://127.0.0.1:3000/studio
Clave:         grep STUDIO_PASSWORD .env
n8n local:     http://127.0.0.1:5678 (crea tu usuario la primera vez)

Pendiente (ver README):
  1. Exponer Studio y n8n con Cloudflare Tunnel (CLOUDFLARE_TUNNEL_TOKEN) y poner las URLs en .env.
  2. Google Cloud: OAuth client con redirect \${APP_BASE_URL}/youtube/callback y la app "In production".
  3. Studio → Canales → Conectar cada canal de YouTube.
EOF
