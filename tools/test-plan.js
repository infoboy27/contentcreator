// Uso: docker exec [-e HYBRID=1] contentcreator-site node /app/tools/test-plan.js "GENERAR VIDEO PELICULAS 2"
// Prueba rapida: solo guion + voz (sin imagenes) con IA local.
const fs = require('fs');
const path = require('path');
const { parseVideoCommand, generateQualifiedVideoPlan } = require('/app/server.js');
(async () => {
  for (const command of process.argv.slice(2)) {
    const parsed = parseVideoCommand(command);
    const workDir = process.env.KEEP_DIR || fs.mkdtempSync('/tmp/plan-'); fs.mkdirSync(workDir, { recursive: true });
    try {
      const r = await generateQualifiedVideoPlan({ destination: parsed.destination, idea: parsed.idea, generationVersion: 1, workDir, forceLocal: process.env.HYBRID !== '1' });
      console.log('OK', command, '| guion', r.scriptModel, '| dir', workDir, '| intento', r.scriptAttempt, '| voz', r.speechDuration.toFixed(1), 's | cita', r.bibleReference, r.bibleReferenceInserted ? '(insertada)' : '');
      console.log('   HOOK:', r.hook);
      console.log('   ' + r.scenes.map((s) => s.narration).join('\n   '));
    } catch (e) { console.log('FAIL', command, e.message); }
  }
})();
