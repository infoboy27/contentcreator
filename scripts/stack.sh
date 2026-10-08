#!/bin/bash
# Atajo de docker compose para el stack completo: usa el .env del repo y el override de NVIDIA si GPU_VENDOR=nvidia.
# Ejemplos: scripts/stack.sh up -d · scripts/stack.sh logs -f contentcreator · scripts/stack.sh --profile tunnel up -d
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
GPU_VENDOR=$(grep -E '^GPU_VENDOR=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)
FILES=(-f "$ROOT/stack/docker-compose.yml")
[ "${GPU_VENDOR:-amd}" = nvidia ] && FILES+=(-f "$ROOT/stack/docker-compose.nvidia.yml")
exec docker compose --env-file "$ROOT/.env" --project-directory "$ROOT/stack" "${FILES[@]}" "$@"
