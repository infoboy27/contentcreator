#!/bin/bash
# Prepara los modelos dentro de los contenedores (con el stack ya levantado):
# - Ollama: qwen3.5:9b con num_predict 8192, para que ninguna respuesta bloquee el único slot.
# - speaches: voz Piper es_MX "claude" y Whisper large-v3-turbo para los subtítulos.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
STACK="$ROOT/scripts/stack.sh"
MODEL=$(grep -E '^OLLAMA_SCRIPT_MODEL=' "$ROOT/.env" | cut -d= -f2- || true)
MODEL=${MODEL:-qwen3.5:9b}

echo "Ollama: descargando $MODEL…"
"$STACK" exec -T ollama ollama pull "$MODEL"
"$STACK" exec -T ollama sh -c "printf 'FROM %s\nPARAMETER num_predict 8192\n' '$MODEL' > /tmp/Modelfile && ollama create '$MODEL' -f /tmp/Modelfile"

for model in speaches-ai/piper-es_MX-claude-high deepdml/faster-whisper-large-v3-turbo-ct2; do
  echo "speaches: instalando $model…"
  "$STACK" exec -T contentcreator node -e "
    fetch('http://speaches:8000/v1/models/' + process.argv[1], { method: 'POST' })
      .then(async (r) => { console.log(r.status, (await r.text()).slice(0, 200)); if (!r.ok && r.status !== 409) process.exit(1); });
  " "$model"
done
echo "Modelos de IA listos."
