const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

const publicDir = path.join(__dirname, 'public');
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const appBaseUrl = (process.env.APP_BASE_URL || 'https://contentcreator.jfmcss.com').replace(/\/+$/, '');
const clientId = process.env.YOUTUBE_CLIENT_ID || '';
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || '';
const internalToken = process.env.CONTENTCREATOR_INTERNAL_TOKEN || '';
const tiktokClientKey = process.env.TIKTOK_CLIENT_KEY || '';
const tiktokClientSecret = process.env.TIKTOK_CLIENT_SECRET || '';
const openaiApiKey = process.env.OPENAI_API_KEY || '';
const openaiScriptModel = process.env.OPENAI_SCRIPT_MODEL || 'gpt-5.6-terra';
const minimumNarrationSeconds = 60;
const maximumNarrationSeconds = 95;
const minimumVideoSeconds = 61;
const minimumScriptWords = 165;
const maximumScriptWords = 210;
const facebookRewardsBaseUrl = (process.env.FACEBOOKREWARDS_BASE_URL || 'https://facebookrewards.jfmcss.com').replace(/\/+$/, '');
const facebookPublishingEnabled = !['0', 'false', 'off', 'disabled'].includes(
  String(process.env.FACEBOOK_PUBLISHING_ENABLED || 'true').trim().toLowerCase(),
);
const tokenPath = path.join(dataDir, 'youtube-token.json');
const youtubeChannelsDir = path.join(dataDir, 'youtube-channels');
const statePath = path.join(dataDir, 'youtube-oauth-states.json');
const tiktokTokenPath = path.join(dataDir, 'tiktok-token.json');
// Ideas del dia generadas por la IA local (se preparan por adelantado; si falla se usan las listas fijas).
const aiIdeasPath = path.join(dataDir, 'ai-ideas.json');
const ideasProvider = String(process.env.IDEAS_PROVIDER || 'local').trim().toLowerCase();
// Flujo de n8n que reenvia avisos al chat de Telegram (el token del bot solo vive en n8n).
const telegramNotifyUrl = process.env.TELEGRAM_NOTIFY_URL || 'http://n8n:5678/webhook/contentcreator-notify';
const publishLogPath = path.join(dataDir, 'publish-log.json');
const videoPublishLogPath = path.join(dataDir, 'video-publish-log.json');
const contentHistoryPath = path.join(dataDir, 'content-history.json');
const contentItemsPath = path.join(dataDir, 'content-items.json');
const serviceStatusPath = path.join(dataDir, 'service-status.json');
const commandEventsDir = path.join(dataDir, 'command-events');
const generationLocksDir = path.join(dataDir, 'generation-locks');
const blockedTextFragment = ['mone', 'tiz'].join('');

const youtubeChannels = {
  vida_con_dios: {
    label: 'Vida con Dios',
    expectedChannelId: 'UCovpMO9c4wYi-mimH1wP5ow',
    legacyTokenPath: tokenPath,
  },
  fans_peliculas_novelas: {
    label: 'Fans Peliculas y Novelas',
    expectedChannelId: 'UCstUY6maRctellf3dtYcXQg',
  },
};

const defaultYouTubeChannelKey = 'vida_con_dios';

fs.mkdirSync(dataDir, { recursive: true });

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'content-type': type,
    'content-length': buffer.length,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}

function json(res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function assertAllowedText(...values) {
  for (const value of values.flat(Infinity)) {
    if (normalizeContentKey(value).includes(blockedTextFragment)) {
      const error = new Error('El contenido contiene un termino operativo prohibido.');
      error.code = 'FORBIDDEN_CONTENT_TERM';
      throw error;
    }
  }
}

function contentItemId(prefix) {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}`.toUpperCase();
}

function readContentItems() {
  return readJson(contentItemsPath, []);
}

function upsertContentItem(item) {
  const items = readContentItems();
  const index = items.findIndex((candidate) => candidate.contentId === item.contentId);
  const next = {
    ...(index >= 0 ? items[index] : {}),
    ...item,
    updated_at: new Date().toISOString(),
  };
  if (!next.created_at) next.created_at = next.updated_at;
  if (index >= 0) items[index] = next;
  else items.unshift(next);
  writeJson(contentItemsPath, items.slice(0, 1000));
  return next;
}

function findContentItem(contentId) {
  const normalized = String(contentId || '').trim().toUpperCase();
  return readContentItems().find((item) => item.contentId === normalized) || null;
}

function setServiceStatus(service, status, details = {}) {
  const current = readJson(serviceStatusPath, {});
  current[service] = {
    status,
    ...details,
    checked_at: new Date().toISOString(),
  };
  writeJson(serviceStatusPath, current);
}

function contentIdFromCommand(command, prefix = null) {
  const matches = String(command || '').toUpperCase().match(/\b(?:VID|PST)-\d{14}-[A-F0-9]{6}\b/g) || [];
  return matches.find((value) => !prefix || value.startsWith(`${prefix}-`)) || null;
}

function acquireGenerationLock(destinationId, contentKey) {
  fs.mkdirSync(generationLocksDir, { recursive: true });
  const key = crypto.createHash('sha256').update(`${destinationId}:${contentKey}`).digest('hex');
  const file = path.join(generationLocksDir, `${key}.lock`);
  try {
    const existing = fs.statSync(file);
    if (Date.now() - existing.mtimeMs > 30 * 60 * 1000) fs.unlinkSync(file);
  } catch {}
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({
      destinationId,
      contentKey,
      created_at: new Date().toISOString(),
    }));
    fs.closeSync(fd);
    return file;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const locked = new Error('Este tema ya se esta generando. Espera el preview existente.');
    locked.code = 'GENERATION_IN_PROGRESS';
    throw locked;
  }
}

function releaseGenerationLock(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRequestBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function resolveYouTubeChannelKey(value) {
  const key = String(value || defaultYouTubeChannelKey)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return youtubeChannels[key] ? key : defaultYouTubeChannelKey;
}

function youtubeTokenPathForChannel(channelKey = defaultYouTubeChannelKey) {
  const key = resolveYouTubeChannelKey(channelKey);
  const config = youtubeChannels[key];
  return config.legacyTokenPath || path.join(youtubeChannelsDir, `${key}.json`);
}

function readYouTubeToken(channelKey = defaultYouTubeChannelKey) {
  return readJson(youtubeTokenPathForChannel(channelKey));
}

function writeYouTubeToken(channelKey, token) {
  writeJson(youtubeTokenPathForChannel(channelKey), token);
}

function saveOAuthState(state, channelKey = defaultYouTubeChannelKey) {
  const now = Date.now();
  const states = readJson(statePath, {});
  for (const [key, value] of Object.entries(states)) {
    if (!value?.created_at || now - value.created_at > 30 * 60 * 1000) {
      delete states[key];
    }
  }
  states[state] = { created_at: now, channel_key: resolveYouTubeChannelKey(channelKey) };
  writeJson(statePath, states);
}

function consumeOAuthState(state) {
  const now = Date.now();
  const states = readJson(statePath, {});
  const entry = states[state];
  if (!entry?.created_at || now - entry.created_at > 30 * 60 * 1000) {
    return null;
  }
  delete states[state];
  writeJson(statePath, states);
  return entry;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: `${appBaseUrl}/youtube/callback`,
    grant_type: 'authorization_code',
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Google token exchange failed');
  }
  return payload;
}

async function refreshAccessToken(stored, savePath = tokenPath) {
  if (!stored?.refresh_token) {
    throw new Error('YouTube is not connected');
  }
  if (stored.access_token && stored.expires_at && Date.now() < stored.expires_at - 60_000) {
    return stored;
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: stored.refresh_token,
    grant_type: 'refresh_token',
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json();
  if (!response.ok) {
    if (payload.error === 'invalid_grant') {
      const channelKey = Object.keys(youtubeChannels).find((key) => youtubeTokenPathForChannel(key) === savePath)
        || defaultYouTubeChannelKey;
      const error = new Error(`El permiso de YouTube para ${youtubeChannels[channelKey].label} vencio o fue revocado. Reconecta el canal.`);
      error.code = 'YOUTUBE_RECONNECT_REQUIRED';
      error.channelKey = channelKey;
      error.reconnect_url = `${appBaseUrl}/youtube/start?channel=${channelKey}`;
      throw error;
    }
    throw new Error(payload.error_description || payload.error || 'Google token refresh failed');
  }
  const next = {
    ...stored,
    ...payload,
    refresh_token: stored.refresh_token,
    expires_at: Date.now() + (payload.expires_in || 3600) * 1000,
    updated_at: new Date().toISOString(),
  };
  writeJson(savePath, next);
  return next;
}

// --- TikTok: el video se envia a la bandeja (inbox) de la cuenta; el usuario lo publica desde la app.
// La publicacion directa en publico exige auditoria, y TikTok no la aprueba para herramientas de uso propio.
const tiktokRedirectUri = `${appBaseUrl}/tiktok-callback`;

async function tiktokTokenRequest(params) {
  const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: tiktokClientKey, client_secret: tiktokClientSecret, ...params }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(payload.error_description || payload.error || `TikTok token HTTP ${response.status}`);
    error.code = payload.error === 'invalid_grant' ? 'TIKTOK_RECONNECT_REQUIRED' : 'TIKTOK_TOKEN_FAILED';
    throw error;
  }
  const now = Date.now();
  return {
    ...payload,
    expires_at: now + (payload.expires_in || 86400) * 1000,
    refresh_expires_at: now + (payload.refresh_expires_in || 365 * 86400) * 1000,
    updated_at: new Date(now).toISOString(),
  };
}

async function tiktokAccessToken() {
  const stored = readJson(tiktokTokenPath, null);
  if (!stored?.refresh_token) {
    const error = new Error('TikTok no esta conectado.');
    error.code = 'TIKTOK_NOT_CONNECTED';
    throw error;
  }
  if (stored.access_token && Date.now() < stored.expires_at - 5 * 60_000) return stored;
  try {
    const next = { ...stored, ...(await tiktokTokenRequest({ grant_type: 'refresh_token', refresh_token: stored.refresh_token })) };
    writeJson(tiktokTokenPath, next);
    return next;
  } catch (error) {
    if (error.code === 'TIKTOK_RECONNECT_REQUIRED') error.message = 'El permiso de TikTok vencio o fue revocado. Reconecta TikTok en Studio → Canales.';
    throw error;
  }
}

async function tiktokApi(pathname, accessToken, body) {
  const response = await fetch(`https://open.tiktokapis.com${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json; charset=UTF-8' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (payload.error?.code && payload.error.code !== 'ok')) {
    const error = new Error(`TikTok: ${payload.error?.message || payload.error?.code || `HTTP ${response.status}`}`);
    error.code = payload.error?.code || 'TIKTOK_API_FAILED';
    throw error;
  }
  return payload.data || {};
}

// Sube el MP4 local (FILE_UPLOAD; no requiere verificar dominio) a la bandeja de TikTok.
async function sendVideoToTikTokInbox(filePath) {
  const token = await tiktokAccessToken();
  const size = fs.statSync(filePath).size;
  // TikTok: un solo trozo si pesa hasta 64 MB; si no, trozos de 10 MB (el ultimo absorbe el resto).
  const chunkSize = size <= 64 * 1024 * 1024 ? size : 10 * 1024 * 1024;
  const totalChunks = Math.max(1, Math.floor(size / chunkSize));
  const init = await tiktokApi('/v2/post/publish/inbox/video/init/', token.access_token, {
    source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: totalChunks },
  });
  const file = fs.readFileSync(filePath);
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const end = index === totalChunks - 1 ? size - 1 : start + chunkSize - 1;
    const response = await fetch(init.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
      body: file.subarray(start, end + 1),
    });
    if (!response.ok) throw new Error(`TikTok: la subida del video fallo (HTTP ${response.status}).`);
  }
  return { ok: true, mode: 'inbox', publish_id: init.publish_id, account: token.display_name || null, sent_at: new Date().toISOString(), reason: 'Enviado a tu bandeja de TikTok: abre la notificacion en la app y pulsa Publicar.' };
}

// Texto listo para pegar en TikTok: la API de bandeja no acepta titulo ni hashtags.
function tiktokCaptionFor(video) {
  const base = video.destinationId === 'religioso'
    ? ['fe', 'dios', 'oracion', 'cristianos', 'jesus', 'biblia', 'reflexion', 'parati']
    : ['peliculas', 'series', 'novelas', 'recomendaciones', 'cine', 'parati'];
  const topic = significantTopicWords(video.idea || video.title || '').filter((word) => word.length >= 6 && !base.includes(word)).slice(0, 2);
  const hook = String(video.hook || '').trim();
  const bible = video.bible_reference ? ` (${video.bible_reference})` : '';
  return [
    String(video.title || video.idea || '').trim(),
    hook ? `${hook}${bible}` : '',
    [...topic, ...base].map((tag) => `#${tag}`).join(' '),
  ].filter(Boolean).join('\n\n').slice(0, 2200);
}

async function notifyTelegram(html) {
  try {
    const response = await fetch(telegramNotifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': internalToken },
      body: JSON.stringify({ text: html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  } catch (error) {
    console.warn(`[telegram] no pude enviar el aviso: ${error.message}`);
    return false;
  }
}

function tiktokTelegramMessage(video, result) {
  const caption = escapeHtml(tiktokCaptionFor(video));
  const title = escapeHtml(video.title || video.idea || video.contentId);
  const head = result.ok
    ? `📲 <b>TikTok:</b> "${title}" ya está en tu bandeja.\nToca el texto para copiarlo, abre la notificación en TikTok, pégalo y pulsa Publicar:`
    : `⚠️ <b>TikTok:</b> no pude enviar "${title}" a tu bandeja (${escapeHtml(result.error || result.reason || 'sin detalle')}).\nSúbelo a mano desde el Studio y pega este texto:`;
  return `${head}\n\n<pre>${caption}</pre>`;
}

async function sendGeneratedVideoToTikTok(video) {
  const result = await sendGeneratedVideoToTikTokInbox(video);
  if (video.destinationId === 'religioso') await notifyTelegram(tiktokTelegramMessage(video, result));
  return result;
}

async function sendGeneratedVideoToTikTokInbox(video) {
  if (video.destinationId !== 'religioso') return { skipped: true, reason: 'Este destino no tiene cuenta TikTok configurada.' };
  if (!tiktokClientKey || !readJson(tiktokTokenPath, null)?.refresh_token) {
    return { manual_required: true, reason: 'TikTok no esta conectado; usa el MP4 para carga manual.' };
  }
  const filePath = path.join(dataDir, 'generated-videos', path.basename(video.fileName || ''));
  if (!fs.existsSync(filePath)) return { ok: false, error: 'El MP4 ya no existe en el servidor.', reason: 'El MP4 ya no existe en el servidor.' };
  try {
    return await sendVideoToTikTokInbox(filePath);
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || 'TIKTOK_UPLOAD_FAILED', manual_required: true, reason: `No se pudo enviar a TikTok (${error.message}); usa el MP4 para carga manual.` };
  }
}

async function tiktokStudioStatus() {
  const base = { connectUrl: '/tiktok/start', destinations: ['Vida con Dios'] };
  if (!tiktokClientKey || !tiktokClientSecret) {
    return { ...base, status: 'disconnected', configured: false, message: 'Falta TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET en el .env. Mientras tanto, se sube a mano.' };
  }
  const stored = readJson(tiktokTokenPath, null);
  if (!stored?.refresh_token) {
    return { ...base, status: 'disconnected', configured: true, message: 'Sin conectar: se sube a mano (descarga el MP4 y copia el texto).' };
  }
  try {
    const token = await tiktokAccessToken();
    return { ...base, status: 'ok', configured: true, account: token.display_name || null, message: `Conectado${token.display_name ? ` como ${token.display_name}` : ''}. Al aprobar, el video llega a tu bandeja de TikTok: toca la notificacion y pulsa Publicar.` };
  } catch (error) {
    return { ...base, status: error.code === 'TIKTOK_RECONNECT_REQUIRED' ? 'expired' : 'error', configured: true, message: error.message };
  }
}

async function googleGet(url, accessToken) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error || `Google request failed: ${response.status}`);
  }
  return payload;
}

function appendPublishLog(entry) {
  const log = readJson(publishLogPath, []);
  log.unshift({
    ...entry,
    created_at: new Date().toISOString(),
  });
  writeJson(publishLogPath, log.slice(0, 100));
}

function appendVideoPublishLog(entry) {
  const log = readJson(videoPublishLogPath, []);
  log.unshift({
    ...entry,
    created_at: new Date().toISOString(),
  });
  writeJson(videoPublishLogPath, log.slice(0, 100));
}

function commandEventKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function commandDuplicateResult(event, reason) {
  const result = event?.result || {};
  if (result.ok === false) {
    return {
      ...result,
      duplicate: true,
      telegram: {
        send_video: false,
        reason: reason || 'Comando duplicado de Telegram; el intento original fallo y no se reenvia video.',
      },
    };
  }
  return {
    ok: true,
    duplicate: true,
    mode: result.mode ? `duplicate_${result.mode}` : 'duplicate_in_progress',
    video: result.video || {},
    facebook: result.facebook || { skipped: true, reason: 'Comando duplicado; no se repite publicacion.' },
    youtube: result.youtube || { skipped: true, reason: 'Comando duplicado; no se repite publicacion.' },
    telegram: {
      send_video: false,
      reason: reason || 'Comando duplicado de Telegram; no se reenvia el video.',
    },
    tiktok: result.tiktok || {
      manual_required: true,
      reason: 'MP4 manual por Telegram; no se reenvia por duplicado.',
    },
  };
}

function genericCommandDuplicateResult(event, reason) {
  return {
    ...(event?.result || { ok: true }),
    duplicate: true,
    suppress_message: true,
    duplicate_reason: reason || 'Comando duplicado; no se repite la accion.',
  };
}

function beginCommandEvent(requestId, payload = {}) {
  const key = commandEventKey(requestId);
  if (!key) return { key: null, isNew: true };
  fs.mkdirSync(commandEventsDir, { recursive: true });
  const file = path.join(commandEventsDir, `${key}.json`);
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({
      key,
      status: 'in_progress',
      payload,
      created_at: new Date().toISOString(),
    }, null, 2));
    fs.closeSync(fd);
    return { key, file, isNew: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return {
      key,
      file,
      isNew: false,
      existing: readJson(file, {}),
    };
  }
}

function completeCommandEvent(event, result) {
  if (!event?.file) return;
  writeJson(event.file, {
    ...(readJson(event.file, {}) || {}),
    status: 'completed',
    completed_at: new Date().toISOString(),
    result,
  });
}

function normalizeContentKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function significantTopicWords(value) {
  const stopWords = new Set([
    'a', 'al', 'algo', 'como', 'con', 'cuando', 'de', 'del', 'desde', 'el', 'en', 'es', 'esta',
    'este', 'estos', 'hay', 'la', 'las', 'lo', 'los', 'mas', 'mi', 'no', 'o', 'para', 'por', 'que',
    'se', 'sin', 'sobre', 'su', 'te', 'tu', 'un', 'una', 'y', 'ya',
  ]);
  return [...new Set(normalizeContentKey(value).split(/\s+/).filter((word) => word.length >= 4 && !stopWords.has(word)))];
}

function textShingles(value, size = 3) {
  const words = normalizeContentKey(value).split(/\s+/).filter(Boolean);
  const shingles = new Set();
  for (let index = 0; index <= words.length - size; index += 1) {
    shingles.add(words.slice(index, index + size).join(' '));
  }
  return shingles;
}

function scriptSimilarity(left, right) {
  const leftSet = textShingles(left);
  const rightSet = textShingles(right);
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const value of leftSet) if (rightSet.has(value)) intersection += 1;
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function readContentHistory() {
  return readJson(contentHistoryPath, []);
}

function appendContentHistory(entry) {
  const history = readContentHistory();
  history.unshift({
    ...entry,
    contentKey: entry.contentKey || normalizeContentKey(entry.idea || entry.title),
    created_at: new Date().toISOString(),
  });
  writeJson(contentHistoryPath, history.slice(0, 500));
}

function recentContentKeys(destinationId, days = 30, beforeTime = Date.now()) {
  const cutoff = beforeTime - days * 24 * 60 * 60 * 1000;
  const keys = new Set();
  for (const item of readContentHistory()) {
    if (destinationId && item.destinationId !== destinationId) continue;
    const created = Date.parse(item.created_at || item.generated_at || '');
    if (Number.isFinite(created) && created < cutoff) continue;
    if (Number.isFinite(created) && created >= beforeTime) continue;
    if (item.contentKey) keys.add(item.contentKey);
    if (item.idea) keys.add(normalizeContentKey(item.idea));
    if (item.title) keys.add(normalizeContentKey(item.title));
  }
  return keys;
}

function pickDailyIdeas(destinationId, items, count = 3, referenceDate = Date.now()) {
  const referenceTime = new Date(referenceDate).getTime();
  if (!Number.isFinite(referenceTime)) throw new Error('Fecha de plan invalida.');
  const dayIndex = Math.floor(referenceTime / 86_400_000);
  const planDayStart = dayIndex * 86_400_000;
  if (ideasProvider === 'local') {
    const cached = readJson(aiIdeasPath, {})[new Date(planDayStart).toISOString().slice(0, 10)]?.[destinationId];
    if (Array.isArray(cached) && cached.length >= count) return cached.slice(0, count);
  }
  const recent = recentContentKeys(destinationId, 7, planDayStart);
  const ordered = items.map((item, index) => items[((dayIndex * count) + index) % items.length]);
  const fresh = ordered.filter((item) => !recent.has(normalizeContentKey(item)));
  const selected = fresh.filter((item, index, all) => all.indexOf(item) === index).slice(0, count);
  if (selected.length < count) {
    const error = new Error(`No hay ${count} temas nuevos disponibles para ${destinationId} sin repetir los ultimos 7 dias.`);
    error.code = 'INSUFFICIENT_UNIQUE_TOPICS';
    throw error;
  }
  return selected;
}

function generatedVideoCandidates(destinationId) {
  const generatedDir = path.join(dataDir, 'generated-videos');
  if (!fs.existsSync(generatedDir)) return [];
  return fs.readdirSync(generatedDir)
    .filter((name) => name.includes(`-${destinationId}-`))
    .map((name) => {
      const dir = path.join(generatedDir, name);
      const metadataPath = path.join(dir, 'metadata.json');
      const filePath = path.join(generatedDir, `${name}.mp4`);
      if (!fs.existsSync(metadataPath) || !fs.existsSync(filePath)) return null;
      return {
        dir,
        metadataPath,
        filePath,
        metadata: readJson(metadataPath, {}),
        mtimeMs: fs.statSync(filePath).mtimeMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function isReviewableVideoCandidate(item) {
  return Boolean(
    item?.metadata?.quality?.passed === true
    && /^VID-\d{14}-[A-F0-9]{6}$/.test(String(item.metadata?.contentId || '')),
  );
}

function isRejectedVideoCandidate(item) {
  const contentId = item?.metadata?.contentId;
  return Boolean(
    item?.metadata?.rejected_at
    || item?.metadata?.telegram_send_allowed === false
    || (contentId && findContentItem(contentId)?.status === 'rejected'),
  );
}

function pendingPreviewForIdea(destinationId, ideaIndex) {
  return generatedVideoCandidates(destinationId)
    .find((item) => (
      isReviewableVideoCandidate(item)
      && Number(item.metadata?.ideaIndex) === Number(ideaIndex)
      && !item.metadata?.published_at
      && !isRejectedVideoCandidate(item)
    ));
}

function pendingPreviewForContentKey(destinationId, contentKey) {
  return generatedVideoCandidates(destinationId)
    .find((item) => (
      isReviewableVideoCandidate(item)
      && item.metadata?.contentKey === contentKey
      && !item.metadata?.published_at
      && !isRejectedVideoCandidate(item)
    ));
}

function generatedVideoForContentId(contentId) {
  return Object.keys(facebookDestinations)
    .flatMap((destinationId) => generatedVideoCandidates(destinationId))
    .find((item) => item.metadata?.contentId === contentId) || null;
}

function generatedVideoForFileName(fileName) {
  return Object.keys(facebookDestinations)
    .flatMap((destinationId) => generatedVideoCandidates(destinationId))
    .find((item) => item.metadata?.fileName === fileName) || null;
}

function requireYouTubeUploadScope(token) {
  const scopes = String(token?.scope || '').split(/\s+/);
  if (!scopes.includes('https://www.googleapis.com/auth/youtube.upload')) {
    const error = new Error('YouTube must be reconnected with youtube.upload before automatic publishing');
    error.code = 'YOUTUBE_UPLOAD_SCOPE_MISSING';
    error.reconnect_url = `${appBaseUrl}/youtube/start`;
    throw error;
  }
}

async function uploadYouTubeVideo({ fileName, title, description, privacyStatus = 'private', tags = [], channelKey = defaultYouTubeChannelKey }) {
  const key = resolveYouTubeChannelKey(channelKey);
  const tokenPathForUpload = youtubeTokenPathForChannel(key);
  const token = await refreshAccessToken(readJson(tokenPathForUpload), tokenPathForUpload);
  requireYouTubeUploadScope(token);

  const safeName = path.basename(fileName || 'video-001-cuando-dios-esta-en-silencio-v4.mp4');
  const candidates = [
    path.join(dataDir, 'video-001', 'output', safeName),
    path.join(dataDir, 'generated-videos', safeName),
  ];
  const videoDirs = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter((name) => /^video-/.test(name))
    : [];
  for (const dir of videoDirs) {
    candidates.push(path.join(dataDir, dir, 'output', safeName));
  }
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) {
    throw new Error(`Video file not found: ${safeName}`);
  }

  const body = fs.readFileSync(file);
  const metadata = {
    snippet: {
      title: title || 'Cuando Dios esta en silencio',
      description: description || 'Cuando sientes que Dios esta en silencio, tal vez no estas abandonado: estas siendo preparado. Salmo 46:10.\n\n#Fe #Dios #Oracion #Devocional #Cristianos #Shorts',
      categoryId: '22',
      tags,
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
    },
  };

  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token.access_token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': String(body.length),
      'x-upload-content-type': 'video/mp4',
    },
    body: JSON.stringify(metadata),
  });
  if (!init.ok) {
    let details = '';
    try {
      details = JSON.stringify(await init.json());
    } catch {
      details = await init.text();
    }
    throw new Error(`YouTube upload init failed: ${init.status} ${details}`);
  }
  const uploadUrl = init.headers.get('location');
  if (!uploadUrl) {
    throw new Error('YouTube upload init did not return an upload URL');
  }

  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(body.length),
    },
    body,
  });
  const payload = await upload.json();
  if (!upload.ok) {
    throw new Error(`YouTube upload failed: ${upload.status} ${JSON.stringify(payload)}`);
  }

  const result = {
    ok: true,
    platform: 'youtube',
    video_id: payload.id,
    url: payload.id ? `https://www.youtube.com/watch?v=${payload.id}` : null,
    privacyStatus,
    title: metadata.snippet.title,
    fileName: safeName,
    channelKey: key,
    channelLabel: youtubeChannels[key].label,
  };
  appendPublishLog(result);
  return result;
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

function polishSpanishText(value) {
  return String(value)
    .replace(/\btecnologia\b/gi, 'tecnología')
    .replace(/\baccion\b/gi, 'acción')
    .replace(/\bpequena\b/gi, 'pequeña')
    .replace(/\bdia\b/gi, 'día')
    .replace(/\brapido\b/gi, 'rápido')
    .replace(/\butil\b/gi, 'útil')
    .replace(/\batencion\b/gi, 'atención')
    .replace(/\btambien\b/gi, 'también')
    .replace(/\bllego\b/gi, 'llegó')
    .replace(/\btomala\b/gi, 'tómala')
    .replace(/\bmas\b/gi, 'más')
    .replace(/\bcorazon\b/gi, 'corazón')
    .replace(/\boracion\b/gi, 'oración')
    .replace(/\bsabiduria\b/gi, 'sabiduría')
    .replace(/\bconviertela\b/gi, 'conviértela')
    .replace(/\bgano\b/gi, 'ganó')
    .replace(/\bcompartelo\b/gi, 'compártelo')
    .replace(/\bsabias\b/gi, 'sabías')
    .replace(/\banimo\b/gi, 'ánimo');
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

function splitScriptForSubtitles(script) {
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

function buildVisualPrompts(destination, idea, variationSeed = '') {
  const variation = crypto.createHash('sha1')
    .update(`${destination.id}:${idea}:${variationSeed || new Date().toISOString()}`)
    .digest('hex')
    .slice(0, 8);
  const base = `Vertical 1024x1536 cinematic realistic B-roll frame for social media, natural camera imperfections, layered foreground and background, real-world lighting, clean composition, no text, no logos, no watermark, no readable screens, no recognizable public figures or copyrighted characters, people only distant or silhouetted, leave clear lower center space for subtitles. Topic: ${idea}. Visual variation key ${variation}.`;
  if (destination.id === 'religioso') {
    return [
      `${base} Quiet bedroom before dawn, soft blue window light and an unmade bed, intimate reflective mood, realistic Latin American home.`,
      `${base} Rain moving across a nighttime window, warm lamp and closed journal in foreground, peaceful contrast between anxiety and calm.`,
      `${base} Open Bible and simple notebook beside a ceramic cup, warm practical light, shallow depth of field, respectful devotional atmosphere.`,
      `${base} Wide sunrise landscape with one distant contemplative silhouette, hopeful natural light, realistic and restrained, no fantasy effects.`,
    ];
  }
  if (destination.id === 'esferaclick') {
    return [
      `${base} Modern smartphone lying on a clean desk with blurred app shapes, productivity lifestyle mood, teal and yellow accents, realistic photo, no fake UI.`,
      `${base} Everyday workspace with phone, notebook, coffee, and keys arranged naturally, practical lifestyle technology scene, natural window light, modern Latin American urban feel.`,
      `${base} Close-up of a smartphone edge and notification blur on a desk, dynamic lifestyle tech composition, crisp realistic details, bright modern color palette.`,
    ];
  }
  if (destination.id === 'tecnolatino') {
    return [
      `${base} Modern laptop and smartphone setup, technology tips mood, blue and green accents, realistic editorial photo.`,
      `${base} Cyber hygiene and useful app settings concept, clean device screen glow, no readable UI text, modern desk.`,
      `${base} Latin American tech creator workspace, practical tools, organized cables, professional but approachable.`,
    ];
  }
  if (destination.id === 'gamergadget') {
    return [
      `${base} Gaming desk setup with keyboard, controller, and monitor glow, energetic but clean, cyan and violet accents.`,
      `${base} Close-up of gaming peripherals on a tidy setup, premium gadget review mood, realistic texture and lighting.`,
      `${base} Comfortable gaming station, ergonomic chair and controller, modern room, cinematic vertical framing.`,
    ];
  }
  if (destination.id === 'fanspeliculas') {
    return [
      `${base} Lush coffee plantation at golden hour with two distant fictional silhouettes, romantic drama atmosphere, entirely original composition.`,
      `${base} Tense fictional heist-planning table with an abstract city map, photographs turned face down and a ticking clock, no masks or recognizable franchise symbols.`,
      `${base} Moody apartment corridor on a rainy night, a half-open door and reflected red light, psychological mystery atmosphere, no violence.`,
      `${base} Elegant home cinema corner with popcorn, notebook and remote in foreground, colorful screen glow without visible content, premium entertainment editorial photo.`,
    ];
  }
  return [
    `${base} Interesting everyday curiosity scene, phone and notebook, bold lifestyle editorial composition, red and blue accents.`,
    `${base} Person discovering a useful fact on a phone, clean realistic scene, bright modern look, no text.`,
    `${base} Social media curiosity visual, modern urban lifestyle detail, dynamic vertical frame, crisp and colorful.`,
  ];
}

function displayBrandForDestination(destination) {
  const brands = {
    religioso: 'Vida con Dios',
    esferaclick: 'EsferaClick.com',
    tecnolatino: 'Tecno-Latino',
    gamergadget: 'Gamer Gadget RD',
    infoboy27: 'Infoboy27',
    fanspeliculas: 'Fans Peliculas y Novelas',
  };
  return brands[destination.id] || destination.destination;
}

function recentVideoScripts(destinationId, limit = 8) {
  return generatedVideoCandidates(destinationId)
    .map((item) => item.metadata?.script)
    .filter(Boolean)
    .slice(0, limit);
}

function scriptQualityReport(script, destination, idea, recentScripts = []) {
  const normalized = normalizeContentKey(script);
  const referenceText = String(script || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = wordCount(script);
  const topicWords = significantTopicWords(idea);
  // Por raiz: "villano" cuenta para "villanos" e "inolvidable" para "inolvidables".
  const mentionedTopicWords = topicWords.filter((word) => normalized.includes(word.slice(0, Math.max(4, word.length - 2))));
  const requiredTopicWords = Math.min(topicWords.length, Math.max(1, Math.ceil(topicWords.length * 0.4)));
  const sentences = String(script).split(/(?<=[.!?])\s+/).map(normalizeContentKey).filter(Boolean);
  const repeatedSentences = sentences.length - new Set(sentences).size;
  const similarities = recentScripts.map((recent) => scriptSimilarity(script, recent));
  const maximumSimilarity = similarities.length ? Math.max(...similarities) : 0;
  const legacyPhrases = [
    'no necesitas fingir que todo esta bien para acercarte a dios',
    'la fe no elimina cada proceso de inmediato',
    'vamos a comentarlo sin spoilers innecesarios y con recomendaciones concretas',
  ];
  const problems = [];
  if (words < minimumScriptWords - 15) problems.push(`solo tiene ${words} palabras; necesita al menos ${minimumScriptWords}`);
  if (words > maximumScriptWords + 60) problems.push(`tiene ${words} palabras; el maximo es ${maximumScriptWords}`);
  if (mentionedTopicWords.length < requiredTopicWords) problems.push('no desarrolla de forma suficientemente concreta el tema solicitado');
  if (repeatedSentences > 0) problems.push('repite oraciones dentro del mismo guion');
  if (maximumSimilarity > 0.24) problems.push(`se parece demasiado a un guion anterior (${maximumSimilarity.toFixed(2)})`);
  if (legacyPhrases.some((phrase) => normalized.includes(phrase))) problems.push('recicla una frase de la plantilla anterior');
  if (destination.id === 'religioso' && !/\b(?:genesis|exodo|levitico|numeros|deuteronomio|josue|jueces|rut|samuel|reyes|cronicas|esdras|nehemias|ester|job|salmo|salmos|proverbios|eclesiastes|isaias|jeremias|lamentaciones|ezequiel|daniel|oseas|joel|amos|abdias|jonas|miqueas|nahum|habacuc|sofonias|hageo|zacarias|malaquias|mateo|marcos|lucas|juan|hechos|romanos|corintios|galatas|efesios|filipenses|colosenses|tesalonicenses|timoteo|tito|filemon|hebreos|santiago|pedro|judas|apocalipsis)\s+\d+(?::\d+)?\b/i.test(referenceText)) {
    problems.push('no incluye una referencia biblica concreta');
  }
  return {
    passed: problems.length === 0,
    problems,
    word_count: words,
    topic_words: topicWords,
    mentioned_topic_words: mentionedTopicWords,
    maximum_recent_similarity: Number(maximumSimilarity.toFixed(4)),
  };
}

function responseOutputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text.trim();
  return (payload?.output || [])
    .flatMap((item) => item?.content || [])
    .map((item) => item?.text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

// IA local (Ollama, sdcpp, speaches) con OpenAI como respaldo.
// AI_PROVIDER=local|openai; AI_FALLBACK_OPENAI=false desactiva el respaldo.
const aiProvider = String(process.env.AI_PROVIDER || 'local').trim().toLowerCase();
const aiFallbackToOpenai = !['0', 'false', 'off', 'no'].includes(
  String(process.env.AI_FALLBACK_OPENAI || 'true').trim().toLowerCase(),
);
const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || 'http://ollama:11434').replace(/\/+$/, '');
const ollamaScriptModel = process.env.OLLAMA_SCRIPT_MODEL || 'qwen3.5:9b';
const localImageBaseUrl = (process.env.LOCAL_IMAGE_BASE_URL || 'http://sdcpp:7860/v1').replace(/\/+$/, '');
const localSpeechBaseUrl = (process.env.LOCAL_SPEECH_BASE_URL || 'http://speaches:8000/v1').replace(/\/+$/, '');
const localSttModel = process.env.LOCAL_STT_MODEL || 'deepdml/faster-whisper-large-v3-turbo-ct2';
const localVideoImageSize = process.env.LOCAL_VIDEO_IMAGE_SIZE || '832x1472';
// Piper es_MX: Kokoro lee la "j" espanola como "k" ("abajo" -> "abaco").
const defaultLocalVoice = {
  model: process.env.LOCAL_TTS_MODEL || 'speaches-ai/piper-es_MX-claude-high',
  voice: process.env.LOCAL_TTS_VOICE || 'claude',
};
const studioSettingsPath = path.join(dataDir, 'studio-settings.json');
const studioSettingsDefaults = {
  // Guion con OpenAI (mejor redaccion); voz, imagenes y subtitulos con IA local.
  scriptProvider: String(process.env.AI_SCRIPT_PROVIDER || aiProvider).trim().toLowerCase(),
  voiceModel: defaultLocalVoice.model,
  voiceName: defaultLocalVoice.voice,
  voiceSpeed: {
    religioso: Number(process.env.VOICE_SPEED_RELIGIOSO || 0.9),
    fanspeliculas: Number(process.env.VOICE_SPEED_PELICULAS || 0.98),
  },
  // Pausa breve entre frases y ecualizacion/compresion suave para que la voz suene menos robotica.
  voiceNatural: true,
  sentencePause: 0.22,
  scenePause: 0.45,
  // Realismo (apagados por defecto): look de pelicula y clips reales de Pixabay como tomas de apoyo.
  cinematicLook: false,
  realClips: false,
};
let studioSettingsCache = null;

function studioSettings() {
  try {
    const mtime = fs.statSync(studioSettingsPath).mtimeMs;
    if (!studioSettingsCache || studioSettingsCache.mtime !== mtime) {
      const saved = JSON.parse(fs.readFileSync(studioSettingsPath, 'utf8'));
      studioSettingsCache = {
        mtime,
        value: {
          ...studioSettingsDefaults,
          ...saved,
          voiceSpeed: { ...studioSettingsDefaults.voiceSpeed, ...(saved.voiceSpeed || {}) },
        },
      };
    }
    return studioSettingsCache.value;
  } catch {
    return studioSettingsDefaults;
  }
}

function localVoiceFor(destinationId) {
  const settings = studioSettings();
  return {
    model: settings.voiceModel,
    voice: settings.voiceName,
    speed: settings.voiceSpeed[destinationId] || 1,
  };
}
const videoFps = 30;
const pixabayApiKey = process.env.PIXABAY_API_KEY || '';
// Look de pelicula: leve camara en mano, menos nitidez, color de cine, vineta y grano.
const cinematicLookFilter = [
  "crop=1036:1842:x='22+9*sin(t*1.3)+4*sin(t*3.7)':y='39+8*sin(t*1.1+1)+4*sin(t*2.9)'",
  'scale=1080:1920:flags=bicubic',
  'gblur=sigma=0.45',
  'eq=contrast=1.05:saturation=0.9:gamma=0.98',
  "curves=all='0/0.04 0.5/0.5 1/0.96'",
  'colorbalance=rs=0.03:bs=-0.02:rh=0.02:bh=-0.03',
  'vignette=PI/5',
  'noise=alls=9:allf=t+u',
].join(',');

let activeVideoJob = null;
let lastVideoJob = null;

function logStep(message) {
  console.log(`[video ${new Date().toISOString()}] ${message}`);
  if (activeVideoJob) {
    activeVideoJob.logs.push({ at: Date.now(), message: String(message) });
    if (activeVideoJob.logs.length > 300) activeVideoJob.logs.shift();
  }
}

// La GPU solo puede generar un video a la vez; el segundo pedido recibe un error claro.
async function runVideoJob(source, label, task) {
  if (activeVideoJob) {
    const error = new Error(`Ya se esta generando un video (${activeVideoJob.label}, pedido desde ${activeVideoJob.source}). Intenta de nuevo cuando termine.`);
    error.code = 'VIDEO_JOB_BUSY';
    throw error;
  }
  const job = { id: crypto.randomBytes(4).toString('hex'), source, label, status: 'running', startedAt: Date.now(), logs: [] };
  activeVideoJob = job;
  try {
    const result = await task();
    job.status = 'done';
    job.contentId = result?.contentId || null;
    job.fileName = result?.fileName || null;
    job.test = Boolean(result?.test);
    return result;
  } catch (error) {
    job.status = 'error';
    job.error = error.message;
    throw error;
  } finally {
    job.finishedAt = Date.now();
    activeVideoJob = null;
    lastVideoJob = job;
  }
}

async function withAiProvider(task, { forceLocal = false, primary = aiProvider } = {}, runLocal, runOpenai) {
  if (primary === 'openai' && !forceLocal) {
    try {
      return { value: await runOpenai(), provider: 'openai' };
    } catch (error) {
      console.warn(`[ai] ${task}: fallo OpenAI (${error.message}); usando IA local de respaldo`);
      return { value: await runLocal(), provider: 'local' };
    }
  }
  try {
    return { value: await runLocal(), provider: 'local' };
  } catch (error) {
    if (forceLocal || !aiFallbackToOpenai || !openaiApiKey) throw error;
    console.warn(`[ai] ${task}: fallo local (${error.message}); usando OpenAI de respaldo`);
    return { value: await runOpenai(), provider: 'openai' };
  }
}

const videoPlanSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hook: { type: 'string' },
    protagonist: { type: 'string' },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          narration: { type: 'string' },
          visual: { type: 'string' },
        },
        required: ['narration', 'visual'],
      },
    },
  },
  required: ['hook', 'protagonist', 'scenes'],
};

// Pasajes conocidos para que un modelo pequeno no invente citas.
const knownBiblePassages = [
  ['Salmo 34:18', 'el Señor está cerca de los quebrantados de corazón'],
  ['Salmo 46:10', 'debemos estar quietos y reconocer que él es Dios'],
  ['Salmo 55:22', 'podemos echar nuestra carga sobre el Señor y él nos sostendrá'],
  ['Salmo 121:1-2', 'nuestra ayuda viene del Señor, que hizo los cielos y la tierra'],
  ['Proverbios 3:5-6', 'debemos confiar en el Señor de todo corazón y no apoyarnos en nuestra propia prudencia'],
  ['Isaías 40:31', 'los que esperan en el Señor renuevan sus fuerzas'],
  ['Isaías 41:10', 'no debemos temer, porque Dios está con nosotros'],
  ['Lamentaciones 3:22-23', 'las misericordias de Dios se renuevan cada mañana'],
  ['Josué 1:9', 'debemos ser fuertes y valientes, porque Dios está con nosotros dondequiera que vayamos'],
  ['Mateo 6:34', 'no debemos afanarnos por el día de mañana'],
  ['Mateo 11:28', 'Jesús invita a los cansados a venir a él para encontrar descanso'],
  ['Juan 14:27', 'Jesús nos deja su paz'],
  ['Romanos 8:28', 'a los que aman a Dios todas las cosas les ayudan a bien'],
  ['Romanos 12:12', 'debemos estar gozosos en la esperanza, ser pacientes en la tribulación y constantes en la oración'],
  ['2 Corintios 12:9', 'la gracia de Dios nos basta y su poder se perfecciona en la debilidad'],
  ['Filipenses 4:6-7', 'no debemos inquietarnos por nada, sino presentar nuestras peticiones a Dios, y su paz guardará nuestro corazón'],
  ['Santiago 1:5', 'si nos falta sabiduría, podemos pedírsela a Dios'],
  ['1 Pedro 5:7', 'podemos echar toda nuestra ansiedad sobre Dios, porque él cuida de nosotros'],
  ['Marcos 1:35', 'Jesús se levantó muy de mañana y se fue a un lugar apartado a orar'],
];

// Elige un pasaje que no aparezca en los guiones recientes.
function pickBiblePassage(idea, generationVersion, recentScripts) {
  const recent = normalizeContentKey(recentScripts.join(' '));
  const unused = knownBiblePassages.filter(([ref]) => !recent.includes(normalizeContentKey(ref.split(':')[0])));
  const pool = unused.length ? unused : knownBiblePassages;
  const seed = parseInt(crypto.createHash('sha1').update(`${idea}:${generationVersion}:${Date.now()}`).digest('hex').slice(0, 8), 16);
  return pool[seed % pool.length];
}

async function chooseBiblePassage(idea, generationVersion, recentScripts, { forceLocal }) {
  const recent = normalizeContentKey(recentScripts.join(' '));
  const unused = knownBiblePassages.filter(([ref]) => !recent.includes(normalizeContentKey(ref.split(':')[0])));
  const pool = unused.length >= 4 ? unused : knownBiblePassages;
  if (aiProvider === 'openai' && !forceLocal) return pickBiblePassage(idea, generationVersion, recentScripts);
  try {
    const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ollamaScriptModel,
        messages: [{
          role: 'user',
          content: `Tema de un video devocional: "${idea}".\nElige el pasaje cuya idea encaja MEJOR con el tema:\n${pool.map(([ref, gist], index) => `${index + 1}. ${ref}: ${gist}`).join('\n')}\nResponde en JSON con el numero.`,
        }],
        format: { type: 'object', properties: { choice: { type: 'integer', enum: pool.map((_, index) => index + 1) } }, required: ['choice'] },
        think: false,
        stream: false,
        options: { temperature: 0.2, num_predict: 30 },
      }),
      signal: AbortSignal.timeout(3 * 60 * 1000),
    });
    const payload = await response.json();
    const choice = pool[Number(JSON.parse(payload.message?.content || '{}').choice) - 1];
    if (choice) return choice;
  } catch (error) {
    logStep(`no se pudo elegir pasaje con el modelo (${error.message}); se elige al azar`);
  }
  return pickBiblePassage(idea, generationVersion, recentScripts);
}

function hasBibleReference(text, ref) {
  return normalizeContentKey(text).includes(normalizeContentKey(ref.split(':')[0]));
}

// Si el modelo olvida la cita, se inserta con su sentido correcto en la escena 4.
function ensureBibleReference(plan, passage) {
  const [ref, gist] = passage;
  if (plan.scenes.some((scene) => hasBibleReference(scene.narration, ref))) return false;
  const target = plan.scenes[Math.min(3, plan.scenes.length - 1)];
  if (target) target.narration = `${ref} nos recuerda que ${gist}. ${target.narration}`;
  return true;
}

function buildVideoPlanPrompt({ destination, idea, generationVersion, recentScripts, feedback, passage }) {
  const angles = destination.id === 'religioso'
    ? ['una escena cotidiana concreta', 'una pregunta honesta y una respuesta biblica', 'un contraste antes y despues', 'tres pasos practicos unidos por una sola idea']
    : ['una comparacion clara', 'una historia breve con conclusion', 'tres observaciones conectadas', 'una pregunta inicial que se resuelve al final'];
  const angle = angles[(generationVersion - 1) % angles.length];
  const channelRules = destination.id === 'religioso'
    ? [
      'Estructura: escena 1 gancho con una situacion cotidiana concreta en segunda persona; escenas 2-3 lo que se siente y por que duele; escena 4 el giro con el pasaje biblico;',
      'escenas 5-7 que significa el pasaje y como se aplica; escena 8 una accion practica concreta para hoy; escena 9 cierre esperanzador y una invitacion a comentar o compartir.',
      `OBLIGATORIO: la narracion de la escena 4 empieza con "${passage[0]} nos recuerda que" y explica su idea: ${passage[1]}.`,
      'No cites otros pasajes. Respeta esa idea; no le agregues promesas que no dice.',
    ].join(' ')
    : [
      'Estructura: escena 1 gancho con una pregunta o afirmacion que despierte curiosidad; escenas 2-7 desarrollan el tema con ejemplos o recomendaciones concretas, cada una con su por que;',
      'escena 8 resume la idea; escena 9 invita a comentar su favorita.',
      'Habla de peliculas, series o novelas sin spoilers importantes. Menciona solo titulos muy conocidos de los que estes seguro; no inventes escenas, premios, fechas, actores ni datos.',
    ].join(' ');
  const visualRules = destination.id === 'religioso'
    ? 'Ambientes reales latinoamericanos, luz natural calida y esperanzadora; personas reales con expresiones naturales (sin rostros de famosos); nada oscuro, tetrico ni de terror.'
    : 'Ambientes de cine en casa, salas de cine, palomitas, pantallas encendidas sin texto legible, personas reales disfrutando; colores vivos; sin actores reales ni personajes con derechos de autor.';
  const previous = recentScripts.slice(0, 5).map((value, index) => (
    `${index + 1}. ${String(value).replace(/\s+/g, ' ').slice(0, 320)}`
  )).join('\n');
  return [
    `Crea el plan de un video vertical corto (Reels/Shorts/TikTok) en espanol latino para ${destination.destination}.`,
    `Tema exacto: ${idea}`,
    `Version de generacion: ${generationVersion}. Enfoque narrativo: ${angle}.`,
    'Devuelve JSON con "hook" y "scenes".',
    '- "hook": frase gancho de 3 a 7 palabras que se mostrara en pantalla al inicio.',
    '- "protagonist": EN INGLES, aspecto fijo de la persona principal: genero, edad, rasgos, cabello y ropa con colores (ej. "a Latina woman in her 30s with long straight dark brown hair, wearing a mustard yellow sweater and blue jeans").',
    '- "scenes": EXACTAMENTE 9 escenas en orden. Cada escena tiene:',
    '  * "narration": 2 oraciones habladas que sumen entre 19 y 23 palabras (cuentalas), en espanol latino, con tildes y signos correctos.',
    '  * "visual": descripcion EN INGLES de una sola fotografia realista que muestre literalmente lo que dice esa narracion: sujeto, accion, lugar, luz y tipo de plano (close-up, medium shot o wide shot). Si la narracion es abstracta, muestra a una persona viviendo esa situacion.',
    '  Si la misma persona aparece en varias escenas, define su aspecto una vez (edad, cabello, ropa con colores) y COPIA esa misma descripcion completa en cada "visual" donde aparezca.',
    `Asi el guion completo queda entre ${minimumScriptWords} y ${maximumScriptWords} palabras (unos 65 a 75 segundos de locucion). Ninguna escena puede pasar de 25 palabras.`,
    'La primera escena es el gancho: una frase especifica que atrape en los primeros 3 segundos. La ultima escena cierra la idea con una llamada a la accion propia.',
    `Usa en el guion estas palabras clave del tema: ${significantTopicWords(idea).join(', ')}.`,
    'La narracion es SOLO lo que se escucha en voz alta: nunca menciones la pantalla, la camara, la imagen ni lo que el espectador ve; esas descripciones van solo en "visual".',
    'Habla directo al espectador (tu). No inventes personajes con nombre propio. Todo el guion desarrolla UNA sola idea central y cada escena continua logicamente la anterior.',
    'Cada frase debe aportar informacion o progresion; evita relleno, frases comodin, metaforas forzadas, repeticiones y una introduccion que solo repita el titulo.',
    'No uses emojis, hashtags, comillas ni Markdown.',
    channelRules,
    `Reglas visuales: ${visualRules} Varia lugares y tipos de plano entre escenas. Nunca pidas texto, letreros, logos ni marcas de agua dentro de la imagen.`,
    previous ? `No reutilices redaccion ni estructura de estos guiones recientes:\n${previous}` : '',
    feedback.length ? `Corrige ademas estos problemas detectados por el validador:\n- ${feedback.join('\n- ')}` : '',
  ].filter(Boolean).join('\n');
}

async function requestVideoPlanLocal(prompt) {
  const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ollamaScriptModel,
      messages: [
        { role: 'system', content: 'Eres un guionista profesional de videos cortos para redes sociales en espanol latino. Respondes solo con JSON valido.' },
        { role: 'user', content: prompt },
      ],
      format: videoPlanSchema,
      think: false,
      stream: false,
      options: { temperature: 0.7, num_predict: 3072, num_ctx: 8192 },
    }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Ollama respondio HTTP ${response.status}: ${payload.error || ''}`);
  return JSON.parse(payload.message?.content || '{}');
}

async function requestVideoPlanOpenai(prompt) {
  if (!openaiApiKey) throw new Error('OPENAI_API_KEY is not configured');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openaiApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: openaiScriptModel,
      input: prompt,
      reasoning: { effort: 'low' },
      max_output_tokens: 3000,
      text: { format: { type: 'json_schema', name: 'video_plan', schema: videoPlanSchema, strict: true } },
      store: false,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`No se pudo generar el guion (${payload.error?.code || `HTTP_${response.status}`}).`);
    error.code = 'SCRIPT_PROVIDER_FAILED';
    throw error;
  }
  return JSON.parse(responseOutputText(payload) || '{}');
}

function cleanVideoPlan(raw) {
  const scenes = (Array.isArray(raw?.scenes) ? raw.scenes : [])
    .map((scene) => ({
      narration: polishSpanishText(String(scene?.narration || '').replace(/\s+/g, ' ').replace(/["“”*#]/g, '').trim()),
      visual: String(scene?.visual || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((scene) => scene.narration);
  return {
    hook: polishSpanishText(String(raw?.hook || '').replace(/["“”*#]/g, '').trim()),
    protagonist: String(raw?.protagonist || '').replace(/\s+/g, ' ').trim(),
    scenes,
  };
}

function videoPlanProblems(plan, destination) {
  const problems = [];
  if (plan.scenes.length < 7 || plan.scenes.length > 11) problems.push(`tiene ${plan.scenes.length} escenas; deben ser entre 8 y 10`);
  if (!plan.hook || wordCount(plan.hook) > 9) problems.push('el hook debe tener entre 3 y 7 palabras');
  plan.scenes.forEach((scene, index) => {
    // En peliculas "camara", "pantalla" o "imagen" son vocabulario normal; en devocionales delatan instrucciones visuales.
    const directions = destination?.id === 'religioso'
      ? /\b(pantalla|camara|cámara|imagen|exactamente asi|exactamente así|mientras (ves|miras|observas))\b/i
      : /\b(exactamente asi|exactamente así|mientras (ves|miras|observas))\b/i;
    if (directions.test(scene.narration)) {
      problems.push(`la narracion de la escena ${index + 1} describe la imagen o la camara; eso va solo en "visual"`);
    }
    if (wordCount(scene.narration) > 40) problems.push(`la narracion de la escena ${index + 1} es demasiado larga`);
    if (scene.visual.length < 25) problems.push(`la escena ${index + 1} no tiene una descripcion visual concreta`);
  });
  return problems;
}

// Kokoro lee mejor "Mateo 11, versiculo 28" que "Mateo 11:28".
function speechText(text) {
  return String(text)
    .replace(/(\d+):(\d+)\s*[-–]\s*(\d+)/g, '$1, versículos $2 al $3')
    .replace(/(\d+):(\d+)/g, '$1, versículo $2');
}

async function generateLocalSpeech(text, destinationId, format, speedOverride = null) {
  const { model, voice, speed: baseSpeed } = localVoiceFor(destinationId);
  const speed = speedOverride || baseSpeed;
  const response = await fetch(`${localSpeechBaseUrl}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, voice, speed, input: speechText(text), response_format: format }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`speaches TTS HTTP ${response.status}`);
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 1000) throw new Error('speaches devolvio un audio vacio');
  return audio;
}

async function generateSpeech(text, destinationId = null, { format = 'mp3', forceLocal = false, speed = null } = {}) {
  assertAllowedText(text);
  return withAiProvider(
    'voz',
    { forceLocal },
    () => generateLocalSpeech(text, destinationId, format, speed),
    () => generateOpenAiSpeech(text, destinationId),
  );
}

async function transcribeWordsLocal(audio) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'voice.wav');
  form.append('model', localSttModel);
  form.append('language', 'es');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  const response = await fetch(`${localSpeechBaseUrl}/audio/transcriptions`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`speaches STT HTTP ${response.status}`);
  return (await response.json()).words || [];
}

async function transcribeWordsOpenai(audio) {
  if (!openaiApiKey) throw new Error('OPENAI_API_KEY is not configured');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'voice.wav');
  form.append('model', 'whisper-1');
  form.append('language', 'es');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${openaiApiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(`OpenAI STT HTTP ${response.status}`);
  return (await response.json()).words || [];
}

async function generateLocalImage(prompt, size) {
  // Si otro servicio cargo el LLM en la GPU a mitad de la imagen, sdcpp falla por VRAM;
  // el gateway descarga el LLM al inicio de cada pedido, asi que reintentar suele bastar.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await requestLocalImage(prompt, size);
    } catch (error) {
      if (attempt >= 3) throw error;
      logStep(`imagen fallo (intento ${attempt}): ${error.message.split('\n').pop().slice(0, 160)}; reintentando`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function requestLocalImage(prompt, size) {
  const response = await fetch(`${localImageBaseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'z-image-turbo', prompt, size, n: 1 }),
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`sdcpp HTTP ${response.status}: ${payload.error?.message || ''}`.slice(0, 300));
  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) throw new Error('sdcpp no devolvio b64_json');
  return Buffer.from(b64, 'base64');
}

async function generateImage(prompt, { size = '1024x1536', forceLocal = false } = {}) {
  assertAllowedText(prompt);
  const result = await withAiProvider(
    'imagen',
    { forceLocal },
    () => generateLocalImage(prompt, size),
    () => generateOpenAiImage(prompt),
  );
  setServiceStatus('media_provider', 'ready', { provider: result.provider });
  return result;
}

// Una locucion por escena: asi cada imagen dura exactamente lo que se habla de ella.
function splitSentences(text) {
  const parts = String(text).split(/(?<=[.!?…;])\s+/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [String(text)];
}

// Ecualizacion calida, compresion suave y un poco de sala: Piper suena menos "de laboratorio".
const naturalVoiceFilter = [
  'highpass=f=75',
  'equalizer=f=180:t=q:w=1:g=2.5',
  'equalizer=f=3200:t=q:w=1.2:g=1.5',
  'equalizer=f=7500:t=q:w=2:g=-2',
  'acompressor=threshold=-20dB:ratio=2.5:attack=8:release=160:makeup=2',
  'aecho=0.85:0.5:28|47:0.10|0.06',
].join(',');

// Una locucion por frase con pausas cortas entre frases y una pausa mayor entre escenas.
async function synthesizeSpeechFile(text, destinationId, outPath, { forceLocal = false, speed = null, tailPause = 0.45 } = {}) {
  const settings = studioSettings();
  const sentences = splitSentences(text);
  const parts = [];
  const providers = new Set();
  for (const [index, sentence] of sentences.entries()) {
    const { value: audio, provider } = await generateSpeech(sentence, destinationId, { format: 'wav', forceLocal, speed });
    providers.add(provider);
    const rawPath = `${outPath}.${index + 1}.src`;
    const partPath = `${outPath}.${index + 1}.wav`;
    fs.writeFileSync(rawPath, audio, { mode: 0o600 });
    const pause = index === sentences.length - 1 ? 0 : settings.sentencePause;
    await runCommand('ffmpeg', ['-y', '-v', 'error', '-i', rawPath, '-af', `aresample=48000,apad=pad_dur=${pause}`, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', partPath]);
    fs.rmSync(rawPath, { force: true });
    parts.push(partPath);
  }
  const listPath = `${outPath}.list`;
  fs.writeFileSync(listPath, parts.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'), { mode: 0o600 });
  const joinedPath = `${outPath}.joined.wav`;
  await runCommand('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', joinedPath]);
  const speech = await probeMediaDuration(joinedPath);
  const filters = [settings.voiceNatural && providers.has('local') ? naturalVoiceFilter : null, `apad=pad_dur=${tailPause}`].filter(Boolean).join(',');
  await runCommand('ffmpeg', ['-y', '-v', 'error', '-i', joinedPath, '-af', filters, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', outPath]);
  for (const file of [...parts, listPath, joinedPath]) fs.rmSync(file, { force: true });
  return { speech, total: await probeMediaDuration(outPath), providers };
}

async function synthesizeScenes(plan, destination, workDir, { forceLocal, speed = null }) {
  const scenes = [];
  const providers = new Set();
  let elapsed = 0;
  for (const [index, scene] of plan.scenes.entries()) {
    const wavPath = path.join(workDir, `voice-${index + 1}.wav`);
    const result = await synthesizeSpeechFile(scene.narration, destination.id, wavPath, {
      forceLocal,
      speed,
      tailPause: studioSettings().scenePause,
    });
    result.providers.forEach((provider) => providers.add(provider));
    scenes.push({ ...scene, wavPath, start: elapsed, speechEnd: elapsed + result.speech, end: elapsed + result.total });
    elapsed += result.total;
  }
  return { scenes, providers, audioDuration: elapsed, speechDuration: scenes[scenes.length - 1].speechEnd };
}

async function generateQualifiedVideoPlan({ destination, idea, generationVersion, workDir, forceLocal = false }) {
  const recentScripts = recentVideoScripts(destination.id);
  const passage = destination.id === 'religioso' ? await chooseBiblePassage(idea, generationVersion, recentScripts, { forceLocal }) : null;
  if (passage) logStep(`pasaje elegido: ${passage[0]}`);
  let feedback = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const prompt = buildVideoPlanPrompt({ destination, idea, generationVersion, recentScripts, feedback, passage });
    assertAllowedText(prompt);
    logStep(`guion intento ${attempt} (${destination.id})`);
    const { value: rawPlan, provider: scriptProvider } = await withAiProvider(
      'guion',
      { forceLocal, primary: studioSettings().scriptProvider },
      () => requestVideoPlanLocal(prompt),
      () => requestVideoPlanOpenai(prompt),
    );
    const plan = cleanVideoPlan(rawPlan);
    const referenceInserted = passage ? ensureBibleReference(plan, passage) : false;
    if (referenceInserted) logStep(`cita ${passage[0]} insertada por el codigo`);
    writeJson(path.join(workDir, `plan-attempt-${attempt}.json`), plan);
    const script = plan.scenes.map((scene) => scene.narration).join(' ');
    assertAllowedText(script, plan.hook, idea, destination.caption);
    const quality = scriptQualityReport(script, destination, idea, recentScripts);
    const problems = [...videoPlanProblems(plan, destination), ...quality.problems];
    if (problems.length) {
      logStep(`guion rechazado (${wordCount(script)} palabras, ${plan.scenes.length} escenas): ${problems.join('; ')}`);
      feedback = problems;
      continue;
    }

    logStep(`locucion de ${plan.scenes.length} escenas`);
    let voice = await synthesizeScenes(plan, destination, workDir, { forceLocal });
    // Fuera de rango: primero se ajusta la velocidad de la voz (hasta ±15%) en vez de reescribir el guion.
    const outOfRange = voice.speechDuration < minimumNarrationSeconds + 0.5 || voice.speechDuration > maximumNarrationSeconds;
    if (outOfRange && voice.providers.has('local')) {
      const target = voice.speechDuration < minimumNarrationSeconds + 0.5 ? minimumNarrationSeconds + 3 : maximumNarrationSeconds - 5;
      const baseSpeed = localVoiceFor(destination.id).speed;
      const speed = Math.min(1.25, Math.max(0.82, baseSpeed * (voice.speechDuration / target)));
      logStep(`locucion de ${voice.speechDuration.toFixed(1)}s; ajustando velocidad a ${speed.toFixed(2)}`);
      voice = await synthesizeScenes(plan, destination, workDir, { forceLocal, speed });
    }
    const { scenes, providers, audioDuration, speechDuration } = voice;
    if (speechDuration < minimumNarrationSeconds) {
      logStep(`locucion corta: ${speechDuration.toFixed(1)}s`);
      feedback = [`la locucion duro ${speechDuration.toFixed(1)} segundos y necesita mas de ${minimumNarrationSeconds}; amplia el desarrollo sin repetir ideas`];
      continue;
    }
    if (speechDuration > maximumNarrationSeconds) {
      logStep(`locucion larga: ${speechDuration.toFixed(1)}s`);
      feedback = [`la locucion duro ${speechDuration.toFixed(1)} segundos y el maximo es ${maximumNarrationSeconds}; acorta cada escena sin perder el hilo`];
      continue;
    }
    const audioPath = path.join(workDir, 'voice.wav');
    const listPath = path.join(workDir, 'voice-list.txt');
    fs.writeFileSync(listPath, scenes.map((scene) => `file '${scene.wavPath.replace(/'/g, "'\\''")}'`).join('\n'), { mode: 0o600 });
    await runCommand('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', audioPath]);
    return {
      hook: plan.hook,
      scenes: scenes.map((scene) => ({ ...scene, visual: withProtagonist(scene.visual, plan.protagonist) })),
      script,
      audioPath,
      speechDuration,
      audioDuration,
      scriptQuality: quality,
      scriptAttempt: attempt,
      scriptModel: scriptProvider === 'local' ? `ollama:${ollamaScriptModel}` : openaiScriptModel,
      voiceProvider: [...providers].join('+'),
      bibleReference: passage ? passage[0] : null,
      bibleReferenceInserted: referenceInserted,
    };
  }
  const error = new Error('No se obtuvo un guion valido y una locucion de 60 a 95 segundos despues de 5 intentos; no se generaron imagenes.');
  error.code = 'SCRIPT_QUALITY_CHECK_FAILED';
  throw error;
}

function timingKey(value) {
  return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

// Reparte los tiempos de Whisper sobre las palabras del guion (el texto correcto),
// escena por escena, proporcional a las letras. Sin Whisper, reparte de forma lineal.
function timeScriptWords(scenes, sttWords) {
  const timed = [];
  for (const scene of scenes) {
    const words = scene.narration.split(/\s+/).filter(Boolean);
    const lengths = words.map((word) => Math.max(1, timingKey(word).length));
    const total = lengths.reduce((sum, value) => sum + value, 0);
    const heard = (sttWords || [])
      .filter((word) => {
        const middle = (Number(word.start) + Number(word.end)) / 2;
        return middle >= scene.start - 0.1 && middle <= scene.end + 0.1;
      })
      .map((word) => ({ start: Number(word.start), end: Number(word.end), length: Math.max(1, timingKey(word.word).length) }));
    const heardTotal = heard.reduce((sum, word) => sum + word.length, 0);
    const timeAt = (fraction) => {
      if (!heard.length) return scene.start + fraction * (scene.speechEnd - scene.start);
      let target = fraction * heardTotal;
      for (const word of heard) {
        if (target <= word.length) return word.start + (target / word.length) * (word.end - word.start);
        target -= word.length;
      }
      return heard[heard.length - 1].end;
    };
    let consumed = 0;
    words.forEach((word, index) => {
      const start = timeAt(consumed / total);
      consumed += lengths[index];
      const end = timeAt(consumed / total);
      timed.push({ word, start, end: Math.max(end, start + 0.08) });
    });
  }
  for (let index = 1; index < timed.length; index += 1) {
    if (timed[index].start < timed[index - 1].start) timed[index].start = timed[index - 1].start;
  }
  return timed;
}

function assText(value) {
  return String(value).replace(/[{}\\]/g, '').trim();
}

function buildKaraokeEvents(timedWords) {
  const chunks = [];
  let current = [];
  for (const item of timedWords) {
    const candidate = [...current, item].map((entry) => entry.word).join(' ');
    if (current.length && (current.length >= 3 || candidate.length > 18)) {
      chunks.push(current);
      current = [];
    }
    current.push(item);
    if (/[.,;:?!]$/.test(item.word)) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);
  const events = [];
  chunks.forEach((chunk, chunkIndex) => {
    const next = chunks[chunkIndex + 1];
    const lastEnd = chunk[chunk.length - 1].end;
    const chunkEnd = next && next[0].start - lastEnd < 0.6 ? next[0].start : lastEnd + 0.25;
    chunk.forEach((item, wordIndex) => {
      const start = wordIndex === 0 ? chunk[0].start : item.start;
      const end = wordIndex === chunk.length - 1 ? chunkEnd : chunk[wordIndex + 1].start;
      if (end - start < 0.02) return;
      const text = chunk.map((entry, index) => (
        index === wordIndex ? `{\\c&H00D7FF&}${assText(entry.word)}{\\c&HFFFFFF&}` : assText(entry.word)
      )).join(' ');
      events.push(`Dialogue: 1,${secondsToAssTime(start)},${secondsToAssTime(end)},Sub,,0,0,0,,${text}`);
    });
  });
  return events;
}

const imageReviewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matches: { type: 'boolean' },
    has_text: { type: 'boolean' },
    deformed: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['matches', 'has_text', 'deformed', 'reason'],
};

// El modelo local juzga cada imagen (tarea mas facil que escribir): ¿muestra lo pedido?
// ¿tiene letras o cuerpos deformes? Si falla la revision, la imagen se acepta igual.
async function reviewSceneImage(imagePath, scene) {
  const previewPath = `${imagePath}.review.jpg`;
  await runCommand('ffmpeg', ['-y', '-v', 'error', '-i', imagePath, '-vf', 'scale=448:-2', '-q:v', '4', previewPath]);
  const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ollamaScriptModel,
      messages: [{
        role: 'user',
        content: [
          `Requested photo: "${scene.visual}"`,
          'Check this image. matches: true if it clearly shows the main subject and action requested (small differences are fine).',
          'has_text: true only if there are visible letters, words, captions or logos.',
          'deformed: true only for obvious anatomy errors (extra or missing fingers or limbs, melted faces).',
          'reason: one short sentence. Answer in JSON.',
        ].join('\n'),
        images: [fs.readFileSync(previewPath).toString('base64')],
      }],
      format: imageReviewSchema,
      think: false,
      stream: false,
      options: { temperature: 0, num_predict: 200 },
    }),
    signal: AbortSignal.timeout(3 * 60 * 1000),
  });
  fs.rmSync(previewPath, { force: true });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Ollama vision HTTP ${response.status}`);
  const review = JSON.parse(payload.message?.content || '{}');
  return { ...review, passed: review.matches !== false && !review.has_text && !review.deformed };
}

const stockQueriesSchema = {
  type: 'object',
  properties: { queries: { type: 'array', items: { type: 'string' } } },
  required: ['queries'],
};
const stockFrameSchema = {
  type: 'object',
  properties: { shows: { type: 'string' }, has_text: { type: 'boolean' }, fits: { type: 'boolean' } },
  required: ['shows', 'has_text', 'fits'],
};
// El modelo a veces describe un logo y aun asi lo aprueba: se descarta por la descripcion misma.
const stockTextPattern = /\b(logos?|text|letters?|words?|signs?|signage|brand(ed|s)?|watermarks?|captions?|writing|written)\b|['"“‘][^'"”’]{2,}['"”’]/i;
const stockCreaturePattern = /\b(insects?|mantis|bees?|animals?|bugs?|spiders?|butterfl(y|ies))\b/i;

async function askLocalJson(content, schema, images) {
  const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ollamaScriptModel,
      messages: [{ role: 'user', content, ...(images ? { images } : {}) }],
      format: schema,
      think: false,
      stream: false,
      options: { temperature: 0, num_predict: 300 },
    }),
    signal: AbortSignal.timeout(3 * 60 * 1000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  return JSON.parse(payload.message?.content || '{}');
}

// Busca en Pixabay un clip real que sirva de toma de apoyo (sin caras: detalles, manos, luz, lugares).
// La protagonista sigue siendo la imagen IA; si nada encaja de verdad, devuelve null y queda la imagen.
async function findStockClip(scene, minSeconds, usedIds, workDir) {
  const visual = scene.visual.split('. The person is')[0];
  const { queries = [] } = await askLocalJson([
    `Scene of a short video: "${visual}"`,
    'Give 3 different 1-3 word English search queries for REAL stock B-roll video clips (Pixabay) that would fit this moment, from most specific to most generic.',
    'Use objects, close-up details, hands, light or places, NEVER words like woman/man/person/girl.',
    'Examples: "open bible pages", "praying hands", "sunlight window", "car steering wheel", "city street evening". JSON.',
  ].join('\n'), stockQueriesSchema);
  const framePath = path.join(workDir, 'stock-review.jpg');
  const tinyPath = path.join(workDir, 'stock-review.mp4');
  try {
    for (const query of queries.slice(0, 3)) {
      const url = `https://pixabay.com/api/videos/?key=${pixabayApiKey}&q=${encodeURIComponent(query)}&per_page=12&safesearch=true&video_type=film`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Pixabay HTTP ${response.status}`);
      const { hits = [] } = await response.json();
      const words = query.toLowerCase().split(/\s+/)
        .filter((word) => word.length > 3 && !['close-up', 'closeup'].includes(word))
        .map((word) => word.replace(/(ing|s)$/, ''));
      const candidates = hits
        .filter((hit) => !usedIds.has(hit.id) && hit.duration >= minSeconds + 1.5)
        // Solo 4K horizontal o video vertical: al recortar a 9:16 no se pierde nitidez.
        .filter((hit) => hit.videos.large.width >= 3840 || hit.videos.medium.height > hit.videos.medium.width)
        // "praying hands" trae mantis religiosas: sin bichos salvo que se pidan.
        .filter((hit) => stockCreaturePattern.test(hit.tags) === stockCreaturePattern.test(query))
        .filter((hit) => words.filter((word) => hit.tags.toLowerCase().includes(word)).length >= Math.ceil(words.length / 2))
        .slice(0, 4);
      for (const hit of candidates) {
        // La miniatura de Pixabay es el primer cuadro (a veces negro): se revisa un cuadro del medio.
        const tiny = await fetch(hit.videos.tiny.url, { signal: AbortSignal.timeout(60_000) });
        if (!tiny.ok) continue;
        fs.writeFileSync(tinyPath, Buffer.from(await tiny.arrayBuffer()));
        await runCommand('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.min(3, hit.duration / 2)), '-i', tinyPath, '-frames:v', '1', '-vf', 'scale=448:-2', framePath]);
        const review = await askLocalJson([
          'Frame from a stock video. First describe in a few words what it literally shows.',
          `Then: fits = true only if it clearly shows "${query}" and would work as B-roll for: "${visual}".`,
          'has_text: true if any logo, brand name, sign or readable words are visible.',
          'Animals or insects instead of people = false. Any logo or visible text = false. JSON.',
        ].join('\n'), stockFrameSchema, [fs.readFileSync(framePath).toString('base64')]);
        if (review.fits && !review.has_text && !stockTextPattern.test(review.shows || '')) {
          const video = hit.videos.medium.height > hit.videos.medium.width ? hit.videos.medium : hit.videos.large;
          return { id: hit.id, query, url: video.url, pageURL: hit.pageURL, user: hit.user, duration: hit.duration, shows: review.shows };
        }
      }
    }
    return null;
  } finally {
    fs.rmSync(framePath, { force: true });
    fs.rmSync(tinyPath, { force: true });
  }
}

const shotMotions = ['zoomin', 'panup', 'zoomout', 'panright', 'pandown', 'panleft'];

function shotFilter(motion, frames) {
  const last = Math.max(1, frames - 1);
  const p = `(on/${last})`;
  const center = { x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' };
  const motions = {
    zoomin: { z: `1+0.16*${p}`, ...center },
    zoomout: { z: `1.16-0.16*${p}`, ...center },
    panup: { z: '1.14', x: center.x, y: `(ih-ih/zoom)*(1-${p})` },
    pandown: { z: '1.14', x: center.x, y: `(ih-ih/zoom)*${p}` },
    panright: { z: '1.14', x: `(iw-iw/zoom)*${p}`, y: center.y },
    panleft: { z: '1.14', x: `(iw-iw/zoom)*(1-${p})`, y: center.y },
  };
  const m = motions[motion] || motions.zoomin;
  // Se trabaja a 2x para que el movimiento no tiemble al redondear pixeles.
  return [
    'scale=2160:3840:force_original_aspect_ratio=increase:flags=lanczos',
    'crop=2160:3840',
    `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${frames}:s=1080x1920:fps=${videoFps}`,
    'format=yuv420p',
  ].join(',');
}

// Z-Image no recuerda entre escenas: se repite el mismo aspecto donde aparece una persona.
function withProtagonist(visual, protagonist) {
  if (!protagonist || !/\b(woman|man|person|girl|boy|she|he|her|his|lady|guy|someone|protagonist)\b/i.test(visual)) return visual;
  return `${visual} The person is ${protagonist}.`;
}

function sceneImagePrompt(destination, scene) {
  const style = destination.id === 'religioso'
    ? 'Photorealistic vertical photograph, warm natural light, soft golden tones, hopeful and peaceful mood, shallow depth of field, rich detail, cinematic color grading.'
    : 'Photorealistic vertical photograph, cinematic lighting, vibrant movie-night colors, fun and dramatic mood, rich detail, cinematic color grading.';
  // Estas palabras hacen que Z-Image dibuje letras (dialogos, carteles, subtitulos).
  const visual = scene.visual
    .replace(/\b(dialogues?|subtitles?|captions?|quotes?|quotation|speech bubbles?|posters?|signs?|signboards?|billboards?|banners?|labels?|headlines?|newspapers?|text|words|letters|lyrics)\b/gi, '')
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s{2,}/g, ' ');
  return `${visual} ${style} Clean image without any text, letters, captions, logos or watermark; no famous people.`;
}

async function probeMediaDuration(file) {
  const probe = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ]);
  const duration = Number(probe.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('No se pudo medir la duracion del audio.');
  return duration;
}

async function generateOpenAiImage(prompt) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  assertAllowedText(prompt);
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openaiApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: '1024x1536',
      quality: 'high',
      output_format: 'png',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerCode = payload.error?.code || `HTTP_${response.status}`;
    setServiceStatus('media_provider', 'blocked', { code: providerCode });
    const error = new Error(
      providerCode === 'billing_hard_limit_reached'
        ? 'Proveedor multimedia bloqueado por limite de facturacion.'
        : `Proveedor multimedia no disponible (${providerCode}).`,
    );
    error.code = providerCode;
    throw error;
  }
  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error('OpenAI image generation did not return b64_json');
  }
  setServiceStatus('media_provider', 'ready');
  return Buffer.from(b64, 'base64');
}

function parseVideoCommand(command) {
  const normalized = String(command || '').toUpperCase();
  const destinationId = resolveDestination(normalized) || (normalized.includes('VIDEO') ? 'religioso' : null);
  const ideaIndex = Math.max(0, Math.min(2, Number(normalized.match(/\b([123])\b/)?.[1] || '1') - 1));
  const plan = buildMultiplatformPlan();
  const destination = plan.destinations.find((item) => item.id === destinationId);
  if (!destination) {
    throw new Error('Destino de video no reconocido. Usa APROBAR REEL ESFERACLICK 1 o APROBAR VIDEO RELIGIOSO 1.');
  }
  const facebook = facebookDestinations[destination.id];
  const idea = polishSpanishText(destination.videoIdeas[ideaIndex]);
  assertAllowedText(idea, destination.caption);
  return {
    plan,
    destination,
    facebook,
    idea,
    ideaIndex,
    contentKey: normalizeContentKey(idea),
    contentId: contentItemId('VID'),
  };
}

function videoGenerationContext(destinationId, contentKey) {
  const related = generatedVideoCandidates(destinationId)
    .filter((item) => item.metadata?.contentKey === contentKey);
  const superseded = related.find((item) => (
    item.metadata?.rejected_at || findContentItem(item.metadata?.contentId)?.status === 'rejected'
  ));
  return {
    generationVersion: related.length + 1,
    supersedesContentId: superseded?.metadata?.contentId || null,
  };
}

async function renderAutomatedVideo({
  destination,
  facebook,
  idea,
  ideaIndex,
  contentId,
  contentKey,
  generationVersion = 1,
  supersedesContentId = null,
  test = false,
  forceLocal = false,
  cinematicLook = studioSettings().cinematicLook,
  realClips = studioSettings().realClips,
}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const slug = `auto-${stamp}-${destination.id}-${ideaIndex + 1}`.replace(/[^a-z0-9-]+/g, '-');
  // Las pruebas van a otra carpeta para no entrar en la cola de aprobacion.
  const videosDir = path.join(dataDir, test ? 'test-videos' : 'generated-videos');
  const workDir = path.join(videosDir, slug);
  fs.mkdirSync(workDir, { recursive: true });
  const assPath = path.join(workDir, 'subs.ass');
  const concatPath = path.join(workDir, 'concat.txt');
  const metaPath = path.join(workDir, 'metadata.json');
  const outputName = `${slug}.mp4`;
  const outputPath = path.join(videosDir, outputName);
  const startedAt = Date.now();
  logStep(`inicio ${slug}: ${idea}`);

  const narration = await generateQualifiedVideoPlan({
    destination,
    idea,
    generationVersion,
    workDir,
    forceLocal,
  });
  const { script, scenes, speechDuration, audioPath } = narration;
  const duration = Math.max(minimumVideoSeconds, Math.ceil((narration.audioDuration + 0.6) * 10) / 10);

  logStep('sincronizando subtitulos');
  let sttWords = [];
  let subtitleTiming = 'whisper';
  try {
    sttWords = (await withAiProvider(
      'subtitulos',
      { forceLocal },
      () => transcribeWordsLocal(fs.readFileSync(audioPath)),
      () => transcribeWordsOpenai(fs.readFileSync(audioPath)),
    )).value;
  } catch (error) {
    subtitleTiming = 'proporcional';
    logStep(`sin marcas de tiempo (${error.message}); subtitulos proporcionales`);
  }
  const timedWords = timeScriptWords(scenes, sttWords);
  const title = polishSpanishText(idea);
  const hook = narration.hook || title;
  const displayBrand = displayBrandForDestination(destination);
  fs.writeFileSync(assPath, `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,DejaVu Sans,84,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,7,3,2,70,70,560,1
Style: Hook,DejaVu Sans,76,&H00FFFFFF,&H000000FF,&H00000000,&H50000000,1,0,0,0,100,100,0,0,3,22,0,8,80,80,170,1
Style: Brand,DejaVu Sans,36,&H00FFFFFF,&H000000FF,&H00000000,&H78000000,1,0,0,0,100,100,0,0,3,10,0,7,50,50,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 2,${secondsToAssTime(0)},${secondsToAssTime(duration)},Brand,,0,0,0,,${assText(displayBrand)}
Dialogue: 2,${secondsToAssTime(0)},${secondsToAssTime(3.2)},Hook,,0,0,0,,{\\fad(150,250)}${wrapSubtitle(assText(hook), 20)}
${buildKaraokeEvents(timedWords).join('\n')}
`, { mode: 0o600 });

  // Una imagen por escena; las escenas largas se dividen en dos tomas con movimientos distintos.
  const shots = [];
  scenes.forEach((scene, index) => {
    const start = scene.start;
    const end = index === scenes.length - 1 ? duration : scene.end;
    if (end - start > 7) {
      const middle = (start + end) / 2;
      shots.push({ scene: index, start, end: middle }, { scene: index, start: middle, end });
    } else {
      shots.push({ scene: index, start, end });
    }
  });
  const imageProviders = new Set();
  const sceneFiles = [];
  for (const [index, scene] of scenes.entries()) {
    const imagePath = path.join(workDir, `scene-${index + 1}.png`);
    if (!fs.existsSync(imagePath)) {
      logStep(`imagen ${index + 1}/${scenes.length}`);
      const { value: image, provider } = await generateImage(sceneImagePrompt(destination, scene), {
        size: localVideoImageSize,
        forceLocal,
      });
      imageProviders.add(provider);
      fs.writeFileSync(imagePath, image, { mode: 0o600 });
    }
    scene.imagePath = imagePath;
  }
  // Revision visual: cada imagen rechazada se regenera y se vuelve a revisar (hasta 2 veces por imagen,
  // 5 por video). Si aun asi tiene letras, se reutiliza la imagen aprobada de la escena anterior.
  const imageReviews = [];
  if (imageProviders.has('local')) {
    let regenerations = 0;
    let reviewAvailable = true;
    for (const [index, scene] of scenes.entries()) {
      if (!reviewAvailable) break;
      for (let round = 0; ; round += 1) {
        let review;
        try {
          review = await reviewSceneImage(scene.imagePath, scene);
        } catch (error) {
          logStep(`revision de imagen ${index + 1} no disponible: ${error.message}`);
          reviewAvailable = false;
          break;
        }
        imageReviews.push({ scene: index + 1, round, ...review });
        if (review.passed) break;
        if (round >= 2 || regenerations >= 5) {
          const previous = scenes.slice(0, index).reverse().find((item) => item.reviewPassed);
          if (review.has_text && previous) {
            logStep(`imagen ${index + 1} sigue con letras; se reutiliza la de la escena ${scenes.indexOf(previous) + 1}`);
            fs.copyFileSync(previous.imagePath, scene.imagePath);
          }
          break;
        }
        regenerations += 1;
        logStep(`imagen ${index + 1} rechazada (${review.reason}); regenerando`);
        const { value: image } = await generateImage(sceneImagePrompt(destination, scene), { size: localVideoImageSize, forceLocal });
        fs.renameSync(scene.imagePath, scene.imagePath.replace(/\.png$/, `-rejected-${round + 1}.png`));
        fs.writeFileSync(scene.imagePath, image, { mode: 0o600 });
      }
      scene.reviewPassed = imageReviews.some((review) => review.scene === index + 1 && review.passed);
    }
  }
  // Clips reales: la segunda toma de cada escena larga puede ser un clip de Pixabay (toma de apoyo).
  const stockClips = [];
  if (realClips && pixabayApiKey) {
    const usedIds = new Set();
    for (const [index, shot] of shots.entries()) {
      if (stockClips.length >= 5 || shots[index - 1]?.scene !== shot.scene) continue;
      logStep(`buscando clip real para la escena ${shot.scene + 1}`);
      try {
        const clip = await findStockClip(scenes[shot.scene], shot.end - shot.start, usedIds, workDir);
        if (!clip) continue;
        const sourcePath = path.join(workDir, `stock-${clip.id}.mp4`);
        const download = await fetch(clip.url, { signal: AbortSignal.timeout(3 * 60 * 1000) });
        if (!download.ok) throw new Error(`descarga HTTP ${download.status}`);
        fs.writeFileSync(sourcePath, Buffer.from(await download.arrayBuffer()), { mode: 0o600 });
        usedIds.add(clip.id);
        shot.stockPath = sourcePath;
        stockClips.push({ scene: shot.scene + 1, id: clip.id, query: clip.query, shows: clip.shows, page_url: clip.pageURL, user: clip.user });
        logStep(`escena ${shot.scene + 1}: clip real "${clip.query}" (${clip.pageURL})`);
      } catch (error) {
        logStep(`clip real no disponible para la escena ${shot.scene + 1}: ${error.message}`);
      }
    }
  } else if (realClips) {
    logStep('clips reales activados pero falta PIXABAY_API_KEY; se usan solo imagenes');
  }
  logStep(`animando ${shots.length} tomas`);
  for (const [index, shot] of shots.entries()) {
    const frames = Math.max(2, Math.round(shot.end * videoFps) - Math.round(shot.start * videoFps));
    const clipPath = path.join(workDir, `shot-${String(index + 1).padStart(2, '0')}.mp4`);
    const input = shot.stockPath
      ? ['-ss', '1', '-i', shot.stockPath, '-vf', `scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,fps=${videoFps},format=yuv420p`]
      : ['-i', scenes[shot.scene].imagePath, '-vf', shotFilter(shotMotions[index % shotMotions.length], frames)];
    await runCommand('ffmpeg', [
      '-y', '-v', 'error',
      ...input,
      '-frames:v', String(frames),
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-r', String(videoFps),
      '-pix_fmt', 'yuv420p',
      clipPath,
    ]);
    sceneFiles.push(clipPath);
  }
  fs.writeFileSync(
    concatPath,
    sceneFiles.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
    { mode: 0o600 },
  );
  const baseVideoPath = path.join(workDir, 'visual.mp4');
  await runCommand('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', baseVideoPath]);

  logStep('montaje final');
  // El look va antes de los subtitulos para que el texto no tiemble ni tenga grano.
  const filter = [
    ...(cinematicLook ? [cinematicLookFilter] : []),
    `ass=${ffmpegPath(assPath)}`,
    'fade=t=in:st=0:d=0.25',
    `fade=t=out:st=${(duration - 0.4).toFixed(2)}:d=0.4`,
    'format=yuv420p',
  ].join(',');
  await runCommand('ffmpeg', [
    '-y', '-v', 'error',
    '-i', baseVideoPath,
    '-i', audioPath,
    '-vf', filter,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-maxrate', '4M',
    '-bufsize', '8M',
    '-pix_fmt', 'yuv420p',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-t', String(duration),
    outputPath,
  ]);

  const qualityProbe = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate,duration',
    '-show_entries', 'format=duration,size',
    '-of', 'json',
    outputPath,
  ]);
  const quality = JSON.parse(qualityProbe.stdout || '{}');
  const videoStream = quality.streams?.find((stream) => stream.codec_type === 'video') || {};
  const outputDuration = Number(quality.format?.duration || 0);
  const outputSize = Number(quality.format?.size || 0);
  const trailingSilence = Math.max(0, outputDuration - speechDuration);
  if (
    videoStream.width !== 1080
    || videoStream.height !== 1920
    || outputDuration < minimumVideoSeconds
    || speechDuration < minimumNarrationSeconds
    || trailingSilence > 2
    || outputSize < 500_000
  ) {
    const error = new Error('El MP4 no supero el control tecnico de calidad.');
    error.code = 'VIDEO_QUALITY_CHECK_FAILED';
    throw error;
  }

  const result = {
    contentId,
    fileName: outputName,
    video_url: test ? null : `${appBaseUrl}/media/video/${outputName}`,
    title,
    hook,
    description: polishSpanishText(`${idea}\n\n${destination.caption}`),
    script,
    scenes: scenes.map((scene) => ({
      narration: scene.narration,
      visual: scene.visual,
      start: Number(scene.start.toFixed(2)),
      end: Number(scene.end.toFixed(2)),
    })),
    duration,
    speech_duration: speechDuration,
    trailing_silence: trailingSilence,
    script_model: narration.scriptModel,
    script_attempt: narration.scriptAttempt,
    script_quality: narration.scriptQuality,
    ai_providers: {
      script: narration.scriptModel,
      voice: narration.voiceProvider,
      images: [...imageProviders].join('+') || 'cache',
      subtitles: subtitleTiming,
    },
    bible_reference: narration.bibleReference,
    bible_reference_inserted: narration.bibleReferenceInserted,
    image_reviews: imageReviews,
    cinematic_look: cinematicLook,
    stock_clips: stockClips,
    render_seconds: Math.round((Date.now() - startedAt) / 1000),
    generation_version: generationVersion,
    supersedes_content_id: supersedesContentId,
    destinationId: destination.id,
    destination: destination.destination,
    idea,
    ideaIndex,
    contentKey,
    displayBrand,
    facebookPageId: facebook?.pageId || null,
    facebookPageName: facebook?.pageName || null,
    youtubeChannelKey: destination.youtubeChannelKey || null,
    youtubeChannelLabel: destination.youtubeChannelKey ? youtubeChannels[destination.youtubeChannelKey]?.label : null,
    shouldPublishYouTube: Boolean(destination.youtubeChannelKey),
    tiktokEligibleDuration: duration >= 61,
    quality: {
      width: videoStream.width,
      height: videoStream.height,
      frame_rate: videoStream.r_frame_rate,
      duration: outputDuration,
      speech_duration: speechDuration,
      trailing_silence: trailingSilence,
      bytes: outputSize,
      passed: true,
    },
    visual_engine: `scene-matched-${imageProviders.has('openai') ? 'mixed' : 'zimage'}-kenburns-karaoke-v3`,
    style_version: 3,
    test,
    telegram_send_allowed: !test,
  };
  writeJson(metaPath, result);
  // Los intermedios pesan ~60 MB por video; se conservan las imagenes, el guion y la voz final.
  for (const file of [...sceneFiles, baseVideoPath, concatPath, ...scenes.map((scene) => scene.wavPath), ...shots.map((shot) => shot.stockPath).filter(Boolean)]) {
    fs.rmSync(file, { force: true });
  }
  logStep(`listo ${outputName} en ${result.render_seconds}s`);
  if (test) return result;
  appendContentHistory({
    type: 'video_preview_generated',
    contentId,
    destinationId: destination.id,
    idea,
    ideaIndex,
    title,
    fileName: outputName,
  });
  upsertContentItem({
    contentId,
    type: 'video',
    status: 'preview_ready',
    destinationId: destination.id,
    destination: destination.destination,
    idea,
    contentKey,
    ideaIndex,
    fileName: outputName,
    video_url: result.video_url,
    description: result.description,
    quality: result.quality,
    script: result.script,
    speech_duration: result.speech_duration,
    script_model: result.script_model,
    script_quality: result.script_quality,
    generation_version: result.generation_version,
    supersedes_content_id: result.supersedes_content_id,
    facebookPageId: result.facebookPageId,
    youtubeChannelKey: result.youtubeChannelKey,
    tiktokManual: result.destinationId === 'religioso',
  });
  return result;
}

async function publishFacebookReel({ pageId, videoUrl, description }) {
  if (!facebookPublishingEnabled) {
    return { skipped: true, reason: 'Facebook deshabilitado temporalmente.' };
  }
  const response = await fetch(`${facebookRewardsBaseUrl}/internal/contentcreator/facebook-reel`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': internalToken,
    },
    body: JSON.stringify({ pageId, videoUrl, description }),
  });
  const payload = await response.json();
  if (!response.ok) {
    return { ok: false, error: payload.error || `Facebook Reel failed: ${response.status}` };
  }
  return payload;
}

async function produceAndPublishVideo(command, { publish = false, source = 'telegram', customIdea = null } = {}) {
  const parsed = parseVideoCommand(command);
  if (customIdea) applyCustomIdea(parsed, customIdea);
  if (!parsed.destination.youtubeChannelKey) {
    throw new Error('Este destino no tiene canal de YouTube/TikTok habilitado temporalmente.');
  }
  const existingPreview = !publish
    ? pendingPreviewForContentKey(parsed.destination.id, parsed.contentKey)
    : null;
  let lockFile = null;
  let video = existingPreview?.metadata || null;
  if (!video) {
    lockFile = acquireGenerationLock(parsed.destination.id, parsed.contentKey);
    try {
      const previewAfterLock = pendingPreviewForContentKey(parsed.destination.id, parsed.contentKey);
      if (previewAfterLock) {
        video = previewAfterLock.metadata;
      } else {
        const generationContext = videoGenerationContext(parsed.destination.id, parsed.contentKey);
        video = await runVideoJob(
          source,
          `${parsed.destination.id}: ${parsed.idea}`,
          () => renderAutomatedVideo({ ...parsed, ...generationContext }),
        );
      }
    } finally {
      releaseGenerationLock(lockFile);
    }
  }
  const shouldSendTelegramVideo = !video.telegram_sent_at && !isRejectedVideoCandidate({ metadata: video });
  let facebook = { skipped: true, reason: 'Facebook deshabilitado temporalmente.' };
  let youtube = { skipped: true, reason: 'Preview generado; YouTube no se publica hasta confirmar calidad del video.' };
  if (publish && video.facebookPageId) {
    facebook = await publishFacebookReel({
      pageId: video.facebookPageId,
      videoUrl: video.video_url,
      description: video.description,
    });
  } else if (publish) {
    facebook = { skipped: true, reason: 'Este destino no tiene pagina Facebook configurada.' };
  }
  if (publish && video.shouldPublishYouTube) {
    try {
      youtube = await uploadYouTubeVideo({
        fileName: video.fileName,
        title: video.title,
        description: video.description,
        privacyStatus: 'private',
        tags: ['Fe', 'Dios', 'Oracion', 'Devocional', 'Cristianos', 'Shorts'],
        channelKey: video.youtubeChannelKey || defaultYouTubeChannelKey,
      });
    } catch (error) {
      youtube = {
        ok: false,
        error: error.message,
        code: error.code || 'YOUTUBE_UPLOAD_FAILED',
        reconnect_url: error.reconnect_url,
      };
    }
  }
  return {
    ok: true,
    mode: publish ? 'published' : (existingPreview ? 'preview_existing' : 'preview'),
    video,
    contentId: video.contentId,
    approval_command: `APROBAR ${video.contentId}`,
    rejection_command: `RECHAZAR ${video.contentId}`,
    facebook,
    youtube,
    telegram: {
      send_video: shouldSendTelegramVideo,
      reason: shouldSendTelegramVideo
        ? 'Enviar MP4 de preview a Telegram.'
        : 'Preview ya enviado anteriormente a Telegram; no se reenvia para evitar duplicados.',
    },
    tiktok: {
      manual_required: video.destinationId === 'religioso',
      reason: video.destinationId === 'religioso'
        ? 'Vida con Dios es la unica cuenta con TikTok; se envia MP4 para carga manual.'
        : 'Este destino no tiene cuenta TikTok configurada.',
    },
  };
}

function generatedVideoForApproval(command) {
  const contentId = contentIdFromCommand(command, 'VID');
  if (contentId && findContentItem(contentId)?.status === 'published') {
    const done = generatedVideoForContentId(contentId);
    if (done && publishedOk(done.metadata?.publish_result)) throw new Error(`El video ${contentId} ya esta publicado.`);
  }
  if (contentId) {
    const exact = generatedVideoForContentId(contentId);
    if (!exact) throw new Error(`No existe un preview con ID ${contentId}.`);
    return exact;
  }
  const destinationId = resolveDestination(command);
  if (!destinationId) {
    throw new Error('La aprobacion necesita el ID exacto mostrado junto al preview.');
  }
  const candidates = generatedVideoCandidates(destinationId)
    .filter((item) => (
      isReviewableVideoCandidate(item)
      && !item.metadata?.published_at
      && !item.metadata?.rejected_at
    ));
  if (candidates.length !== 1) {
    throw new Error(`Hay ${candidates.length} previews pendientes para ${destinationId}. Usa APROBAR VID-... con el ID exacto.`);
  }
  return candidates[0];
}

function publishedOk(entry) {
  return Boolean(entry?.youtube?.ok || entry?.facebook?.ok);
}

function youtubeTagsFor(destinationId) {
  return destinationId === 'religioso'
    ? ['Fe', 'Dios', 'Oración', 'Devocional', 'Cristianos', 'Shorts']
    : ['Peliculas', 'Novelas', 'Entretenimiento', 'Shorts'];
}

function cleanPublishOptions(options = {}) {
  const clean = {};
  if (['public', 'unlisted', 'private'].includes(options.privacyStatus)) clean.privacyStatus = options.privacyStatus;
  const title = String(options.title || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  if (title) clean.title = title.slice(0, 100);
  const description = String(options.description || '').replace(/[<>]/g, '').trim();
  if (description) clean.description = description.slice(0, 4900);
  if (Array.isArray(options.tags)) {
    clean.tags = options.tags.map((tag) => String(tag).replace(/[<>,#]/g, '').trim()).filter(Boolean).slice(0, 15);
  }
  return clean;
}

async function publishGeneratedVideo(command, options = {}) {
  const selected = generatedVideoForApproval(command);
  const overrides = cleanPublishOptions(options);
  const video = { ...(selected.metadata || {}), ...('title' in overrides ? { title: overrides.title } : {}), ...('description' in overrides ? { description: overrides.description } : {}) };
  if (!video.fileName || !video.video_url) {
    throw new Error('El preview seleccionado no tiene metadata completa para publicar.');
  }
  if (video.rejected_at) {
    throw new Error(`El contenido ${video.contentId} fue rechazado y no se puede publicar.`);
  }
  if (!video.published_at && video.contentKey) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const repeatedPublication = readContentItems().find((item) => (
      item.contentId !== video.contentId
      && item.contentKey === video.contentKey
      && item.status === 'published'
      && Date.parse(item.published_at || '') >= cutoff
    ));
    if (repeatedPublication) {
      throw new Error(`El tema ya fue publicado con ${repeatedPublication.contentId} dentro de los ultimos 7 dias.`);
    }
  }

  const videoPublishLog = readJson(videoPublishLogPath, []);
  const existing = videoPublishLog.find((entry) => entry.fileName === video.fileName && entry.mode === 'published' && publishedOk(entry));
  if (existing) {
    return {
      ok: true,
      mode: 'already_published',
      video,
      facebook: existing.facebook || { skipped: true, reason: 'Ya publicado anteriormente.' },
      youtube: existing.youtube || { skipped: true, reason: 'Ya publicado anteriormente.' },
      tiktok: {
        manual_required: true,
        reason: 'TikTok API pendiente de aprobacion Content Posting API; usa el MP4 enviado por Telegram.',
      },
    };
  }

  const facebook = facebookPublishingEnabled && video.facebookPageId
    ? await publishFacebookReel({
      pageId: video.facebookPageId,
      videoUrl: video.video_url,
      description: video.description,
    })
    : { skipped: true, reason: facebookPublishingEnabled ? 'Este destino no tiene pagina Facebook configurada.' : 'Facebook deshabilitado temporalmente.' };

  let youtube = { skipped: true, reason: 'YouTube solo se publica automaticamente para destino religioso.' };
  if (video.shouldPublishYouTube) {
    try {
      youtube = await uploadYouTubeVideo({
        fileName: video.fileName,
        title: video.title,
        description: video.description,
        privacyStatus: overrides.privacyStatus || 'public',
        tags: overrides.tags || youtubeTagsFor(video.destinationId),
        channelKey: video.youtubeChannelKey || defaultYouTubeChannelKey,
      });
    } catch (error) {
      youtube = {
        ok: false,
        error: error.message,
        code: error.code || 'YOUTUBE_UPLOAD_FAILED',
        reconnect_url: error.reconnect_url || null,
        channelKey: video.youtubeChannelKey || defaultYouTubeChannelKey,
      };
    }
  }

  const attemptedAt = new Date().toISOString();
  if (!publishedOk({ facebook, youtube })) {
    // Ninguna plataforma lo acepto: queda como "fallo la publicacion" para reintentar, no como publicado.
    writeJson(selected.metadataPath, { ...video, last_publish_error: { at: attemptedAt, facebook, youtube } });
    upsertContentItem({
      ...(findContentItem(video.contentId) || {}),
      contentId: video.contentId,
      status: 'publish_failed',
      title: video.title,
      description: video.description,
      last_publish_error: { at: attemptedAt, facebook, youtube },
    });
    appendVideoPublishLog({ mode: 'publish_failed', fileName: video.fileName, destinationId: video.destinationId, contentId: video.contentId, facebook, youtube });
    return {
      ok: false,
      mode: 'publish_failed',
      contentId: video.contentId,
      error: youtube.error || facebook.error || facebook.reason || 'Ninguna plataforma acepto el video.',
      reconnect_url: youtube.reconnect_url || null,
      video,
      facebook,
      youtube,
    };
  }

  const tiktok = await sendGeneratedVideoToTikTok(video);
  const published = {
    mode: 'published',
    fileName: video.fileName,
    destinationId: video.destinationId,
    contentId: video.contentId,
    facebook,
    youtube,
    tiktok,
  };
  appendVideoPublishLog(published);
  appendContentHistory({
    type: 'video_published',
    contentId: video.contentId,
    destinationId: video.destinationId,
    idea: video.idea || video.title,
    ideaIndex: video.ideaIndex,
    title: video.title,
    fileName: video.fileName,
  });
  writeJson(selected.metadataPath, {
    ...video,
    published_at: new Date().toISOString(),
    publish_result: { facebook, youtube, tiktok },
  });
  upsertContentItem({
    ...(findContentItem(video.contentId) || {}),
    contentId: video.contentId,
    status: 'published',
    title: video.title,
    description: video.description,
    published_at: new Date().toISOString(),
    publish_result: { facebook, youtube, tiktok },
    last_publish_error: null,
  });

  return {
    ok: true,
    mode: 'published',
    video,
    facebook,
    youtube,
    tiktok,
  };
}

function rejectContent(command) {
  const contentId = contentIdFromCommand(command);
  if (!contentId) throw new Error('Usa RECHAZAR seguido del ID exacto del contenido.');
  const item = findContentItem(contentId);
  if (!item) throw new Error(`No existe contenido con ID ${contentId}.`);
  if (item.status === 'published' || item.status === 'scheduled') {
    throw new Error(`El contenido ${contentId} ya fue enviado a una plataforma y no puede rechazarse desde esta cola.`);
  }
  if (item.status === 'rejected') {
    return {
      ok: true,
      mode: 'already_rejected',
      contentId,
      item,
      message: `El contenido ${contentId} ya estaba rechazado. No se regenera ni se reenvia.`,
    };
  }
  const rejectedAt = new Date().toISOString();
  const updated = upsertContentItem({
    ...item,
    status: 'rejected',
    rejected_at: rejectedAt,
    telegram_send_allowed: false,
    delivery_blocked_at: rejectedAt,
  });
  if (item.type === 'video') {
    const generated = generatedVideoForContentId(contentId);
    if (generated) {
      writeJson(generated.metadataPath, {
        ...generated.metadata,
        rejected_at: rejectedAt,
        telegram_send_allowed: false,
        delivery_blocked_at: rejectedAt,
      });
    }
  }
  appendContentHistory({
    type: `${item.type || 'content'}_rejected`,
    contentId,
    destinationId: item.destinationId,
    idea: item.idea,
    contentKey: item.contentKey,
  });
  return {
    ok: true,
    mode: 'rejected',
    contentId,
    item: updated,
    message: `Contenido ${contentId} rechazado. Esta version quedo invalidada y no se publicara ni se reenviara. Si vuelves a generar el tema, se creara una version nueva con otro ID.`,
  };
}

function videoDeliveryStatus(contentIdValue) {
  const contentId = String(contentIdValue || '').trim().toUpperCase();
  const item = findContentItem(contentId);
  const generated = generatedVideoForContentId(contentId);
  if (!item || item.type !== 'video' || !generated) {
    return { ok: false, allowed: false, contentId, reason: 'El preview solicitado no existe.' };
  }
  if (item.status === 'rejected' || isRejectedVideoCandidate(generated)) {
    return { ok: true, allowed: false, contentId, reason: 'La version fue rechazada y su entrega esta bloqueada.' };
  }
  if (item.telegram_sent_at || generated.metadata?.telegram_sent_at) {
    return { ok: true, allowed: false, contentId, reason: 'El preview ya fue entregado y no se reenvia.' };
  }
  return { ok: true, allowed: true, contentId, reason: 'Preview vigente y pendiente de entrega.' };
}

async function buildYouTubeReportFromAccessToken(accessToken, channelKey = defaultYouTubeChannelKey) {
  const key = resolveYouTubeChannelKey(channelKey);
  const channels = await googleGet(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
    accessToken,
  );
  const channel = channels.items?.[0];
  if (!channel) {
    throw new Error('No YouTube channel found for the connected account');
  }

  let analytics = null;
  try {
    const params = new URLSearchParams({
      ids: 'channel==MINE',
      startDate: dateDaysAgo(7),
      endDate: dateDaysAgo(1),
      metrics: 'views,likes,comments,subscribersGained',
      dimensions: 'day',
      sort: 'day',
    });
    analytics = await googleGet(`https://youtubeanalytics.googleapis.com/v2/reports?${params}`, accessToken);
  } catch (error) {
    analytics = { error: error.message };
  }

  return {
    connected: true,
    channelKey: key,
    channelLabel: youtubeChannels[key].label,
    generated_at: new Date().toISOString(),
    channel: {
      id: channel.id,
      title: channel.snippet?.title || '',
      description: channel.snippet?.description || '',
      customUrl: channel.snippet?.customUrl || '',
      thumbnails: channel.snippet?.thumbnails || {},
      statistics: {
        viewCount: Number(channel.statistics?.viewCount || 0),
        subscriberCount: channel.statistics?.hiddenSubscriberCount ? null : Number(channel.statistics?.subscriberCount || 0),
        hiddenSubscriberCount: Boolean(channel.statistics?.hiddenSubscriberCount),
        videoCount: Number(channel.statistics?.videoCount || 0),
      },
    },
    analytics_7d: analytics,
  };
}

async function getYouTubeReport(channelKey = defaultYouTubeChannelKey) {
  const key = resolveYouTubeChannelKey(channelKey);
  const reportTokenPath = youtubeTokenPathForChannel(key);
  const token = await refreshAccessToken(readJson(reportTokenPath), reportTokenPath);
  return buildYouTubeReportFromAccessToken(token.access_token, key);
}

function youtubeChannelKeyForId(channelId) {
  return Object.entries(youtubeChannels)
    .find(([, config]) => config.expectedChannelId === channelId)?.[0] || null;
}

async function accessTokenForAnyConnectedYouTubeChannel() {
  for (const key of Object.keys(youtubeChannels)) {
    try {
      const tokenPathForKey = youtubeTokenPathForChannel(key);
      const token = await refreshAccessToken(readJson(tokenPathForKey), tokenPathForKey);
      if (token?.access_token) return token.access_token;
    } catch {}
  }
  throw new Error('No connected YouTube token available for public channel lookup');
}

async function getPublicYouTubeChannelReport(channelKey, originalError = null) {
  const key = resolveYouTubeChannelKey(channelKey);
  const expectedChannelId = youtubeChannels[key].expectedChannelId;
  if (!expectedChannelId) throw originalError || new Error('No expected channel ID configured');
  const accessToken = await accessTokenForAnyConnectedYouTubeChannel();
  const payload = await googleGet(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(expectedChannelId)}`,
    accessToken,
  );
  const channel = payload.items?.[0];
  if (!channel) throw originalError || new Error('Expected YouTube channel was not found by ID');
  return {
    connected: false,
    public_metrics: true,
    oauth_required: true,
    channelKey: key,
    channelLabel: youtubeChannels[key].label,
    expectedChannelId,
    error: originalError?.message || null,
    connect_url: `${appBaseUrl}/youtube/start?channel=${key}`,
    generated_at: new Date().toISOString(),
    channel: {
      id: channel.id,
      title: channel.snippet?.title || '',
      description: channel.snippet?.description || '',
      customUrl: channel.snippet?.customUrl || '',
      thumbnails: channel.snippet?.thumbnails || {},
      statistics: {
        viewCount: Number(channel.statistics?.viewCount || 0),
        subscriberCount: channel.statistics?.hiddenSubscriberCount ? null : Number(channel.statistics?.subscriberCount || 0),
        hiddenSubscriberCount: Boolean(channel.statistics?.hiddenSubscriberCount),
        videoCount: Number(channel.statistics?.videoCount || 0),
      },
    },
    analytics_7d: { error: 'OAuth del canal requerido para Analytics 7d' },
  };
}

async function getYouTubeReports() {
  const reports = {};
  for (const key of Object.keys(youtubeChannels)) {
    try {
      reports[key] = await getYouTubeReport(key);
    } catch (error) {
      try {
        reports[key] = await getPublicYouTubeChannelReport(key, error);
      } catch {
        reports[key] = {
          connected: false,
          channelKey: key,
          channelLabel: youtubeChannels[key].label,
          expectedChannelId: youtubeChannels[key].expectedChannelId,
          error: error.message,
          connect_url: `${appBaseUrl}/youtube/start?channel=${key}`,
        };
      }
    }
  }
  return {
    connected: Object.values(reports).some((item) => item.connected),
    generated_at: new Date().toISOString(),
    channels: reports,
    primary: reports[defaultYouTubeChannelKey],
  };
}

function buildReligiousContentPlan() {
  const today = new Date().toISOString().slice(0, 10);
  const themes = [
    {
      title: 'Cuando sientes que Dios esta en silencio',
      hook: 'Si sientes que Dios esta en silencio, este recordatorio es para ti.',
      verse: 'Salmo 46:10',
      angle: 'animo',
    },
    {
      title: 'Una oracion antes de tomar una decision dificil',
      hook: 'Antes de tomar esa decision, ora esto con un corazon sincero.',
      verse: 'Santiago 1:5',
      angle: 'oracion',
    },
    {
      title: 'Lo que David nos ensena sobre volver a empezar',
      hook: 'David cayo, pero no se quedo en el suelo.',
      verse: 'Salmo 51:10',
      angle: 'historia biblica',
    },
    {
      title: 'No confundas la espera con una negativa',
      hook: 'Una espera no siempre es un no; a veces es preparacion.',
      verse: 'Habacuc 2:3',
      angle: 'esperanza',
    },
    {
      title: 'La paz que no depende de las circunstancias',
      hook: 'La paz no es ausencia de problemas; es la presencia de Dios.',
      verse: 'Juan 14:27',
      angle: 'ensenanza',
    },
    {
      title: 'Tres senales de que necesitas pausar y orar',
      hook: 'Si tu mente esta llena y tu corazon esta cansado, pausa aqui.',
      verse: 'Mateo 11:28',
      angle: 'devocional practico',
    },
    {
      title: 'Por que la obediencia pequena tambien importa',
      hook: 'Ese paso pequeno que sigues posponiendo puede ser el que Dios te esta pidiendo.',
      verse: 'Lucas 16:10',
      angle: 'discipulado',
    },
    {
      title: 'Un versiculo para noches de ansiedad',
      hook: 'Guarda esto para la noche en que la ansiedad quiera hablar mas fuerte que tu fe.',
      verse: 'Filipenses 4:6-7',
      angle: 'consuelo',
    },
    {
      title: 'Dios puede trabajar con lo que aun tienes',
      hook: 'No mires solo lo que perdiste; Dios tambien puede multiplicar lo que queda.',
      verse: '2 Reyes 4:2',
      angle: 'reflexion biblica',
    },
    {
      title: 'Perdonar no es debilidad',
      hook: 'Perdonar no justifica la herida; libera tu corazon de cargarla.',
      verse: 'Efesios 4:32',
      angle: 'sanidad',
    },
  ];

  const scripts = themes.slice(0, 3).map((idea, index) => ({
    title: idea.title,
    duration_seconds: 75,
    script: [
      idea.hook,
      `La Biblia nos recuerda en ${idea.verse} que la fe no es solo lo que decimos cuando todo esta facil.`,
      'Hay momentos en que el corazon se cansa, pero esos momentos tambien pueden ser una invitacion a volver a Dios con honestidad.',
      'Hoy toma un minuto en silencio. Respira. Ora sencillo. Pidele a Dios sabiduria, paz y un corazon limpio.',
      'No construyas tu dia solo sobre emociones. Construyelo sobre verdad, obediencia y confianza.',
      'Si esto hablo a tu vida, guardalo y enviaselo a alguien que necesite animo hoy.',
    ].join(' '),
    caption: `${idea.title}. ${idea.verse}. #Fe #Oracion #Dios #Devocional #Cristianos`,
    visual_direction: [
      'Vertical 1080x1920.',
      'Luz natural calida.',
      'Musica instrumental tranquila tipo adoracion.',
      'Subtitulos grandes con una frase por beat.',
      'Usar visuales originales, generados o licenciados.',
    ].join(' '),
    safety_notes: 'Tono devocional respetuoso. Sin promesas falsas de milagros, sin ataques a otras religiones, sin politica.',
    priority: index + 1,
  }));

  return {
    date: today,
    niche: 'religioso',
    language: 'espanol',
    ideas: themes,
    scripts,
    next_actions: [
      'Aprobar un guion para la primera produccion.',
      'Elegir estilo de voz: voz propia, voz IA o solo subtitulos.',
      'Producir un video vertical de 60-90 segundos y publicarlo manualmente primero.',
    ],
  };
}

const weeklyTopicBanks = {
  religioso: [
    'Cuando Dios parece estar en silencio',
    'Una oración corta para empezar el día',
    'No confundas espera con abandono',
    'La paz que no depende de las circunstancias',
    'Un versículo para una noche de ansiedad',
    'Perdonar sin negar la herida',
    'Cómo volver a orar cuando te sientes seco por dentro',
    'La fe cuando tus planes cambian de repente',
    'Un recordatorio para no decidir desde el cansancio',
    'Por qué descansar también puede ser obediencia',
    'La diferencia entre esperar y rendirse',
    'Cuando necesitas paz antes que respuestas',
    'Qué hacer cuando una oración parece no tener respuesta',
    'Aprender a agradecer en un día difícil',
    'La esperanza cuando el diagnóstico asusta',
    'Cómo entregar a Dios una preocupación repetitiva',
    'Una reflexión para quien se siente solo',
    'La paciencia que se construye en lo cotidiano',
    'Cuando necesitas pedir perdón de verdad',
    'Cómo acompañar con fe a alguien que está sufriendo',
    'Una oración antes de tomar una decisión importante',
    'La humildad de reconocer que necesitas ayuda',
    'Cómo cuidar tu corazón sin cerrarte a los demás',
    'El valor de comenzar de nuevo con Dios',
    'Una promesa bíblica para enfrentar el miedo',
    'Cuando comparar tu vida te roba la gratitud',
    'La fe también se demuestra con acciones pequeñas',
    'Cómo mantener esperanza durante una espera larga',
    'Una oración para descansar sin culpa',
    'Qué significa confiar cuando no controlas el resultado',
    'Cómo responder con calma en medio de un conflicto',
    'La importancia de guardar silencio antes de reaccionar',
    'Cuando debes soltar una carga que no te corresponde',
    'Cómo encontrar propósito en una temporada lenta',
    'Una reflexión sobre servir sin buscar reconocimiento',
    'La fortaleza de pedir consejo con humildad',
    'Cómo recuperar la alegría después de una decepción',
    'Una oración por la familia en tiempos de tensión',
    'El valor espiritual de cumplir tu palabra',
    'Cómo reconocer una puerta que conviene dejar cerrada',
    'La compasión como respuesta ante el error ajeno',
    'Una reflexión para terminar el día en paz',
  ],
  esferaclick: [
    'Tres hábitos pequeños que mejoran tu energía durante el día',
    'Una función poco conocida del celular que ahorra tiempo',
    'Curiosidad tecnológica que parecía imposible hace diez años',
    'Un mito común de bienestar que conviene revisar',
    'Una rutina simple para dormir mejor sin comprar nada',
    'Cómo cambia la atención cuando usamos el celular',
    'Una forma sencilla de ordenar tus notificaciones',
    'El truco doméstico mínimo que ahorra tiempo',
    'Por qué recordar menos cosas puede ayudarte a enfocarte',
    'Un error común al cargar el celular durante la noche',
    'Cómo organizar una mañana sin revisar redes al despertar',
    'La regla de dos minutos para evitar tareas acumuladas',
    'Qué ocurre cuando dejas demasiadas pestañas abiertas',
    'Una manera práctica de reducir el ruido digital',
    'Por qué caminar unos minutos puede despejar tus ideas',
    'Cómo preparar un espacio de trabajo con menos distracciones',
    'Una curiosidad sobre la memoria y los olores',
    'El efecto de la luz natural en tu rutina diaria',
    'Cómo usar recordatorios sin convertirlos en ruido',
    'Qué revisar antes de aceptar una prueba gratuita',
    'Una costumbre sencilla para gastar menos agua en casa',
    'Por qué algunas canciones se quedan en la cabeza',
    'Cómo ordenar fotografías sin borrar recuerdos importantes',
    'Una forma fácil de planificar comidas de la semana',
    'Qué significa realmente el modo ahorro de batería',
    'Cómo evitar compras impulsivas desde el celular',
    'Una curiosidad sobre la percepción del tiempo',
    'El beneficio de preparar la ropa la noche anterior',
    'Cómo detectar una suscripción que ya no utilizas',
    'Por qué el cerebro busca completar figuras incompletas',
    'Una forma segura de limpiar la pantalla del teléfono',
    'Cómo crear una lista de pendientes que sí puedas terminar',
    'La diferencia entre descansar y distraerse sin parar',
    'Qué revisar antes de compartir una noticia sorprendente',
    'Cómo aprovechar mejor el calendario del celular',
    'Una curiosidad sobre los colores y la percepción',
    'Por qué conviene dejar espacio libre en el almacenamiento',
    'Cómo reducir interrupciones durante una conversación',
    'Una rutina de cinco minutos para ordenar el escritorio',
    'Qué hacer con los cables que ya no puedes identificar',
    'Cómo elegir una contraseña que puedas administrar',
    'Una curiosidad sobre la forma en que tomamos decisiones',
  ],
  tecnolatino: [
    'Una configuración de privacidad que deberías revisar hoy',
    'Cómo usar IA para ahorrar tiempo en una tarea diaria',
    'Señales simples de una estafa digital',
    'Una función útil para organizar tu día',
    'El ajuste de seguridad que muchos ignoran en WhatsApp',
    'Una forma simple de ordenar archivos en la nube',
    'Cómo revisar permisos de una aplicación',
    'Tres usos prácticos de IA para pequeños negocios',
    'Por qué activar el doble factor sigue siendo importante',
    'Cómo limpiar archivos duplicados sin perder documentos',
    'Qué revisar antes de instalar una extensión del navegador',
    'Cómo reconocer un código QR sospechoso',
    'La diferencia entre copia local y copia en la nube',
    'Cómo proteger una cuenta después de una filtración',
    'Qué permisos no necesita una aplicación de linterna',
    'Cómo compartir archivos grandes sin perder calidad',
    'Una forma segura de prestar tu teléfono desbloqueado',
    'Qué hacer cuando el almacenamiento aparece lleno',
    'Cómo separar cuentas personales y de trabajo',
    'Por qué conviene actualizar el router de casa',
    'Cómo identificar un correo de recuperación falso',
    'Qué revisar antes de comprar almacenamiento digital',
    'Cómo crear respuestas rápidas para tu negocio',
    'Una tarea administrativa que puedes resumir con IA',
    'Cómo eliminar metadatos antes de compartir una fotografía',
    'Qué hacer si recibes un código de acceso que no pediste',
    'Cómo revisar las sesiones abiertas de una cuenta',
    'La utilidad real de un administrador de contraseñas',
    'Cómo evitar perder archivos al cambiar de teléfono',
    'Qué diferencia existe entre archivar y eliminar',
    'Cómo usar el modo concentración de manera práctica',
    'Una señal de que una aplicación consume batería de más',
    'Cómo preparar tu teléfono antes de venderlo',
    'Qué revisar en una red wifi pública',
    'Cómo reducir el rastreo dentro del navegador',
    'Una automatización sencilla para respaldar documentos',
    'Cómo comprobar si un enlace dirige al sitio correcto',
    'Qué significa que una aplicación trabaje en segundo plano',
    'Cómo ordenar tus contactos sin duplicarlos',
    'Una forma responsable de verificar respuestas de IA',
    'Cómo proteger documentos enviados por mensajería',
    'Qué revisar antes de conectar un dispositivo inteligente',
  ],
  gamergadget: [
    'Un ajuste que puede mejorar tu experiencia al jugar',
    'Un accesorio económico que cambia tu setup',
    'Un error común al comprar periféricos gamer',
    'Una curiosidad de hardware para jugadores',
    'Cómo cuidar mejor tus controles y periféricos',
    'Qué revisar antes de comprar un monitor gamer',
    'Cómo ordenar cables sin gastar mucho',
    'La diferencia entre comodidad y apariencia en un setup',
    'Qué mirar antes de comprar audífonos para jugar',
    'Un ajuste de sensibilidad que muchos pasan por alto',
    'Cómo elegir el tamaño correcto de un mouse',
    'Por qué la altura del monitor afecta sesiones largas',
    'Qué significa realmente el tiempo de respuesta',
    'Cómo limpiar un teclado mecánico con seguridad',
    'Cuándo conviene usar cable en vez de wifi',
    'Qué revisar antes de comprar una silla gamer',
    'Cómo evitar que el control desarrolle drift',
    'La diferencia entre tasa de refresco y cuadros por segundo',
    'Cómo reducir ruido sin calentar demasiado la computadora',
    'Qué tipo de iluminación ayuda sin distraer',
    'Cómo comprobar compatibilidad antes de comprar memoria RAM',
    'Qué aporta realmente una alfombrilla grande',
    'Cómo colocar los altavoces en un escritorio pequeño',
    'Cuándo vale la pena cambiar los interruptores del teclado',
    'Cómo elegir un soporte seguro para audífonos',
    'Qué revisar en un control usado antes de comprarlo',
    'Cómo mejorar la ventilación alrededor de la consola',
    'La utilidad de limitar cuadros en algunos juegos',
    'Cómo proteger tus cuentas de videojuegos',
    'Qué hacer antes de actualizar un controlador gráfico',
    'Cómo reducir reflejos en la pantalla',
    'La diferencia entre micrófono USB y uno integrado',
    'Qué revisar antes de comprar un SSD para juegos',
    'Cómo transportar una consola sin dañarla',
    'Por qué la postura importa más que una luz RGB',
    'Cómo organizar cargadores de controles',
    'Qué significa que un teclado tenga anti-ghosting',
    'Cómo probar un monitor para detectar píxeles defectuosos',
    'Cuándo un adaptador barato puede causar problemas',
    'Cómo mantener limpio un mousepad de tela',
    'Qué revisar antes de comprar una capturadora',
    'Cómo configurar una pausa saludable entre partidas',
  ],
  infoboy27: [
    'Un dato curioso que suena falso pero es real',
    'Una historia corta de internet que casi nadie recuerda',
    'Un truco digital simple para compartir con amigos',
    'Una pregunta viral para generar comentarios',
    'Un antes y después de la tecnología cotidiana',
    'Algo que todos usan pero pocos entienden',
    'Una costumbre moderna que cambió sin notarlo',
    'El origen curioso de una palabra común de internet',
    'Un dato de cultura popular que abre debate',
    'Una pregunta simple que divide opiniones',
    'Por qué los teclados conservan el orden QWERTY',
    'El origen del símbolo usado en las direcciones de correo',
    'Cómo nació el gesto de deslizar en una pantalla',
    'Por qué algunas grabaciones antiguas parecen aceleradas',
    'El primer objeto cotidiano vendido por internet',
    'Cómo los mapas digitales calculan una ruta',
    'Por qué reconocemos una melodía con pocas notas',
    'El origen del nombre de una tecnología cotidiana',
    'Cómo cambió la forma de tomar fotografías familiares',
    'Por qué las alarmas utilizan sonidos repetitivos',
    'La historia detrás de un botón que usamos todos los días',
    'Cómo se elegían tonos de llamada antes de los smartphones',
    'Por qué algunos videos parecen más fluidos que otros',
    'El objeto de oficina que inspiró un icono digital',
    'Cómo surgieron los mensajes de voz',
    'Por qué ciertos recuerdos parecen más recientes',
    'El origen de una expresión popular en redes',
    'Cómo cambió la televisión con el control remoto',
    'Por qué miramos el porcentaje de batería tantas veces',
    'La primera función que popularizó las videollamadas',
    'Cómo se enviaban archivos antes de la nube',
    'Por qué los números redondos parecen más atractivos',
    'El origen de los subtítulos en contenidos audiovisuales',
    'Cómo una pequeña vibración comunica información',
    'Por qué algunas aplicaciones usan puntos rojos',
    'La historia de una función tecnológica que desapareció',
    'Cómo cambió la música al dejar de usar discos',
    'Por qué una pantalla refleja mejor ciertos colores',
    'El origen de las listas de reproducción',
    'Cómo nacieron las reacciones rápidas en mensajes',
    'Por qué recordamos mejor una historia que una lista',
    'La evolución de los cargadores de teléfono',
  ],
  fanspeliculas: [
    'Tres historias para maratonear: película, serie y novela',
    'Por qué algunas escenas de villanos se vuelven inolvidables',
    'Películas para quienes disfrutan los giros inesperados',
    'El tipo de personaje que siempre divide a los fans',
    'Cómo una buena banda sonora cambia una escena',
    'Finales de novelas que todavía generan debate',
    'Dramas familiares para comentar después de verlos',
    'Cuando una historia romántica funciona sin exagerar',
    'La diferencia entre suspenso barato y tensión bien construida',
    'Historias donde un secreto familiar mueve toda la trama',
    'Por qué algunos protagonistas imperfectos conectan más',
    'Una recomendación para fans de traición y redención',
    'Historias donde el personaje secundario roba la atención',
    'Cómo reconocer un giro narrativo bien preparado',
    'Películas que cuentan mucho mediante el silencio',
    'Novelas donde la rivalidad familiar sostiene el conflicto',
    'Por qué una despedida puede definir toda una historia',
    'Historias de justicia que mantienen la tensión',
    'Cómo cambia una escena cuando conocemos el secreto',
    'Personajes que empiezan como rivales y terminan aliados',
    'Recomendaciones para fans de misterios sin violencia gráfica',
  ],
};

// --- Ideas con IA local: solo para los destinos con video. Se generan con un dia de anticipacion,
// cuando no hay un video en produccion, y quedan fijas para ese dia (GENERAR ... 2 siempre es la misma idea).
const aiIdeaChannels = {
  religioso: {
    count: 6,
    description: 'Vida con Dios: canal cristiano de reflexiones breves (60-90 segundos) para personas que buscan fe, esperanza y paz en su vida diaria. Tono pastoral, cercano y practico; cada video desarrolla una sola idea con apoyo de un pasaje biblico.',
  },
  fanspeliculas: {
    count: 3,
    description: 'Fans Peliculas y Novelas: videos cortos de recomendaciones, curiosidades y analisis de peliculas, series y telenovelas para fans latinos. Tono entretenido y cercano; sin spoilers graves ni violencia grafica.',
  },
};
let aiIdeasRunning = false;

async function requestIdeasLocal(prompt) {
  const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ollamaScriptModel,
      messages: [
        { role: 'system', content: 'Eres un estratega de contenido para videos cortos en espanol latino. Respondes solo con JSON valido.' },
        { role: 'user', content: prompt },
      ],
      format: { type: 'object', properties: { ideas: { type: 'array', items: { type: 'string' } } }, required: ['ideas'] },
      think: false,
      stream: false,
      keep_alive: 0,
      options: { temperature: 0.9, num_predict: 900, num_ctx: 4096 },
    }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Ollama respondio HTTP ${response.status}: ${payload.error || ''}`);
  return JSON.parse(payload.message?.content || '{}').ideas || [];
}

async function generateAiIdeas(destinationId, dateKey) {
  const { count, description } = aiIdeaChannels[destinationId];
  const bank = weeklyTopicBanks[destinationId];
  const stored = readJson(aiIdeasPath, {});
  const since = Date.parse(dateKey) - 30 * 86_400_000;
  const recentTitles = readContentHistory()
    .filter((item) => item.destinationId === destinationId && Date.parse(item.created_at || item.generated_at || '') >= since)
    .map((item) => item.idea || item.title)
    .concat(Object.entries(stored).filter(([day]) => day !== dateKey && Date.parse(day) >= since).flatMap(([, day]) => day[destinationId] || []));
  const examples = [...bank].sort(() => Math.random() - 0.5).slice(0, 8);
  const avoid = new Set([...recentTitles, ...examples].map(normalizeContentKey));
  // Parecida = comparte la mayoria de sus palabras clave con un ejemplo o un tema reciente.
  const seenWords = [...recentTitles, ...bank].map(significantTopicWords).filter((words) => words.length);
  const tooSimilar = (idea) => {
    const words = significantTopicWords(idea);
    return seenWords.some((other) => {
      const shared = words.filter((word) => other.includes(word)).length;
      return shared >= 2 && shared / Math.min(words.length, other.length) >= 0.6;
    });
  };
  const prompt = [
    `Canal: ${description}`,
    `Propon ${count + 4} temas NUEVOS para videos de hoy. Cada tema es una frase corta (entre 4 y 12 palabras), concreta y con un angulo claro, como un titulo atractivo.`,
    'Varia el tipo de tema: emociones, situaciones cotidianas, preguntas que la gente se hace, consejos practicos.',
    'Sin numeracion, sin comillas, sin emojis, sin hashtags y sin dos puntos al inicio.',
    'Escribe con ortografia perfecta y todas las tildes (por ejemplo: Por qué, Cómo, Qué, música, película). Cada tema sera el titulo publico del video.',
    `Ejemplos del estilo (NO los copies ni los reformules; inventa temas distintos):\n- ${examples.join('\n- ')}`,
    recentTitles.length ? `Temas ya usados en los ultimos 30 dias (no los repitas ni hagas variaciones obvias):\n- ${[...new Set(recentTitles)].slice(-40).join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n');
  const ideas = [];
  for (const raw of await requestIdeasLocal(prompt)) {
    const idea = polishSpanishText(String(raw || '').replace(/^[\s\-*\d.)]+/, '').replace(/["“”#*]/g, '').replace(/\s+/g, ' ').trim())
      .replace(/[.]+$/, '')
      .replace(/^Por que\b/, 'Por qué').replace(/^Como\b/, 'Cómo').replace(/^Que\b/, 'Qué').replace(/^Cual(es)?\b/, (word) => word.replace('Cual', 'Cuál'));
    const key = normalizeContentKey(idea);
    if (idea.length < 15 || idea.length > 90 || avoid.has(key) || tooSimilar(idea) || ideas.some((item) => normalizeContentKey(item) === key)) continue;
    try { assertAllowedText(idea); } catch { continue; }
    ideas.push(idea);
    if (ideas.length === count) break;
  }
  // Si el modelo dio pocas ideas validas, se completa con las listas fijas que no se usaron hace poco.
  for (const item of bank) {
    if (ideas.length >= count) break;
    if (!avoid.has(normalizeContentKey(item)) && !ideas.includes(item)) ideas.push(item);
  }
  return ideas.slice(0, count);
}

async function refreshAiIdeas() {
  if (ideasProvider !== 'local' || aiIdeasRunning || activeVideoJob) return;
  aiIdeasRunning = true;
  try {
    const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    // Solo manana: las de hoy ya se anunciaron en el plan de la manana y no deben cambiar a mitad del dia.
    for (const dateKey of [new Date(today + 86_400_000).toISOString().slice(0, 10)]) {
      for (const destinationId of Object.keys(aiIdeaChannels)) {
        if (activeVideoJob) return;
        if (readJson(aiIdeasPath, {})[dateKey]?.[destinationId]) continue;
        try {
          const ideas = await generateAiIdeas(destinationId, dateKey);
          const stored = readJson(aiIdeasPath, {});
          stored[dateKey] = { ...(stored[dateKey] || {}), [destinationId]: ideas };
          const cutoff = new Date(today - 30 * 86_400_000).toISOString().slice(0, 10);
          for (const day of Object.keys(stored)) if (day < cutoff) delete stored[day];
          writeJson(aiIdeasPath, stored);
          console.log(`[ideas] ${dateKey} ${destinationId}: ${ideas.join(' | ')}`);
        } catch (error) {
          console.warn(`[ideas] ${dateKey} ${destinationId}: fallo la IA local (${error.message}); se reintenta luego`);
        }
      }
    }
  } finally {
    aiIdeasRunning = false;
  }
}

function buildMultiplatformPlan(referenceDate = new Date()) {
  const planDate = new Date(referenceDate);
  if (!Number.isFinite(planDate.getTime())) throw new Error('Fecha de plan invalida.');
  const today = planDate.toISOString().slice(0, 10);
  const destinations = [
    {
      id: 'religioso',
      destination: 'Vida con Dios / Fans de Juan Luis Guerra Universo 440',
      platforms: ['Facebook imagen+caption', 'Facebook Reels', 'YouTube Shorts', 'TikTok manual MP4'],
      niche: 'religioso',
      ideas: pickDailyIdeas('religioso', weeklyTopicBanks.religioso, 6, planDate),
      format: 'Facebook: imagen + caption o Reel. Video 60-90s para Facebook Reels, YouTube Shorts y TikTok manual de Vida con Dios.',
      caption: 'Un recordatorio breve para volver a la fe con calma. #Fe #Dios #Oracion #Devocional #Cristianos',
      growth_goal: 'Construir una audiencia constante con contenido original y útil.',
      youtubeChannelKey: 'vida_con_dios',
    },
    {
      id: 'esferaclick',
      destination: 'EsferaClick.com',
      platforms: ['Facebook imagen+caption', 'Facebook Reels'],
      niche: 'curiosidades, tecnologia, salud general, estilo de vida',
      ideas: pickDailyIdeas('esferaclick', weeklyTopicBanks.esferaclick, 6, planDate),
      format: 'Facebook: imagen original + caption o Reel. Sin TikTok configurado para esta pagina.',
      caption: 'Dato rapido para aprender algo util hoy. #EsferaClick #Curiosidades #Tecnologia #EstiloDeVida #Reels',
      growth_goal: 'Validar temas con alto alcance antes de aumentar el volumen.',
    },
    {
      id: 'tecnolatino',
      destination: 'Tecno-Latino',
      platforms: ['Facebook imagen+caption', 'Facebook Reels'],
      niche: 'tecnologia, apps, IA, seguridad simple',
      ideas: pickDailyIdeas('tecnolatino', weeklyTopicBanks.tecnolatino, 6, planDate),
      format: 'Facebook: imagen original + caption o Reel con pasos claros. Sin TikTok configurado para esta pagina.',
      caption: 'Tecnologia simple para usar mejor tus herramientas. #Tecnologia #IA #Apps #SeguridadDigital',
      growth_goal: 'Mejorar frecuencia e interacción de forma sostenible.',
    },
    {
      id: 'gamergadget',
      destination: 'Gamer Gadget RD',
      platforms: ['Facebook imagen+caption', 'Facebook Reels'],
      niche: 'gaming, accesorios, setups',
      ideas: pickDailyIdeas('gamergadget', weeklyTopicBanks.gamergadget, 6, planDate),
      format: 'Facebook: imagen original + caption o Reel con comparacion/consejo practico. Sin TikTok configurado para esta pagina.',
      caption: 'Tip gamer rapido para mejorar tu setup. #Gaming #Setup #Gadgets #GamerRD',
      growth_goal: 'Medir alcance a partir de consejos prácticos.',
    },
    {
      id: 'infoboy27',
      destination: 'Infoboy27',
      platforms: ['Facebook imagen+caption', 'Facebook Reels'],
      niche: 'viral general y tecnologia ligera',
      ideas: pickDailyIdeas('infoboy27', weeklyTopicBanks.infoboy27, 6, planDate),
      format: 'Facebook: imagen original + caption o Reel de alto gancho con pregunta final. Sin TikTok configurado para esta pagina.',
      caption: 'Dato rapido para comentar y compartir. #Curiosidades #Viral #Tecnologia #Info',
      growth_goal: 'Aumentar interacciones y señales de distribución.',
    },
    {
      id: 'fanspeliculas',
      destination: 'Fans Peliculas y Novelas',
      platforms: ['YouTube Shorts'],
      niche: 'peliculas, novelas, entretenimiento y recomendaciones',
      ideas: pickDailyIdeas('fanspeliculas', weeklyTopicBanks.fanspeliculas, 3, planDate),
      format: 'Video vertical 60-90 segundos, sin spoilers fuertes, comentario/recomendacion original.',
      caption: 'Para fans de peliculas y novelas. #Peliculas #Novelas #Entretenimiento #Recomendaciones #Shorts',
      growth_goal: 'Medir la retención y respuesta de la audiencia por tema.',
      youtubeChannelKey: 'fans_peliculas_novelas',
    },
  ].filter((destination) => Boolean(destination.youtubeChannelKey));

  for (const destination of destinations) {
    destination.postIdeas = [];
    destination.videoIdeas = destination.ideas.slice(0, 3);
    assertAllowedText(
      destination.destination,
      destination.postIdeas,
      destination.videoIdeas,
      destination.caption,
      destination.growth_goal,
    );
  }

  return {
    date: today,
    language: 'espanol',
    strategy: 'Facebook esta deshabilitado temporalmente. El plan genera solamente videos para YouTube y MP4 para TikTok manual.',
    destinations,
    tiktok_status: 'Solo Vida con Dios tiene TikTok manual; no generar TikTok para las otras paginas.',
    youtube_status: 'YouTube automatico usa canal por destino: Vida con Dios y Fans Peliculas y Novelas.',
    facebook_status: 'Deshabilitado temporalmente: no se generan posts ni se publican Reels.',
  };
}

async function buildReadinessReport() {
  const plan = buildMultiplatformPlan();
  const channels = [];
  for (const [key, config] of Object.entries(youtubeChannels)) {
    try {
      const report = await getYouTubeReport(key);
      channels.push({
        key,
        label: config.label,
        connected: report.channel?.id === config.expectedChannelId,
        channelId: report.channel?.id || null,
        title: report.channel?.title || null,
      });
    } catch (error) {
      channels.push({
        key,
        label: config.label,
        connected: false,
        channelId: null,
        error: error.message,
      });
    }
  }
  const facebook = plan.destinations.filter((destination) => destination.postIdeas.length);
  const posts = facebook.reduce((total, destination) => total + destination.postIdeas.length, 0);
  const reels = facebook.reduce((total, destination) => total + destination.videoIdeas.length, 0);
  const youtubeVideos = plan.destinations
    .filter((destination) => destination.youtubeChannelKey)
    .reduce((total, destination) => total + destination.videoIdeas.length, 0);
  const serviceStatus = readJson(serviceStatusPath, {});
  const provider = serviceStatus.media_provider || { status: openaiApiKey ? 'configured' : 'missing' };
  const lines = [
    `Reporte de preparacion - ${plan.date}`,
    '',
    `YouTube: ${channels.filter((channel) => channel.connected).length}/${channels.length} canales conectados`,
    ...channels.map((channel) => `- ${channel.label}: ${channel.connected ? `conectado (${channel.channelId})` : 'requiere revision'}`),
    'Facebook: deshabilitado temporalmente; 0 posts y 0 Reels en el lote',
    `YouTube lote: ${youtubeVideos} videos`,
    'TikTok: 3 MP4 de Vida con Dios, carga manual',
    'Temas: bloqueo estricto de 7 dias activo',
    'Aprobacion: ID exacto PST-/VID- y rechazo habilitado',
    `Proveedor multimedia: ${provider.status === 'ready' ? 'disponible' : provider.status === 'blocked' ? `bloqueado (${provider.code || 'revisar cuenta'})` : provider.status}`,
    '',
    'No se publico contenido durante esta verificacion.',
  ];
  assertAllowedText(lines);
  return {
    ok: true,
    date: plan.date,
    channels,
    counts: {
      facebook_pages: facebook.length,
      facebook_posts: posts,
      facebook_reels: reels,
      youtube_videos: youtubeVideos,
      tiktok_manual_videos: 3,
    },
    provider,
    message: lines.join('\n'),
  };
}

const facebookDestinations = {
  religioso: {
    aliases: ['RELIGIOSO', 'RELIGION', 'DIOS', 'JUANLUIS', 'JUAN', 'FANS'],
    pageId: '760677727430730',
    pageName: 'Fans de Juan Luis Guerra Universo 440',
  },
  esferaclick: {
    aliases: ['ESFERACLICK', 'ESFERA'],
    pageId: '121883204809660',
    pageName: 'EsferaClick.com',
  },
  tecnolatino: {
    aliases: ['TECNOLATINO', 'TECNO'],
    pageId: '537688349741663',
    pageName: 'Tecno-Latino',
  },
  gamergadget: {
    aliases: ['GAMERGADGET', 'GAMER'],
    pageId: '101366798772902',
    pageName: 'Gamer Gadget RD',
  },
  infoboy27: {
    aliases: ['INFOBOY', 'INFOBOY27'],
    pageId: '102305665134963',
    pageName: 'Infoboy27',
  },
  fanspeliculas: {
    aliases: ['FANSPELICULAS', 'PELICULAS', 'PELICULA', 'NOVELAS', 'NOVELA', 'CINE'],
    pageId: null,
    pageName: 'Fans Peliculas y Novelas',
  },
};

function resolveDestination(text) {
  const normalized = String(text || '').toUpperCase();
  const aliases = Object.entries(facebookDestinations)
    .flatMap(([id, destination]) => destination.aliases.map((alias) => ({ id, alias })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const item of aliases) {
    if (normalized.includes(item.alias)) {
      return item.id;
    }
  }
  return null;
}

function scheduleDateForSlot(slotIndex) {
  const slots = [
    { hour: 9, minute: 30 },
    { hour: 13, minute: 30 },
    { hour: 19, minute: 30 },
  ];
  const slot = slots[slotIndex % slots.length];
  const now = new Date();
  const utc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    slot.hour + 4,
    slot.minute,
    0,
    0,
  );
  let scheduled = new Date(utc);
  if (scheduled <= now) {
    scheduled = new Date(utc + 24 * 60 * 60 * 1000);
  }
  return scheduled.toISOString();
}

function buildPostText(destination, idea, ideaNumber) {
  const bodies = {
    religioso: `Haz una pausa y piensa cómo este mensaje se relaciona con lo que estás viviendo hoy. La fe también crece cuando elegimos una acción serena y concreta.`,
    esferaclick: `Llévalo a la práctica de forma sencilla y observa si realmente mejora tu rutina. Los cambios útiles son los que puedes repetir sin complicarte.`,
    tecnolatino: `Revísalo con calma antes de cambiar una configuración o instalar una herramienta. La tecnología debe ahorrarte tiempo y proteger tus datos.`,
    gamergadget: `Antes de gastar, compara compatibilidad, comodidad y durabilidad. Un buen ajuste puede mejorar más tu experiencia que un accesorio costoso.`,
    infoboy27: `Mira el dato completo y compáralo con lo que ya conocías. Las mejores curiosidades son las que abren una conversación útil.`,
  };
  const questions = {
    religioso: '¿Qué paso pequeño puedes dar hoy?',
    esferaclick: '¿Lo probarías en tu rutina?',
    tecnolatino: '¿Ya habías revisado esta opción?',
    gamergadget: '¿Qué cambiarías primero en tu setup?',
    infoboy27: '¿Ya conocías este dato?',
  };
  const content = [
    idea,
    '',
    bodies[destination.id] || bodies.infoboy27,
    '',
    questions[destination.id] || questions.infoboy27,
    '',
    destination.caption,
  ].join('\n');
  assertAllowedText(content);
  return content;
}

function buildPostImagePrompt(destination, idea) {
  const baseStyle = [
    'Vertical social media image, realistic editorial style, bright natural lighting, clean composition.',
    'No readable text, no logos, no watermarks, no fake UI, no distorted hands, no political content.',
    'Safe, family friendly, high contrast subject, optimized for Facebook feed reach.',
  ].join(' ');

  if (destination.id === 'religioso') {
    return [
      baseStyle,
      `Theme: ${idea}.`,
      'Peaceful Christian devotional mood, open Bible, warm morning light, calm hopeful atmosphere.',
    ].join(' ');
  }
  if (destination.id === 'esferaclick') {
    return [
      baseStyle,
      `Theme: ${idea}.`,
      'Curiosity and lifestyle concept, modern phone on desk, subtle technology elements, inviting color palette.',
    ].join(' ');
  }
  if (destination.id === 'tecnolatino') {
    return [
      baseStyle,
      `Theme: ${idea}.`,
      'Technology tips concept, clean workspace, smartphone and laptop, privacy and productivity visual cues.',
    ].join(' ');
  }
  if (destination.id === 'gamergadget') {
    return [
      baseStyle,
      `Theme: ${idea}.`,
      'Gaming setup concept, keyboard, controller, monitor glow, practical gadget focus, energetic but realistic.',
    ].join(' ');
  }
  return [
    baseStyle,
    `Theme: ${idea}.`,
    'Viral curiosity concept, modern everyday object, visual mystery, clear focal point, shareable composition.',
  ].join(' ');
}

async function generateScheduledPostImage({ destination, idea, ideaIndex }) {
  const prompt = buildPostImagePrompt(destination, idea);
  const slug = `post-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${destination.id}-${ideaIndex + 1}-${crypto.randomUUID()}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
  const imageDir = path.join(dataDir, 'generated-post-images');
  fs.mkdirSync(imageDir, { recursive: true });
  const fileName = `${slug}.png`;
  const filePath = path.join(imageDir, fileName);
  const { value: image } = await generateImage(prompt, { size: '1024x1536' });
  if (!Buffer.isBuffer(image) || image.length < 100_000) {
    const error = new Error('La imagen no supero el control minimo de calidad.');
    error.code = 'IMAGE_QUALITY_CHECK_FAILED';
    throw error;
  }
  fs.writeFileSync(filePath, image, { mode: 0o600 });
  return {
    imagePath: `${appBaseUrl}/media/post-image/${fileName}`,
    imagePrompt: prompt,
    quality: {
      expected_size: '1024x1536',
      bytes: image.length,
      sha256: crypto.createHash('sha256').update(image).digest('hex'),
      passed: true,
    },
  };
}

function parsePostCommand(command) {
  const normalized = String(command || '').trim().toUpperCase();
  const destinationId = resolveDestination(normalized);
  const ideaIndex = Math.max(0, Math.min(2, Number(normalized.match(/\b([123])\b/)?.[1] || '1') - 1));
  const plan = buildMultiplatformPlan();
  const destination = plan.destinations.find((item) => item.id === destinationId);
  const facebook = facebookDestinations[destinationId];
  if (!destination || !facebook?.pageId) {
    throw new Error('Destino de post no reconocido o sin pagina de Facebook configurada.');
  }
  const idea = polishSpanishText(destination.postIdeas[ideaIndex]);
  const contentKey = normalizeContentKey(idea);
  assertAllowedText(idea, destination.caption);
  return { destination, facebook, idea, ideaIndex, contentKey };
}

async function prepareFacebookPostPreview(command) {
  if (!facebookPublishingEnabled) {
    const error = new Error('Facebook esta deshabilitado temporalmente.');
    error.code = 'FACEBOOK_PUBLISHING_DISABLED';
    throw error;
  }
  const parsed = parsePostCommand(command);
  const existing = readContentItems().find((item) => (
    item.type === 'facebook_post'
    && item.destinationId === parsed.destination.id
    && item.contentKey === parsed.contentKey
    && !['rejected', 'published'].includes(item.status)
  ));
  if (existing) {
    return {
      ok: true,
      mode: 'preview_existing',
      post: existing,
      contentId: existing.contentId,
      telegram: { send_media: !existing.telegram_sent_at },
      approval_command: `APROBAR ${existing.contentId}`,
      rejection_command: `RECHAZAR ${existing.contentId}`,
    };
  }

  const lockFile = acquireGenerationLock(parsed.destination.id, parsed.contentKey);
  try {
    const afterLock = readContentItems().find((item) => (
      item.type === 'facebook_post'
      && item.destinationId === parsed.destination.id
      && item.contentKey === parsed.contentKey
      && !['rejected', 'published'].includes(item.status)
    ));
    if (afterLock) {
      return {
        ok: true,
        mode: 'preview_existing',
        post: afterLock,
        contentId: afterLock.contentId,
        telegram: { send_media: !afterLock.telegram_sent_at },
        approval_command: `APROBAR ${afterLock.contentId}`,
        rejection_command: `RECHAZAR ${afterLock.contentId}`,
      };
    }
    const contentId = contentItemId('PST');
    const image = await generateScheduledPostImage(parsed);
    const post = upsertContentItem({
      contentId,
      type: 'facebook_post',
      status: 'preview_ready',
      destinationId: parsed.destination.id,
      destination: parsed.destination.destination,
      pageId: parsed.facebook.pageId,
      pageName: parsed.facebook.pageName,
      idea: parsed.idea,
      ideaIndex: parsed.ideaIndex,
      contentKey: parsed.contentKey,
      content: buildPostText(parsed.destination, parsed.idea, parsed.ideaIndex + 1),
      scheduledFor: scheduleDateForSlot(parsed.ideaIndex),
      imagePath: image.imagePath,
      imagePrompt: image.imagePrompt,
      quality: image.quality,
    });
    appendContentHistory({
      type: 'facebook_post_preview_generated',
      contentId,
      destinationId: parsed.destination.id,
      idea: parsed.idea,
      ideaIndex: parsed.ideaIndex,
      title: parsed.idea,
    });
    return {
      ok: true,
      mode: 'preview',
      post,
      contentId,
      telegram: { send_media: true },
      approval_command: `APROBAR ${contentId}`,
      rejection_command: `RECHAZAR ${contentId}`,
    };
  } finally {
    releaseGenerationLock(lockFile);
  }
}

function acknowledgeTelegramDelivery(contentIdValue) {
  const contentId = String(contentIdValue || '').trim().toUpperCase();
  const item = findContentItem(contentId);
  if (!item) throw new Error(`No existe contenido con ID ${contentId}.`);
  if (item.type === 'video') {
    const delivery = videoDeliveryStatus(contentId);
    if (!delivery.allowed) throw new Error(delivery.reason);
  }
  const deliveredAt = new Date().toISOString();
  const updated = upsertContentItem({
    ...item,
    telegram_sent_at: deliveredAt,
  });
  if (item.type === 'video') {
    const generated = generatedVideoForContentId(contentId);
    if (generated) {
      writeJson(generated.metadataPath, {
        ...generated.metadata,
        telegram_sent_at: deliveredAt,
      });
    }
  }
  return {
    ok: true,
    contentId,
    telegram_sent_at: deliveredAt,
    item: updated,
  };
}

async function approvePreparedFacebookPost(command) {
  if (!facebookPublishingEnabled) {
    const error = new Error('Facebook esta deshabilitado temporalmente.');
    error.code = 'FACEBOOK_PUBLISHING_DISABLED';
    throw error;
  }
  const contentId = contentIdFromCommand(command, 'PST');
  if (!contentId) throw new Error('La aprobacion necesita el ID PST-... mostrado junto al preview.');
  const post = findContentItem(contentId);
  if (!post || post.type !== 'facebook_post') throw new Error(`No existe el post ${contentId}.`);
  if (post.status === 'rejected') throw new Error(`El post ${contentId} fue rechazado.`);
  if (post.status === 'scheduled' || post.status === 'published') {
    return { ok: true, mode: 'already_scheduled', contentId, post, scheduled_count: 0 };
  }
  assertAllowedText(post.idea, post.content);
  const payload = {
    pageId: post.pageId,
    pageName: post.pageName,
    topic: `${post.destination} - ${contentId}`,
    content: post.content,
    scheduledFor: post.scheduledFor,
    imagePath: post.imagePath,
    imagePrompt: post.imagePrompt,
  };
  const result = await scheduleFacebookPosts([payload]);
  if (!result.ok || !result.created?.length) {
    throw new Error(result.errors?.[0] || 'Facebook no confirmo la programacion del post.');
  }
  const created = result.created[0];
  if (!created.hasImage && created.id) {
    await attachFacebookPostImage({
      postId: created.id,
      imagePath: post.imagePath,
      imagePrompt: post.imagePrompt,
    });
  }
  const updated = upsertContentItem({
    ...post,
    status: 'scheduled',
    scheduled_at: new Date().toISOString(),
    facebookPostId: created.id,
  });
  return {
    ok: true,
    mode: 'scheduled',
    contentId,
    post: updated,
    scheduled_count: 1,
    created: [created],
  };
}

function buildScheduleItemsFromCommand(text) {
  const plan = buildMultiplatformPlan();
  const normalized = String(text || '').trim().toUpperCase();
  const approveAll = /\b(APROBAR TODO|PROGRAMAR TODO|APROBAR PLAN)\b/.test(normalized);
  const destinationId = resolveDestination(normalized);
  const explicitIdea = normalized.match(/\b([123])\b/)?.[1];

  if (!approveAll && !destinationId) {
    return { items: [], plan, reason: 'Comando no reconocido para programacion' };
  }

  const selectedDestinations = plan.destinations.filter((destination) => {
    if (approveAll) return Boolean(facebookDestinations[destination.id]?.pageId);
    return destination.id === destinationId && Boolean(facebookDestinations[destination.id]?.pageId);
  });

  const items = [];
  for (const destination of selectedDestinations) {
    const facebook = facebookDestinations[destination.id];
    const ideas = explicitIdea
      ? [{ idea: destination.ideas[Number(explicitIdea) - 1], index: Number(explicitIdea) - 1 }]
      : destination.ideas.map((idea, index) => ({ idea, index }));
    for (const { idea, index } of ideas) {
      if (!idea) continue;
      items.push({
        pageId: facebook.pageId,
        pageName: facebook.pageName,
        topic: `${destination.destination} - idea ${index + 1}`,
        content: buildPostText(destination, idea, index + 1),
        scheduledFor: scheduleDateForSlot(index),
        imagePrompt: buildPostImagePrompt(destination, idea),
        imageContext: {
          destination,
          idea,
          ideaIndex: index,
        },
      });
    }
  }

  return { items, plan, reason: null };
}

async function scheduleFacebookPosts(items) {
  if (!facebookPublishingEnabled) {
    const error = new Error('Facebook esta deshabilitado temporalmente.');
    error.code = 'FACEBOOK_PUBLISHING_DISABLED';
    throw error;
  }
  const response = await fetch(`${facebookRewardsBaseUrl}/internal/contentcreator/schedule-facebook-posts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': internalToken,
    },
    body: JSON.stringify({ items }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Facebook schedule failed: ${response.status}`);
  }
  return payload;
}

async function attachFacebookPostImage({ postId, imagePath, imagePrompt }) {
  const response = await fetch(`${facebookRewardsBaseUrl}/internal/contentcreator/post-image`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': internalToken,
    },
    body: JSON.stringify({ postId, imagePath, imagePrompt }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Facebook image attach failed: ${response.status}`);
  }
  return payload;
}

async function enrichScheduledFacebookImages(created, items) {
  const pending = (created || []).filter((item) => item.id && !item.hasImage);
  for (const createdItem of pending) {
    const source = items.find((item) => (
      item.pageId === createdItem.pageId
      && item.topic === createdItem.topic
      && new Date(item.scheduledFor).getTime() === new Date(createdItem.scheduledFor).getTime()
    ));
    if (!source?.imageContext) continue;
    try {
      const image = await generateScheduledPostImage(source.imageContext);
      await attachFacebookPostImage({
        postId: createdItem.id,
        imagePath: image.imagePath,
        imagePrompt: image.imagePrompt,
      });
    } catch (error) {
      console.error('facebook post image enrichment failed', {
        postId: createdItem.id,
        topic: createdItem.topic,
        error: error.message,
      });
    }
  }
}

function buildApprovedVideoPackage(index = 1) {
  const plan = buildReligiousContentPlan();
  const selected = plan.scripts[Math.max(0, Math.min(plan.scripts.length - 1, index - 1))];
  const scenes = [
    {
      scene: 1,
      duration: '0-5s',
      on_screen_text: selected.hook || selected.title,
      visual: 'Persona en silencio mirando por una ventana con luz calida de manana.',
    },
    {
      scene: 2,
      duration: '5-18s',
      on_screen_text: selected.title,
      visual: 'Biblia abierta, manos descansando cerca, toma lenta vertical.',
    },
    {
      scene: 3,
      duration: '18-38s',
      on_screen_text: selected.script.split('. ').slice(1, 3).join('. ') + '.',
      visual: 'Camino tranquilo, luz entrando entre arboles, movimiento suave.',
    },
    {
      scene: 4,
      duration: '38-60s',
      on_screen_text: 'Respira. Ora sencillo. Vuelve a confiar.',
      visual: 'Primer plano de manos en oracion, fondo neutro, luz suave.',
    },
    {
      scene: 5,
      duration: '60-75s',
      on_screen_text: 'Guardalo y compartelo con alguien que necesite animo.',
      visual: 'Cierre con fondo limpio, subtitulos grandes y musica instrumental suave.',
    },
  ];

  return {
    date: plan.date,
    approved_index: index,
    title: selected.title,
    duration_seconds: selected.duration_seconds,
    script: selected.script,
    caption: selected.caption,
    scenes,
    voice_direction: 'Voz IA en espanol, tono calmado, pastoral, cercano, ritmo pausado, sin dramatizar demasiado.',
    tts_segments: [
      {
        id: 1,
        target_duration: '0-8s',
        text: selected.hook,
      },
      {
        id: 2,
        target_duration: '8-22s',
        text: `La Biblia nos recuerda en ${plan.scripts[index - 1].title.includes('silencio') ? 'Salmo 46:10' : 'la Palabra'} que la fe no es solo lo que decimos cuando todo esta facil.`,
      },
      {
        id: 3,
        target_duration: '22-42s',
        text: 'Hay momentos en que el corazon se cansa, pero esos momentos tambien pueden ser una invitacion a volver a Dios con honestidad.',
      },
      {
        id: 4,
        target_duration: '42-60s',
        text: 'Hoy toma un minuto en silencio. Respira. Ora sencillo. Pidele a Dios sabiduria, paz y un corazon limpio.',
      },
      {
        id: 5,
        target_duration: '60-75s',
        text: 'No construyas tu dia solo sobre emociones. Construyelo sobre verdad, obediencia y confianza. Si esto hablo a tu vida, guardalo y enviaselo a alguien que necesite animo hoy.',
      },
    ],
    visual_prompts: scenes.map((scene) => ({
      scene: scene.scene,
      prompt: `Video vertical 1080x1920 para contenido devocional cristiano en espanol. ${scene.visual} Tono visual calido, limpio, respetuoso, cinematografico suave, sin logos, sin texto incrustado, sin simbolos denominacionales fuertes, espacio para subtitulos grandes.`,
    })),
    music_direction: 'Instrumental suave tipo adoracion, volumen bajo, sin distraer de la voz.',
    export_settings: {
      format: 'vertical',
      resolution: '1080x1920',
      target_duration: '60-90 segundos',
      subtitles: 'grandes, alto contraste, una frase por beat',
    },
    production_checklist: [
      'Confirmar voz: propia, IA o solo subtitulos.',
      'Elegir visuales originales/licenciados/generados.',
      'Renderizar vertical 1080x1920.',
      'Revisar ortografia de subtitulos.',
      'Publicar manualmente primero en YouTube Shorts; luego Reels/TikTok cuando aplique.',
    ],
  };
}

async function generateOpenAiSpeech(text, destinationId = null) {
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  assertAllowedText(text);
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
  if (!response.ok) {
    let details = '';
    try {
      details = JSON.stringify(await response.json());
    } catch {
      details = await response.text();
    }
    setServiceStatus('media_provider', 'blocked', { code: `TTS_HTTP_${response.status}` });
    throw new Error(`Proveedor de voz no disponible (HTTP ${response.status}).`);
  }
  setServiceStatus('media_provider', 'ready');
  return Buffer.from(await response.arrayBuffer());
}

function serveStatic(req, res, pathname) {
  let relative = decodeURIComponent(pathname);
  if (relative === '/') relative = '/index.html';
  if (relative === '/terms') relative = '/terms.html';
  if (relative === '/privacy') relative = '/privacy.html';
  if (relative === '/tiktok-callback') relative = '/tiktok-callback.html';
  if (relative === '/studio' || relative === '/studio/') relative = '/studio/index.html';
  const file = path.normalize(path.join(publicDir, relative));
  if (!file.startsWith(publicDir)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
  const ext = path.extname(file);
  const isTikTokVerificationFile = /^\/(terms\/|privacy\/)?tiktok(?!-callback)/.test(relative);
  const type = isTikTokVerificationFile
    ? 'text/plain; charset=utf-8'
    : mimeTypes[ext] || 'application/octet-stream';
  const cacheControl = ext === '.png' ? 'public, max-age=86400' : 'no-store';
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': cacheControl,
  });
  res.end(body);
}

// ---------- Studio: panel web para generar, revisar y aprobar videos ----------
const studioPassword = process.env.STUDIO_PASSWORD || '';
const studioSecret = crypto.createHash('sha256').update(`studio:${studioPassword}:${internalToken}`).digest();
const studioCookieName = 'cc_studio';
const studioSessionDays = 30;
const studioLoginFailures = new Map();

function applyCustomIdea(parsed, customIdea) {
  const idea = polishSpanishText(String(customIdea).replace(/\s+/g, ' ').trim().slice(0, 160));
  if (idea.length < 8) throw new Error('La idea personalizada es muy corta.');
  assertAllowedText(idea);
  parsed.idea = idea;
  parsed.contentKey = normalizeContentKey(idea);
  parsed.ideaIndex = 3;
  return parsed;
}

function studioSign(expires) {
  return crypto.createHmac('sha256', studioSecret).update(String(expires)).digest('hex');
}

function studioAuthorized(req) {
  if (!studioPassword) return false;
  const cookie = String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${studioCookieName}=`));
  const [expires, signature] = (cookie ? cookie.slice(studioCookieName.length + 1) : '').split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(studioSign(expires));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function studioClientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim();
}

function studioLogin(req, res, password) {
  const ip = studioClientIp(req);
  const failures = studioLoginFailures.get(ip) || { count: 0, until: 0 };
  if (failures.until > Date.now()) {
    return json(res, 429, { ok: false, error: 'Demasiados intentos. Espera 15 minutos.' });
  }
  const expected = crypto.createHash('sha256').update(studioPassword).digest();
  const given = crypto.createHash('sha256').update(String(password || '')).digest();
  if (!studioPassword || !crypto.timingSafeEqual(expected, given)) {
    failures.count += 1;
    if (failures.count >= 5) Object.assign(failures, { count: 0, until: Date.now() + 15 * 60 * 1000 });
    studioLoginFailures.set(ip, failures);
    return json(res, 401, { ok: false, error: 'Clave incorrecta.' });
  }
  studioLoginFailures.delete(ip);
  const expires = Date.now() + studioSessionDays * 86_400_000;
  res.setHeader('set-cookie', `${studioCookieName}=${expires}.${studioSign(expires)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${studioSessionDays * 86400}`);
  return json(res, 200, { ok: true });
}

function readSysNumber(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return null;
  }
}

function studioSystemStatus() {
  const system = { gpu: null, disk: null };
  try {
    const card = fs.readdirSync('/sys/class/drm').find((name) => /^card\d+$/.test(name) && fs.existsSync(`/sys/class/drm/${name}/device/hwmon`));
    if (card) {
      const hwmonDir = `/sys/class/drm/${card}/device/hwmon`;
      const hwmon = `${hwmonDir}/${fs.readdirSync(hwmonDir)[0]}`;
      system.gpu = {
        edge: readSysNumber(`${hwmon}/temp1_input`) / 1000,
        junction: readSysNumber(`${hwmon}/temp2_input`) / 1000,
        fan: readSysNumber(`${hwmon}/fan1_input`),
        watts: Math.round((readSysNumber(`${hwmon}/power1_average`) || 0) / 1e6),
      };
    }
  } catch {}
  try {
    const stats = fs.statfsSync(dataDir);
    system.disk = { freeGb: Number(((stats.bavail * stats.bsize) / 1e9).toFixed(1)), totalGb: Number(((stats.blocks * stats.bsize) / 1e9).toFixed(1)) };
  } catch {}
  return system;
}

function studioJobView(job) {
  if (!job) return null;
  return {
    id: job.id,
    source: job.source,
    label: job.label,
    status: job.status,
    error: job.error || null,
    contentId: job.contentId || null,
    fileName: job.fileName || null,
    test: Boolean(job.test),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    logs: job.logs.slice(-120),
  };
}

function studioVideoView(metadata, extra = {}) {
  const slug = String(metadata.fileName || '').replace(/\.mp4$/, '');
  return {
    contentId: metadata.contentId || null,
    slug,
    fileName: metadata.fileName,
    title: metadata.title,
    hook: metadata.hook,
    idea: metadata.idea,
    destinationId: metadata.destinationId,
    script: metadata.script,
    scenes: (metadata.scenes || []).map((scene) => ({ narration: scene.narration, visual: scene.visual, start: scene.start, end: scene.end })),
    duration: metadata.duration,
    providers: metadata.ai_providers || { script: metadata.script_model },
    bibleReference: metadata.bible_reference || null,
    imageReviews: metadata.image_reviews || null,
    renderSeconds: metadata.render_seconds || null,
    styleVersion: metadata.style_version || 1,
    createdAt: metadata.created_at || null,
    ...extra,
  };
}

function studioState() {
  let destinations = [];
  try {
    destinations = buildMultiplatformPlan().destinations
      .filter((destination) => destination.youtubeChannelKey)
      .map((destination) => ({
        id: destination.id,
        label: displayBrandForDestination(destination),
        ideas: destination.videoIdeas.map((idea) => polishSpanishText(idea)),
      }));
  } catch (error) {
    destinations = [{ error: error.message }];
  }
  const items = readContentItems()
    .filter((item) => item.type === 'video')
    .slice(0, 60)
    .map((item) => {
      const generated = generatedVideoForContentId(item.contentId);
      const metadata = generated?.metadata || item;
      return studioVideoView(metadata, {
        contentId: item.contentId,
        kind: 'generated',
        status: item.status,
        available: Boolean(generated),
        youtubeUrl: item.publish_result?.youtube?.url || null,
        tiktokSent: Boolean(item.publish_result?.tiktok?.ok),
        tiktokCaption: tiktokCaptionFor({ ...metadata, title: item.title || metadata.title }),
        title: item.title || metadata.title,
        description: item.description || metadata.description,
        tags: youtubeTagsFor(metadata.destinationId),
        youtubeChannel: youtubeChannels[metadata.youtubeChannelKey]?.label || null,
        tiktokManual: metadata.destinationId === 'religioso',
        facebookPage: facebookPublishingEnabled ? metadata.facebookPageName || null : null,
        publishError: item.last_publish_error ? (item.last_publish_error.youtube?.error || item.last_publish_error.facebook?.error || 'Fallo la publicacion') : null,
        reconnectUrl: item.last_publish_error?.youtube?.reconnect_url || null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      });
    });
  const testDir = path.join(dataDir, 'test-videos');
  const tests = (fs.existsSync(testDir) ? fs.readdirSync(testDir) : [])
    .filter((name) => name.endsWith('.mp4'))
    .map((name) => {
      const metadata = readJson(path.join(testDir, name.replace(/\.mp4$/, ''), 'metadata.json'), { fileName: name });
      return studioVideoView({ ...metadata, fileName: name }, {
        kind: 'test',
        status: 'test',
        available: true,
        createdAt: fs.statSync(path.join(testDir, name)).mtime.toISOString(),
      });
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    ok: true,
    job: studioJobView(activeVideoJob || lastVideoJob),
    busy: Boolean(activeVideoJob),
    settings: studioSettings(),
    destinations,
    items,
    tests,
    system: studioSystemStatus(),
  };
}

async function studioVoiceModels() {
  try {
    const response = await fetch(`${localSpeechBaseUrl}/models?task=text-to-speech`, { signal: AbortSignal.timeout(5000) });
    const payload = await response.json();
    return (payload.data || [])
      .map((model) => model.id)
      .filter((id) => /piper-es_/.test(id))
      .map((id) => ({ id, voice: id.match(/piper-[a-z]{2}_[A-Z]{2}-([^-]+)-/)?.[1] || 'default' }));
  } catch {
    return [{ id: defaultLocalVoice.model, voice: defaultLocalVoice.voice }];
  }
}

async function saveStudioSettings(body) {
  const current = studioSettings();
  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  const next = {
    scriptProvider: ['openai', 'local'].includes(body.scriptProvider) ? body.scriptProvider : current.scriptProvider,
    voiceModel: current.voiceModel,
    voiceName: current.voiceName,
    voiceSpeed: {
      religioso: clamp(body.voiceSpeed?.religioso, 0.75, 1.2, current.voiceSpeed.religioso),
      fanspeliculas: clamp(body.voiceSpeed?.fanspeliculas, 0.75, 1.2, current.voiceSpeed.fanspeliculas),
    },
    voiceNatural: body.voiceNatural === undefined ? current.voiceNatural : Boolean(body.voiceNatural),
    sentencePause: clamp(body.sentencePause, 0, 0.6, current.sentencePause),
    scenePause: clamp(body.scenePause, 0.2, 1, current.scenePause),
    cinematicLook: body.cinematicLook === undefined ? current.cinematicLook : Boolean(body.cinematicLook),
    realClips: body.realClips === undefined ? current.realClips : Boolean(body.realClips),
  };
  if (body.voiceModel) {
    const model = (await studioVoiceModels()).find((candidate) => candidate.id === body.voiceModel);
    if (!model) throw new Error('Esa voz no esta instalada en speaches.');
    next.voiceModel = model.id;
    next.voiceName = model.voice;
  }
  writeJson(studioSettingsPath, next);
  fs.chmodSync(studioSettingsPath, 0o600);
  return studioSettings();
}

async function studioVoiceSample(body) {
  const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (text.length < 3) throw new Error('Escribe un texto para probar la voz.');
  const destinationId = body.destinationId === 'fanspeliculas' ? 'fanspeliculas' : 'religioso';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voz-'));
  try {
    const wavPath = path.join(dir, 'sample.wav');
    const mp3Path = path.join(dir, 'sample.mp3');
    await synthesizeSpeechFile(text, destinationId, wavPath, { tailPause: 0.2 });
    await runCommand('ffmpeg', ['-y', '-v', 'error', '-i', wavPath, '-af', 'loudnorm=I=-16:TP=-1.5', '-c:a', 'libmp3lame', '-b:a', '128k', mp3Path]);
    return fs.readFileSync(mp3Path);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function studioStartGeneration(body) {
  if (activeVideoJob) {
    const error = new Error(`Ya se esta generando un video (${activeVideoJob.label}). Espera a que termine.`);
    error.status = 409;
    throw error;
  }
  const destinationId = body.destinationId === 'fanspeliculas' ? 'fanspeliculas' : 'religioso';
  const ideaIndex = Math.max(0, Math.min(2, Number(body.ideaIndex) || 0));
  const command = `GENERAR VIDEO ${destinationId === 'religioso' ? 'RELIGIOSO' : 'PELICULAS'} ${ideaIndex + 1}`;
  const customIdea = String(body.customIdea || '').trim() || null;
  const parsed = parseVideoCommand(command);
  if (customIdea) applyCustomIdea(parsed, customIdea);
  if (body.mode === 'test') {
    runVideoJob('Studio (prueba)', `${destinationId}: ${parsed.idea}`, () => renderAutomatedVideo({ ...parsed, generationVersion: 1, test: true }))
      .catch((error) => console.warn(`[studio] prueba fallida: ${error.message}`));
    return { ok: true, started: true, idea: parsed.idea };
  }
  const existing = pendingPreviewForContentKey(destinationId, parsed.contentKey);
  if (existing) {
    return { ok: true, started: false, contentId: existing.metadata?.contentId, message: 'Esta idea ya tiene un preview pendiente; apruebalo o rechazalo primero.' };
  }
  produceAndPublishVideo(command, { source: 'Studio', customIdea })
    .catch((error) => console.warn(`[studio] generacion fallida: ${error.message}`));
  return { ok: true, started: true, idea: parsed.idea };
}

// Estado real de cada canal: se intenta renovar el permiso para detectar si vencio.
async function studioChannels() {
  const destinationsByChannel = {};
  try {
    for (const destination of buildMultiplatformPlan().destinations) {
      if (!destination.youtubeChannelKey) continue;
      (destinationsByChannel[destination.youtubeChannelKey] ||= []).push(displayBrandForDestination(destination));
    }
  } catch {}
  const youtube = [];
  for (const [key, config] of Object.entries(youtubeChannels)) {
    const tokenFile = youtubeTokenPathForChannel(key);
    const stored = readJson(tokenFile, null) || (config.legacyTokenPath ? readJson(config.legacyTokenPath, null) : null);
    const channel = {
      key,
      label: config.label,
      destinations: destinationsByChannel[key] || [],
      connectUrl: `/youtube/start?channel=${key}`,
      connected: false,
      status: 'disconnected',
      message: 'Sin conectar.',
      // Google entrega refresh_token_expires_in solo cuando la app OAuth esta en modo "Testing" (caduca en 7 dias).
      testingMode: Boolean(stored?.refresh_token_expires_in),
      connectedAt: stored?.connected_at || null,
    };
    if (stored?.refresh_token) {
      try {
        const token = await refreshAccessToken(stored, fs.existsSync(tokenFile) ? tokenFile : config.legacyTokenPath);
        requireYouTubeUploadScope(token);
        Object.assign(channel, { connected: true, status: 'ok', message: 'Conectado y con permiso para subir videos.' });
      } catch (error) {
        Object.assign(channel, {
          status: error.code === 'YOUTUBE_RECONNECT_REQUIRED' ? 'expired' : 'error',
          message: error.message,
        });
      }
    }
    youtube.push(channel);
  }
  return {
    youtube,
    tiktok: await tiktokStudioStatus(),
    facebook: { status: facebookPublishingEnabled ? 'ok' : 'disabled', message: facebookPublishingEnabled ? 'Publicacion en Facebook activa.' : 'Facebook esta deshabilitado (FACEBOOK_PUBLISHING_ENABLED=false).' },
  };
}

function studioMediaFile(kind, name) {
  if (!/^[a-z0-9-]+(\.mp4|\/scene-\d{1,2}\.png)$/.test(String(name || ''))) return null;
  const base = path.join(dataDir, kind === 'test' ? 'test-videos' : 'generated-videos');
  const file = path.normalize(path.join(base, name));
  return file.startsWith(base) && fs.existsSync(file) ? file : null;
}

function sendFileWithRange(req, res, file, type) {
  const { size } = fs.statSync(file);
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
  if (match && (match[1] || match[2])) {
    let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  return fs.createReadStream(file).pipe(res);
}

async function handleStudio(req, res, url) {
  const route = url.pathname.slice('/api/studio/'.length);
  if (route === 'login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    return studioLogin(req, res, body.password);
  }
  if (!studioAuthorized(req)) return json(res, 401, { ok: false, error: 'Inicia sesion.' });
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
    return json(res, 415, { ok: false, error: 'Se esperaba JSON.' });
  }
  try {
    if (route === 'logout' && req.method === 'POST') {
      res.setHeader('set-cookie', `${studioCookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return json(res, 200, { ok: true });
    }
    if (route === 'state' && req.method === 'GET') return json(res, 200, studioState());
    if (route === 'voices' && req.method === 'GET') return json(res, 200, { ok: true, voices: await studioVoiceModels() });
    if (route === 'channels' && req.method === 'GET') return json(res, 200, { ok: true, channels: await studioChannels() });
    if (route === 'media' && req.method === 'GET') {
      const file = studioMediaFile(url.searchParams.get('kind'), url.searchParams.get('name'));
      if (!file) return send(res, 404, 'Not found');
      return sendFileWithRange(req, res, file, file.endsWith('.png') ? 'image/png' : 'video/mp4');
    }
    if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'Ruta no encontrada.' });
    const body = await readJsonBody(req);
    if (route === 'generate') return json(res, 200, studioStartGeneration(body));
    if (route === 'approve') {
      const result = await publishGeneratedVideo(`APROBAR ${String(body.contentId || '')}`, body);
      return json(res, result.ok ? 200 : 409, result);
    }
    if (route === 'tiktok-send') {
      const item = findContentItem(String(body.contentId || ''));
      const generated = item && generatedVideoForContentId(item.contentId);
      if (!generated) return json(res, 404, { ok: false, error: 'No existe ese video o ya se borro el MP4.' });
      const tiktok = await sendGeneratedVideoToTikTok(generated.metadata);
      if (tiktok.ok) upsertContentItem({ ...item, publish_result: { ...(item.publish_result || {}), tiktok } });
      return json(res, tiktok.ok ? 200 : 409, { ok: Boolean(tiktok.ok), tiktok, error: tiktok.error || tiktok.reason });
    }
    if (route === 'reject') return json(res, 200, rejectContent(`RECHAZAR ${String(body.contentId || '')}`));
    if (route === 'settings') return json(res, 200, { ok: true, settings: await saveStudioSettings(body) });
    if (route === 'voice-sample') return send(res, 200, await studioVoiceSample(body), 'audio/mpeg');
    if (route === 'delete-test') {
      const name = String(body.name || '');
      const file = studioMediaFile('test', name);
      if (!file || !name.endsWith('.mp4')) return json(res, 404, { ok: false, error: 'No existe ese video de prueba.' });
      fs.rmSync(file, { force: true });
      fs.rmSync(path.join(dataDir, 'test-videos', name.replace(/\.mp4$/, '')), { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: 'Ruta no encontrada.' });
  } catch (error) {
    return json(res, error.status || 500, { ok: false, error: error.message });
  }
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, appBaseUrl);
    if (url.pathname.startsWith('/api/studio/')) return await handleStudio(req, res, url);
    if (url.pathname === '/youtube/start') {
      if (!clientId || !clientSecret) return send(res, 500, 'YouTube OAuth is not configured');
      const channelKey = resolveYouTubeChannelKey(url.searchParams.get('channel'));
      const state = crypto.randomBytes(24).toString('hex');
      saveOAuthState(state, channelKey);
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: `${appBaseUrl}/youtube/callback`,
        response_type: 'code',
        scope: [
          'openid',
          'profile',
          'https://www.googleapis.com/auth/youtube.readonly',
          'https://www.googleapis.com/auth/yt-analytics.readonly',
          'https://www.googleapis.com/auth/youtube.upload',
        ].join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      });
      return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    }

    if (url.pathname === '/tiktok/start') {
      if (!studioAuthorized(req)) return redirect(res, '/studio');
      if (!tiktokClientKey || !tiktokClientSecret) return send(res, 500, 'Falta TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET en el .env', 'text/plain; charset=utf-8');
      const state = crypto.randomBytes(24).toString('hex');
      saveOAuthState(state, 'tiktok');
      const params = new URLSearchParams({
        client_key: tiktokClientKey,
        scope: 'user.info.basic,video.upload',
        response_type: 'code',
        redirect_uri: tiktokRedirectUri,
        state,
      });
      return redirect(res, `https://www.tiktok.com/v2/auth/authorize/?${params}`);
    }

    if (url.pathname === '/tiktok-callback' && (url.searchParams.has('code') || url.searchParams.has('error'))) {
      const page = (title, text) => send(res, 200, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f5f7f4;color:#17212b;margin:0;display:grid;min-height:100vh;place-items:center}main{width:min(640px,calc(100vw - 32px));background:#fff;border:1px solid #dfe5dc;border-radius:8px;padding:28px}h1{color:#0d3138;font-size:24px}</style></head>
<body><main><h1>${title}</h1><p>${text}</p><p><a href="/studio">Volver al Studio</a></p></main></body></html>`, 'text/html; charset=utf-8');
      if (!consumeOAuthState(url.searchParams.get('state'))) return page('TikTok: enlace vencido', 'Vuelve al Studio y pulsa Conectar TikTok otra vez.');
      if (url.searchParams.has('error')) return page('TikTok no se conecto', escapeHtml(url.searchParams.get('error_description') || url.searchParams.get('error')));
      try {
        const token = await tiktokTokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: tiktokRedirectUri });
        if (!String(token.scope || '').includes('video.upload')) {
          return page('Falta un permiso', 'TikTok no concedio <b>video.upload</b>. Revisa que la app tenga Content Posting API y vuelve a conectar marcando todos los permisos.');
        }
        const user = await tiktokApi('/v2/user/info/?fields=open_id,display_name', token.access_token).catch(() => ({}));
        writeJson(tiktokTokenPath, { ...token, display_name: user.user?.display_name || null, connected_at: new Date().toISOString() });
        return page('TikTok conectado', `Cuenta: <b>${escapeHtml(user.user?.display_name || token.open_id)}</b>. Al aprobar un video de Vida con Dios, llegara a tu bandeja de TikTok.`);
      } catch (error) {
        return page('TikTok no se conecto', escapeHtml(error.message));
      }
    }

    if (url.pathname === '/youtube/callback') {
      const code = url.searchParams.get('code');
      if (!code) return send(res, 400, 'Missing authorization code');
      const oauthState = consumeOAuthState(url.searchParams.get('state'));
      if (!oauthState) {
        console.warn('Proceeding with YouTube callback after OAuth state mismatch');
      }
      const requestedChannelKey = resolveYouTubeChannelKey(oauthState?.channel_key);
      const token = await exchangeCode(code);
      const tempToken = {
        ...token,
        expires_at: Date.now() + (token.expires_in || 3600) * 1000,
        connected_at: new Date().toISOString(),
      };
      let report = null;
      try {
        report = await buildYouTubeReportFromAccessToken(token.access_token, requestedChannelKey);
      } catch (error) {
        return send(res, 409, `Google authorized the account, but YouTube did not return a channel for it. Use the Google account that owns or manages the target channel, then try again. Details: ${error.message}`, 'text/plain; charset=utf-8');
      }
      const matchedChannelKey = youtubeChannelKeyForId(report.channel.id);
      const channelKey = matchedChannelKey || requestedChannelKey;
      const expectedChannelId = youtubeChannels[channelKey].expectedChannelId;
      if (expectedChannelId && report.channel.id !== expectedChannelId) {
        return send(res, 409, `Connected channel ${report.channel.id} does not match expected ${expectedChannelId}. Start from /youtube/start?channel=${channelKey} with the correct YouTube account.`, 'text/plain; charset=utf-8');
      }
      writeYouTubeToken(channelKey, tempToken);
      const title = escapeHtml(report.channel.title);
      return send(res, 200, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YouTube Connected - ContentCreator</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f5f7f4;color:#17212b;margin:0;display:grid;min-height:100vh;place-items:center}main{width:min(760px,calc(100vw - 32px));background:#fff;border:1px solid #dfe5dc;border-radius:8px;padding:28px}h1{color:#0d3138}.ok{display:inline-block;background:#eff7ef;color:#214a2c;padding:10px 12px;border-radius:8px}.box{background:#10282e;color:#f3fbf4;padding:16px;border-radius:8px;font-family:Consolas,monospace;white-space:pre-line}</style></head>
<body><main><div class="ok">YouTube authorization received</div><h1>ContentCreator connected your YouTube channel</h1>
<p>The channel is now ready for private Telegram growth reports.</p>
<div class="box">Destination: ${escapeHtml(youtubeChannels[channelKey].label)}
Channel: ${title}
Channel ID: ${escapeHtml(report.channel.id)}
Subscribers: ${report.channel.statistics.subscriberCount ?? 'hidden'}
Total views: ${report.channel.statistics.viewCount}
Videos: ${report.channel.statistics.videoCount}</div>
<p><a href="/studio">Volver al Studio</a></p></main></body></html>`, 'text/html; charset=utf-8');
    }

    if (url.pathname === '/api/youtube/report') {
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      if (url.searchParams.get('all') === '1') {
        return json(res, 200, await getYouTubeReports());
      }
      return json(res, 200, await getYouTubeReport(url.searchParams.get('channel') || defaultYouTubeChannelKey));
    }

    if (url.pathname === '/api/publish/youtube-short') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      try {
        const body = await readJsonBody(req);
        return json(res, 200, await uploadYouTubeVideo({
          fileName: body.fileName,
          title: body.title,
          description: body.description,
          privacyStatus: body.privacyStatus || 'private',
          tags: body.tags || ['Fe', 'Dios', 'Oracion', 'Devocional', 'Cristianos', 'Shorts'],
          channelKey: body.channelKey || defaultYouTubeChannelKey,
        }));
      } catch (error) {
        const status = error.code === 'YOUTUBE_UPLOAD_SCOPE_MISSING' ? 409 : 500;
        return json(res, status, {
          error: error.message,
          code: error.code || 'PUBLISH_FAILED',
          reconnect_url: error.reconnect_url,
        });
      }
    }

    if (url.pathname === '/api/publish/status') {
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      return json(res, 200, { items: readJson(publishLogPath, []) });
    }

    if (url.pathname === '/api/content/produce-and-publish-video') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      let event = null;
      try {
        const body = await readJsonBody(req);
        event = beginCommandEvent(body.requestId, { route: url.pathname, command: body.command || '' });
        if (!event.isNew) {
          return json(res, 200, commandDuplicateResult(event.existing, 'Telegram repitio este comando; preview/video no se reenvia.'));
        }
        const result = await produceAndPublishVideo(body.command || '', { publish: body.publish === true });
        completeCommandEvent(event, result);
        return json(res, 200, result);
      } catch (error) {
        completeCommandEvent(event, {
          ok: false,
          error: error.message,
          stderr: error.stderr ? String(error.stderr).slice(-1200) : undefined,
        });
        return json(res, 500, {
          ok: false,
          error: error.message,
          stderr: error.stderr ? String(error.stderr).slice(-1200) : undefined,
        });
      }
    }

    if (url.pathname === '/api/content/publish-latest-video') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      let event = null;
      try {
        const body = await readJsonBody(req);
        event = beginCommandEvent(body.requestId, { route: url.pathname, command: body.command || '' });
        if (!event.isNew) {
          return json(res, 200, commandDuplicateResult(event.existing, 'Telegram repitio esta aprobacion; no se vuelve a publicar ni reenviar.'));
        }
        const result = await publishGeneratedVideo(body.command || '');
        completeCommandEvent(event, result);
        return json(res, 200, result);
      } catch (error) {
        completeCommandEvent(event, {
          ok: false,
          error: error.message,
          stderr: error.stderr ? String(error.stderr).slice(-1200) : undefined,
        });
        return json(res, 500, {
          ok: false,
          error: error.message,
          stderr: error.stderr ? String(error.stderr).slice(-1200) : undefined,
        });
      }
    }

    if (url.pathname === '/api/content/religious-plan') {
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      return json(res, 200, buildReligiousContentPlan());
    }

    if (url.pathname === '/api/content/multiplatform-plan') {
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      return json(res, 200, buildMultiplatformPlan(url.searchParams.get('date') || new Date()));
    }

    if (url.pathname === '/api/content/items') {
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      const status = url.searchParams.get('status');
      const items = readContentItems().filter((item) => !status || item.status === status);
      return json(res, 200, { ok: true, count: items.length, items });
    }

    if (url.pathname === '/api/content/readiness-report') {
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      return json(res, 200, await buildReadinessReport());
    }

    if (url.pathname === '/api/content/prepare-facebook-post') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      let event = null;
      try {
        const body = await readJsonBody(req);
        event = beginCommandEvent(body.requestId, { route: url.pathname, command: body.command || '' });
        if (!event.isNew) {
          return json(res, 200, genericCommandDuplicateResult(event.existing, 'Telegram repitio la preparacion; no se reenvia la imagen.'));
        }
        const result = await prepareFacebookPostPreview(body.command || '');
        completeCommandEvent(event, result);
        return json(res, 200, result);
      } catch (error) {
        const result = { ok: false, error: error.message, code: error.code || 'PREPARE_POST_FAILED' };
        completeCommandEvent(event, result);
        return json(res, 500, result);
      }
    }

    if (url.pathname === '/api/content/approve-facebook-post') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      let event = null;
      try {
        const body = await readJsonBody(req);
        event = beginCommandEvent(body.requestId, { route: url.pathname, command: body.command || '' });
        if (!event.isNew) {
          return json(res, 200, genericCommandDuplicateResult(event.existing, 'Telegram repitio la aprobacion del post; no se programa de nuevo.'));
        }
        const result = await approvePreparedFacebookPost(body.command || '');
        completeCommandEvent(event, result);
        return json(res, 200, result);
      } catch (error) {
        const result = { ok: false, error: error.message, code: error.code || 'APPROVE_POST_FAILED' };
        completeCommandEvent(event, result);
        return json(res, 500, result);
      }
    }

    if (url.pathname === '/api/content/reject') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      try {
        const body = await readJsonBody(req);
        return json(res, 200, rejectContent(body.command || body.contentId || ''));
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message, code: error.code || 'REJECT_FAILED' });
      }
    }

    if (url.pathname === '/api/content/ack-telegram-delivery') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      try {
        const body = await readJsonBody(req);
        return json(res, 200, acknowledgeTelegramDelivery(body.contentId || ''));
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message, code: 'TELEGRAM_ACK_FAILED' });
      }
    }

    if (url.pathname === '/api/content/video-delivery-check') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      try {
        const body = await readJsonBody(req);
        return json(res, 200, videoDeliveryStatus(body.contentId || ''));
      } catch (error) {
        return json(res, 400, { ok: false, allowed: false, error: error.message, code: 'VIDEO_DELIVERY_CHECK_FAILED' });
      }
    }

    if (url.pathname === '/api/content/schedule-facebook-plan') {
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      return json(res, 409, {
        ok: false,
        error: 'La programacion directa fue desactivada. Primero usa PREPARAR POST <DESTINO> <1-3> y despues APROBAR PST-... con el ID del preview.',
      });
    }

    if (url.pathname === '/api/content/approved-video') {
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      const index = Number(url.searchParams.get('index') || '1');
      return json(res, 200, buildApprovedVideoPackage(index));
    }

    if (url.pathname === '/api/content/tts') {
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      const index = Number(url.searchParams.get('index') || '1');
      const pack = buildApprovedVideoPackage(index);
      const audioDir = path.join(dataDir, 'audio');
      fs.mkdirSync(audioDir, { recursive: true });
      const slug = `aprobado-${index}-${pack.date}.mp3`;
      const outPath = path.join(audioDir, slug);
      const text = pack.tts_segments.map((segment) => segment.text).join('\n\n');
      const { value: audio, provider } = await generateSpeech(text);
      fs.writeFileSync(outPath, audio, { mode: 0o600 });
      return json(res, 200, {
        ok: true,
        title: pack.title,
        audio_url: `${appBaseUrl}/media/audio/${slug}`,
        bytes: audio.length,
        provider,
      });
    }

    if (url.pathname === '/api/content/tts-custom') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!internalToken || req.headers['x-internal-token'] !== internalToken) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { error: 'text is required' });
      assertAllowedText(text);
      const slugBase = String(body.slug || `tts-${Date.now()}`)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || `tts-${Date.now()}`;
      const audioDir = path.join(dataDir, 'audio');
      fs.mkdirSync(audioDir, { recursive: true });
      const slug = `${slugBase}.mp3`;
      const outPath = path.join(audioDir, slug);
      const { value: audio } = await generateSpeech(text);
      fs.writeFileSync(outPath, audio, { mode: 0o600 });
      return json(res, 200, {
        ok: true,
        audio_url: `${appBaseUrl}/media/audio/${slug}`,
        bytes: audio.length,
      });
    }

    if (url.pathname.startsWith('/media/audio/')) {
      const fileName = path.basename(url.pathname);
      const file = path.join(dataDir, 'audio', fileName);
      if (!fs.existsSync(file)) return send(res, 404, 'Not found');
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': body.length,
        'cache-control': 'private, max-age=3600',
      });
      return res.end(body);
    }

    if (url.pathname.startsWith('/media/post-image/')) {
      const fileName = path.basename(url.pathname);
      const file = path.join(dataDir, 'generated-post-images', fileName);
      if (!fs.existsSync(file)) return send(res, 404, 'Not found');
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': body.length,
        'cache-control': 'public, max-age=604800',
      });
      return res.end(body);
    }

    if (url.pathname.startsWith('/media/video/')) {
      const fileName = path.basename(url.pathname);
      const generated = generatedVideoForFileName(fileName);
      if (generated && isRejectedVideoCandidate(generated)) {
        return json(res, 410, {
          ok: false,
          code: 'VIDEO_VERSION_REJECTED',
          error: 'Esta version fue rechazada y su entrega esta bloqueada.',
        });
      }
      const candidates = [
        path.join(dataDir, 'video-001', 'output', fileName),
        path.join(dataDir, 'generated-videos', fileName),
      ];
      const videoDirs = fs.existsSync(dataDir)
        ? fs.readdirSync(dataDir).filter((name) => /^video-/.test(name))
        : [];
      for (const dir of videoDirs) {
        candidates.push(path.join(dataDir, dir, 'output', fileName));
      }
      const file = candidates.find((candidate) => fs.existsSync(candidate));
      if (!file) return send(res, 404, 'Not found');
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': body.length,
        'cache-control': 'private, max-age=3600',
      });
      return res.end(body);
    }

    if (url.pathname === '/youtube/status') {
      const channels = {};
      for (const [key, config] of Object.entries(youtubeChannels)) {
        const token = readJson(youtubeTokenPathForChannel(key));
        channels[key] = {
          label: config.label,
          expectedChannelId: config.expectedChannelId,
          connected: false,
          token_present: Boolean(token?.refresh_token),
          connect_url: `${appBaseUrl}/youtube/start?channel=${key}`,
        };
        if (token?.refresh_token) {
          try {
            const report = await getYouTubeReport(key);
            channels[key].connected = report.channel?.id === config.expectedChannelId;
            channels[key].channel = {
              id: report.channel?.id,
              title: report.channel?.title,
            };
            if (!channels[key].connected) {
              channels[key].error = `Connected channel ${report.channel?.id || 'N/D'} does not match expected ${config.expectedChannelId}`;
            }
          } catch (error) {
            channels[key].error = error.message;
            try {
              const publicReport = await getPublicYouTubeChannelReport(key, error);
              channels[key].public_metrics = true;
              channels[key].oauth_required = true;
              channels[key].channel = {
                id: publicReport.channel.id,
                title: publicReport.channel.title,
              };
              channels[key].statistics = publicReport.channel.statistics;
            } catch {}
          }
        }
      }
      return json(res, 200, { connected: Object.values(channels).some((item) => item.connected), channels });
    }

    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message });
  }
}

if (require.main === module) {
  http.createServer((req, res) => {
    handle(req, res);
  }).listen(process.env.PORT || 3000, () => {
    console.log(`ContentCreator listening on ${process.env.PORT || 3000}`);
  });
  setTimeout(refreshAiIdeas, 60_000);
  setInterval(refreshAiIdeas, 30 * 60_000);
}

module.exports = {
  buildMultiplatformPlan,
  generateQualifiedVideoPlan,
  renderAutomatedVideo,
  parseVideoCommand,
  scriptQualityReport,
  scriptSimilarity,
  videoDeliveryStatus,
  videoGenerationContext,
  wordCount,
  tiktokCaptionFor,
  tiktokTelegramMessage,
  notifyTelegram,
  generateAiIdeas,
  refreshAiIdeas,
};
