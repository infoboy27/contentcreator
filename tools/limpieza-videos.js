// Borra el MP4 y las escenas de los videos ya publicados o rechazados hace mas de N dias.
// Conserva metadata.json (historial y chequeo de "ya publicado"). Los pendientes de aprobar no se tocan.
// Uso: docker exec contentcreator-site node /app/tools/limpieza-videos.js [dias] [--dry-run]
const fs = require('fs');
const path = require('path');

const dias = Number(process.argv[2] || 7);
const seco = process.argv.includes('--dry-run');
const dir = '/app/data/generated-videos';
const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
const items = JSON.parse(fs.readFileSync('/app/data/content-items.json', 'utf8'));

for (const nombre of fs.readdirSync(dir).filter((n) => !n.endsWith('.mp4'))) {
  const carpeta = path.join(dir, nombre);
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(carpeta, 'metadata.json'), 'utf8'));
  } catch {
    continue;
  }
  const item = items.find((candidate) => candidate.contentId === metadata.contentId);
  if (!item || !['published', 'rejected'].includes(item.status)) continue;
  const fecha = Date.parse(item.published_at || item.updated_at || '');
  if (!fecha || fecha > limite) continue;

  const archivos = [`${carpeta}.mp4`, ...fs.readdirSync(carpeta).filter((n) => n !== 'metadata.json').map((n) => path.join(carpeta, n))]
    .filter((archivo) => fs.existsSync(archivo));
  if (!archivos.length) continue;
  console.log(`  ${item.status} ${metadata.contentId} (${nombre}): ${archivos.length} archivos`);
  if (!seco) for (const archivo of archivos) fs.rmSync(archivo, { force: true });
}
