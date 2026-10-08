#!/bin/sh
# Borra los videos de prueba viejos de data/test-videos (los crea Studio y tools/test-video.js).
# Uso: limpieza-pruebas.sh [dias] [--dry-run]   (por defecto 7 días)
# - Pruebas terminadas (.mp4 + su carpeta de escenas): se borran pasados [dias].
# - Carpetas sin .mp4 (pruebas que fallaron o se cortaron): se borran pasado 1 día.
DIAS=${1:-7}
SECO=0; [ "$2" = "--dry-run" ] && SECO=1
docker exec -e DIAS="$DIAS" -e SECO="$SECO" contentcreator-site sh -c '
  cd /app/data/test-videos 2>/dev/null || exit 0
  borrar() { echo "  $1"; [ "$SECO" = 1 ] || rm -rf -- "$1"; }
  for f in $(find . -maxdepth 1 -type f -name "*.mp4" -mtime +"$DIAS"); do
    borrar "$f"; [ -d "${f%.mp4}" ] && borrar "${f%.mp4}"
  done
  for d in $(find . -mindepth 1 -maxdepth 1 -type d -mtime +1); do
    [ -f "$d.mp4" ] || borrar "$d"
  done
'
