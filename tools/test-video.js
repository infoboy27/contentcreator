// Uso: docker exec contentcreator-site node /app/tools/test-video.js "GENERAR VIDEO RELIGIOSO 1"
// LOOK=1 y CLIPS=1 fuerzan el look cine y los clips reales solo en esta prueba (sin tocar los ajustes).
// HYBRID=1 usa el proveedor de guion configurado (OpenAI); sin el, todo es local.
// Prueba: genera videos 100% con IA local, sin publicar ni registrar en la cola de aprobacion.
// Uso: node /app/data/test-local-video.js "GENERAR VIDEO RELIGIOSO 1" [...]
const { parseVideoCommand, renderAutomatedVideo } = require('/app/server.js');

(async () => {
  for (const command of process.argv.slice(2)) {
    try {
      const parsed = parseVideoCommand(command);
      const result = await renderAutomatedVideo({ ...parsed, generationVersion: 1, test: true, forceLocal: process.env.HYBRID !== '1',
        ...(process.env.LOOK ? { cinematicLook: process.env.LOOK === '1' } : {}),
        ...(process.env.CLIPS ? { realClips: process.env.CLIPS === '1' } : {}),
      });
      console.log('RESULT', JSON.stringify({ command, file: result.fileName, duration: result.duration, render_seconds: result.render_seconds, providers: result.ai_providers, attempt: result.script_attempt }));
    } catch (error) {
      console.log('FAILED', command, error.code || '', error.message, error.stderr ? String(error.stderr).slice(-800) : '');
    }
  }
})();
