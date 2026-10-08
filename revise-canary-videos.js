const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dataRoot = process.env.CONTENTCREATOR_DATA_DIR || '/app/data';
const generatedRoot = path.join(dataRoot, 'generated-videos');
const contentItemsPath = path.join(dataRoot, 'content-items.json');
const contentHistoryPath = path.join(dataRoot, 'content-history.json');
const openaiApiKey = process.env.OPENAI_API_KEY || '';
const contentIds = process.argv.slice(2).map((value) => value.trim().toUpperCase()).filter(Boolean);

if (!contentIds.length) throw new Error('Provide at least one VID content ID.');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function findVideo(contentId) {
  for (const entry of fs.readdirSync(generatedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(generatedRoot, entry.name);
    const metadataPath = path.join(dir, 'metadata.json');
    const metadata = readJson(metadataPath);
    if (metadata?.contentId === contentId) {
      return {
        dir,
        metadataPath,
        metadata,
        outputPath: path.join(generatedRoot, metadata.fileName),
      };
    }
  }
  throw new Error(`Video not found: ${contentId}`);
}

function secondsToAssTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const cs = centiseconds % 100;
  const totalSeconds = Math.floor(centiseconds / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function splitScript(script) {
  const sentences = String(script)
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = [];
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    let current = [];
    for (const word of words) {
      const candidate = [...current, word].join(' ');
      if (current.length && (candidate.length > 44 || current.length >= 7)) {
        chunks.push(current.join(' '));
        current = [word];
      } else {
        current.push(word);
      }
    }
    if (current.length) chunks.push(current.join(' '));
  }
  return chunks;
}

function wrapSubtitle(text, maxLen = 24) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.join(' ').length <= maxLen) return words.join(' ');
  let best = [words.join(' '), ''];
  let bestDifference = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const first = words.slice(0, index).join(' ');
    const second = words.slice(index).join(' ');
    const difference = Math.abs(first.length - second.length);
    if (difference < bestDifference) {
      best = [first, second];
      bestDifference = difference;
    }
  }
  return best.filter(Boolean).join('\\N');
}

function writeSubtitles(file, script, duration) {
  const lines = splitScript(script);
  const weights = lines.map((line) => Math.max(24, line.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  const events = lines.map((line, index) => {
    const start = elapsed;
    elapsed += duration * (weights[index] / totalWeight);
    const end = index === lines.length - 1 ? duration : elapsed;
    return `Dialogue: 0,${secondsToAssTime(start)},${secondsToAssTime(end)},Default,,0,0,0,,${wrapSubtitle(line)}`;
  }).join('\n');
  fs.writeFileSync(file, `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,46,&H00FFFFFF,&H000000FF,&H90000000,&H88000000,1,0,0,0,100,100,0,0,3,2,0,2,110,110,235,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`, { mode: 0o600 });
  return lines.length;
}

function ffmpegPath(file) {
  return String(file).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function ffmpegText(value) {
  return String(value)
    .replace(/\\/g, ' ')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\n/g, ' ');
}

function wrapPlainLines(text, maxLen = 28, maxLines = 3) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLen && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

async function generateSpeech(text, destinationId) {
  if (!openaiApiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openaiApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: text,
      instructions: destinationId === 'fanspeliculas'
        ? 'Habla en espanol latino con energia de presentador de entretenimiento: natural, seguro y conversacional. Marca brevemente cada recomendacion, manten un ritmo agil y pronuncia con claridad los titulos. Evita sonar como anuncio.'
        : 'Habla en espanol latino con tono calmado, pastoral, cercano y esperanzador. Usa pausas naturales, pronunciacion clara y emocion contenida. Evita sonar monotono o exageradamente dramatico.',
      response_format: 'mp3',
    }),
  });
  if (!response.ok) throw new Error(`Speech provider failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function probeDuration(file) {
  const output = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ], { encoding: 'utf8' });
  return Math.max(65, Math.ceil(Number(output.trim()) || 65));
}

function probeQuality(file) {
  const output = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate',
    '-show_entries', 'format=duration,size',
    '-of', 'json',
    file,
  ], { encoding: 'utf8' });
  const probe = JSON.parse(output);
  const stream = probe.streams?.[0] || {};
  const quality = {
    width: stream.width,
    height: stream.height,
    frame_rate: stream.r_frame_rate,
    duration: Number(probe.format?.duration || 0),
    bytes: Number(probe.format?.size || 0),
    passed: true,
  };
  if (quality.width !== 1080 || quality.height !== 1920 || quality.duration < 61 || quality.bytes < 500_000) {
    throw new Error('Revised video failed quality validation.');
  }
  return quality;
}

async function revise(candidate, quarantineRoot) {
  const { metadata } = candidate;
  const correctedScript = String(metadata.script)
    .replace(/\bestá noche\b/g, 'esta noche')
    .replace(/\bcómo una\b/g, 'como una');
  const audioPath = path.join(candidate.dir, 'voice.mp3');
  if (metadata.destinationId === 'religioso' && correctedScript !== metadata.script) {
    fs.writeFileSync(
      audioPath,
      await generateSpeech(correctedScript, metadata.destinationId),
      { mode: 0o600 },
    );
  }
  const duration = probeDuration(audioPath);
  const assPath = path.join(candidate.dir, 'subs.ass');
  const subtitleEvents = writeSubtitles(assPath, correctedScript, duration);
  const visualPath = path.join(candidate.dir, 'visual.mp4');
  const revisedPath = path.join(candidate.dir, 'revised-output.mp4');
  const titleFilters = wrapPlainLines(metadata.title, 28, 3).map((line, index) => (
    `drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf:text='${ffmpegText(line)}':x=70:y=${190 + index * 62}:fontsize=44:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14:enable='between(t\\,0\\,6)'`
  ));
  const filter = [
    'drawbox=x=0:y=0:w=1080:h=1920:color=black@0.08:t=fill',
    `drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf:text='${ffmpegText(metadata.displayBrand)}':x=58:y=72:fontsize=34:fontcolor=white@0.95:box=1:boxcolor=black@0.42:boxborderw=12`,
    ...titleFilters,
    `ass=${ffmpegPath(assPath)}`,
    'format=yuv420p',
  ].join(',');
  execFileSync('ffmpeg', [
    '-y',
    '-i', visualPath,
    '-i', audioPath,
    '-vf', filter,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '19',
    '-maxrate', '8M',
    '-bufsize', '16M',
    '-pix_fmt', 'yuv420p',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-t', String(duration),
    revisedPath,
  ], { stdio: 'pipe' });
  const quality = probeQuality(revisedPath);
  fs.mkdirSync(quarantineRoot, { recursive: true });
  fs.copyFileSync(candidate.outputPath, path.join(quarantineRoot, `${metadata.fileName}.before-revision`));
  fs.copyFileSync(candidate.metadataPath, path.join(quarantineRoot, `${path.basename(candidate.dir)}-metadata.before.json`));
  fs.renameSync(revisedPath, candidate.outputPath);
  const nextMetadata = {
    ...metadata,
    script: correctedScript,
    duration,
    quality,
    subtitle_events: subtitleEvents,
    subtitle_version: 2,
    revised_at: new Date().toISOString(),
  };
  delete nextMetadata.telegram_sent_at;
  writeJson(candidate.metadataPath, nextMetadata);
  return {
    contentId: metadata.contentId,
    destinationId: metadata.destinationId,
    fileName: metadata.fileName,
    subtitleEvents,
    duration,
    quality,
    revised_at: nextMetadata.revised_at,
  };
}

(async () => {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const quarantineRoot = path.join(dataRoot, 'quarantine', `video-revisions-${stamp}`);
  const results = [];
  for (const contentId of contentIds) {
    results.push(await revise(findVideo(contentId), quarantineRoot));
  }
  const items = readJson(contentItemsPath, []);
  for (const result of results) {
    const item = items.find((candidate) => candidate.contentId === result.contentId);
    if (!item) continue;
    delete item.telegram_sent_at;
    if (item.status !== 'published' && !item.published_at) item.status = 'preview_ready';
    item.updated_at = new Date().toISOString();
  }
  writeJson(contentItemsPath, items);
  const history = readJson(contentHistoryPath, []);
  for (const result of results) {
    history.unshift({
      type: 'video_preview_revised',
      contentId: result.contentId,
      destinationId: result.destinationId,
      fileName: result.fileName,
      subtitleVersion: 2,
      created_at: result.revised_at,
    });
  }
  writeJson(contentHistoryPath, history.slice(0, 500));
  console.log(JSON.stringify({ ok: true, quarantineRoot, results }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
