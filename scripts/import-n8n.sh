#!/bin/bash
# Importa los workflows de n8n/workflows, activa los que deben correr y registra el webhook del bot de Telegram.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
STACK="$ROOT/scripts/stack.sh"
env_value() { grep -E "^$1=" "$ROOT/.env" | cut -d= -f2- || true; }

# Los mismos que están activos en el servidor de referencia.
ACTIVE=(contentCreatorTelegramRouter01 contentGrowthTelegramDaily01 errorNotifierTelegram01 multiplatformContentPlanDaily01 multiplatformVideoTelegram01)

"$STACK" exec -T n8n n8n import:workflow --separate --input=/workflows
for id in "${ACTIVE[@]}"; do
  "$STACK" exec -T n8n n8n update:workflow --id="$id" --active=true
done
"$STACK" restart n8n

TOKEN=$(env_value TELEGRAM_BOT_TOKEN)
PUBLIC=$(env_value N8N_PUBLIC_URL)
if [ -n "$TOKEN" ] && [ -n "$PUBLIC" ]; then
  echo "Registrando el webhook de Telegram en $PUBLIC…"
  curl -fsS "https://api.telegram.org/bot${TOKEN}/setWebhook" \
    --data-urlencode "url=${PUBLIC%/}/webhook/contentcreator-telegram-command" \
    -d 'allowed_updates=["message"]' | sed 's/^/  /'
  echo
else
  echo "Falta TELEGRAM_BOT_TOKEN o N8N_PUBLIC_URL en .env: el webhook de Telegram no se registró."
fi
