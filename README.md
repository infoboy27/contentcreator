# ContentCreator

Asistente para crear y publicar videos cortos (YouTube Shorts / TikTok) con IA local en tu GPU.
Escribe el guion, genera la voz, las imágenes y los subtítulos, arma el video y lo publica en el canal que corresponde.
Se maneja desde un panel web (**Studio**) o desde Telegram.

| Paso | Motor | Dónde corre |
|---|---|---|
| Guion (9 escenas con narración e imagen) | OpenAI (`AI_SCRIPT_PROVIDER=openai`) o qwen3.5:9b | Nube o GPU |
| Voz | Piper es_MX "claude" vía speaches, con pausas y procesado | CPU |
| Imágenes 9:16 | Z-Image-Turbo (stable-diffusion.cpp, Vulkan) + revisión visual de qwen | GPU |
| Subtítulos karaoke | Whisper large-v3-turbo con marcas por palabra | CPU |
| Montaje | ffmpeg (Ken Burns, subtítulos ASS, loudnorm) | CPU |
| Publicación | YouTube Data API (un canal por destino); TikTok a mano | — |

Un video de 60–95 s tarda unos 15 minutos en una RX 6700 XT. Si algo local falla, OpenAI sirve de respaldo.

## Destinos

| Destino | YouTube | TikTok | Facebook |
|---|---|---|---|
| `religioso` · Vida con Dios | canal *Vida con Dios* | manual (descarga MP4 + copiar texto) | deshabilitado |
| `fanspeliculas` · Fans Películas y Novelas | canal *Fans Peliculas y Novelas* | — | — |

Los IDs de canal esperados están en `youtubeChannels` (server.js); cámbialos si replicas con otros canales.

## Estructura

```
server.js              Backend (Node 22, sin dependencias): motor de video, API, Studio, OAuth de YouTube
public/studio/         Studio: generar, revisar, publicar, canales y ajustes
tools/                 Pruebas por consola (video completo o solo guion + voz)
stack/                 Stack completo para un equipo nuevo (Ollama, speaches, sdcpp, ContentCreator, n8n, cloudflared)
  sdcpp/               Pasarela de imágenes/video compatible con OpenAI que turna la VRAM con Ollama
scripts/               install.sh, stack.sh, download-models.sh, setup-ai.sh, import-n8n.sh, curva de ventiladores
n8n/workflows/         Workflows de Telegram (router de comandos, videos, reportes, errores)
docker-compose.yml     Despliegue del servidor de referencia (Traefik + ~/ai-local)
```

`data/` (videos, tokens de YouTube, historial) y `.env` no van al repositorio.

## Instalar en un equipo nuevo

Requisitos: Ubuntu 24.04, Docker con el plugin compose, GPU AMD con ROCm (referencia: RX 6700 XT 12 GB) o NVIDIA con
`nvidia-container-toolkit` (sin probar), unos 25 GB libres (35 GB con video) y 16 GB de RAM o más.

```bash
git clone <este repo> contentcreator && cd contentcreator
scripts/install.sh            # agrega --video para los modelos de video Wan2.2
```

El instalador:
1. Detecta la GPU y crea `.env` con claves nuevas (Studio, token interno, n8n).
2. Descarga los modelos de imagen (~6.7 GB) a `stack/models`.
3. Construye sdcpp y levanta Ollama, speaches, sdcpp, ContentCreator y n8n (solo en 127.0.0.1).
4. Instala qwen3.5:9b, la voz Piper y Whisper.
5. Importa y activa los workflows de n8n y registra el webhook de Telegram.
6. Ofrece instalar la curva de ventiladores (solo AMD, con sudo).

Después completa `.env` y aplica con `scripts/stack.sh up -d`:

- `OPENAI_API_KEY` (guion y respaldo).
- `APP_BASE_URL` y `N8N_PUBLIC_URL`: publícalos con **Cloudflare Tunnel** (sin abrir puertos).
  Pon `CLOUDFLARE_TUNNEL_TOKEN` y levanta `scripts/stack.sh --profile tunnel up -d`. En Cloudflare, apunta el Studio a
  `http://contentcreator:3000` y n8n a `http://n8n:5678`.
- `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`, y luego `scripts/import-n8n.sh` para registrar el webhook.

### YouTube (una sola vez por proyecto de Google)

1. Google Cloud → habilita **YouTube Data API v3** y **YouTube Analytics API**.
2. Google Auth Platform → Clients → *Web application* con el redirect `${APP_BASE_URL}/youtube/callback`.
   Copia el ID y el secreto a `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`.
3. **Audience → Publish app ("In production").** En modo *Testing* Google revoca los permisos cada 7 días
   y la publicación falla con `invalid_grant` / "Bad Request". No hace falta verificar la app para uso propio.
4. Studio → **Canales** → *Conectar* en cada canal, entrando con la cuenta dueña del canal.

## Uso diario

**Studio** (`${APP_BASE_URL}/studio`, clave en `STUDIO_PASSWORD`):
- *Generar*: canal + idea del día o idea propia; preview (cola de aprobación) o prueba. Muestra el progreso en vivo.
- *Por aprobar*: ves el video y las escenas, editas título, descripción, etiquetas y visibilidad, y publicas en el canal del destino.
  Si falla (p. ej. un permiso vencido), queda en "Falló la publicación" con el enlace para reconectar y reintentar.
- *Historial*: enlace a YouTube y, para TikTok, MP4 y texto listos para subir a mano.
- *Canales*: estado real de cada permiso de YouTube.
- *Ajustes*: proveedor del guion, velocidad y pausas de la voz, prueba de voz, temperatura de la GPU y disco.

**Telegram**: `GENERAR VIDEO RELIGIOSO 1-3`, `GENERAR VIDEO PELICULAS 1-3`, `APROBAR VID-…`, `RECHAZAR VID-…`, `REPORTE AHORA`.

Solo se genera un video a la vez (la GPU es una); un segundo pedido recibe un aviso para esperar.

## Pruebas por consola

```bash
docker exec -e HYBRID=1 contentcreator-site node /app/tools/test-plan.js "GENERAR VIDEO PELICULAS 2"   # guion + voz (30 s)
docker exec -e HYBRID=1 contentcreator-site node /app/tools/test-video.js "GENERAR VIDEO RELIGIOSO 1"  # video completo
```
Sin `HYBRID=1` todo se hace con IA local. Los videos de prueba quedan en `data/test-videos` y se ven en Studio → Pruebas.
(En el stack nuevo el contenedor se llama `contentcreator-contentcreator-1`; usa `scripts/stack.sh exec contentcreator …`.)

## Temperatura de la GPU

`scripts/gpu-fan-curve.sh` (servicio systemd) toma el control del ventilador desde 65 °C de junction
(65 → 45 %, 80 → 70 %, 90 → 90 %, 95 → 100 %) y lo devuelve al firmware por debajo de 55 °C.
Ver: `journalctl -u gpu-fan-curve -f`.

## Lecciones del modelo local (por qué hay tantas barandas en el código)

- qwen 9B no respeta conteos de palabras: se valida por escena y la duración real de la voz manda (se ajusta la velocidad antes de reescribir).
- Citas bíblicas de una lista cerrada (`knownBiblePassages`); el modelo solo elige cuál encaja.
- Z-Image dibuja letras con palabras como *poster/sign/dialogue*: se quitan del prompt y cada imagen pasa por revisión visual.
- Kokoro lee la "j" española como "k": por eso la voz es Piper.
- Ollama y sdcpp comparten la VRAM: la pasarela descarga el LLM antes de cada imagen y reintenta si choca.
