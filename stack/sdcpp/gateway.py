#!/usr/bin/env python3
"""Pasarela de imágenes: API compatible con OpenAI (/v1/images/generations).
Por cada imagen libera la VRAM del LLM en Ollama, ejecuta sd-cli (que suelta la VRAM al terminar)
y devuelve la imagen en base64."""
import base64, json, os, random, subprocess, tempfile, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OLLAMA = os.environ.get("OLLAMA_URL", "http://ollama:11434")
M = "/models"
SD_ARGS = ["/opt/sd/sd-cli",
           "--diffusion-model", f"{M}/z_image_turbo-Q4_K.gguf",
           "--llm", f"{M}/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
           "--vae", f"{M}/ae.safetensors",
           "--diffusion-fa", "--vae-tiling", "--cfg-scale", "1.0", "--steps", "8"]
MODEL_ID = "z-image-turbo"
V = f"{M}/video"
VID_ARGS = ["/opt/sd/sd-cli", "-M", "vid_gen",
            "--diffusion-model", f"{V}/Wan2.2-TI2V-5B-Q4_K_M.gguf",
            "--t5xxl", f"{V}/umt5-xxl-encoder-Q4_K_M.gguf",
            "--vae", f"{V}/wan2.2_vae.safetensors",
            # texto en CPU (rápido); VAE en GPU: en CPU tardaba ~10 min
            "--backend", "diffusion=Vulkan0,te=cpu,vae=Vulkan0",
            "--video-frames", "33", "--fps", "16", "--steps", "20",
            "--cfg-scale", "5.0", "--flow-shift", "5.0", "--sampling-method", "euler", "--vae-tiling",
            "-n", "static, still image, blurry, distorted, deformed, low quality, jitter, watermark"]
lock = threading.Lock()

def ollama(path, body=None):
    req = urllib.request.Request(OLLAMA + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def unload_llms(only_partial=False):
    try:
        for m in ollama("/api/ps").get("models", []):
            if only_partial and m.get("size_vram", 0) >= m.get("size", 0):
                continue
            ollama("/api/generate", {"model": m["name"], "keep_alive": 0})
    except Exception as e:
        print("aviso: no pude descargar el LLM:", e, flush=True)

def size_wh(size):
    try:
        w, h = (int(x) for x in str(size).lower().split("x"))
    except Exception:
        w, h = 1024, 1024
    clamp = lambda v: max(256, min(1536, v // 64 * 64))
    return clamp(w), clamp(h)

def generate(prompt, size, n):
    w, h = size_wh(size)
    out = []
    with lock:
        unload_llms()
        for _ in range(max(1, min(int(n or 1), 4))):
            with tempfile.TemporaryDirectory() as d:
                path = os.path.join(d, "img.png")
                t = time.time()
                p = subprocess.run(SD_ARGS + ["-p", prompt, "-W", str(w), "-H", str(h),
                                              "-s", str(random.randint(0, 2**31 - 1)), "-o", path],
                                   capture_output=True, text=True, timeout=900)
                if p.returncode != 0 or not os.path.exists(path):
                    raise RuntimeError((p.stderr or p.stdout)[-800:])
                print(f"imagen {w}x{h} en {time.time()-t:.1f}s: {prompt[:80]!r}", flush=True)
                out.append(base64.b64encode(open(path, "rb").read()).decode())
        unload_llms(only_partial=True)  # si el LLM se cargó a medias durante la generación, que se recargue entero en GPU
    return out

def image_dims(data):
    """(ancho, alto) de un PNG o JPEG sin dependencias."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    i = 2
    while i < len(data) - 9:
        if data[i] != 0xFF:
            i += 1; continue
        mk = data[i + 1]
        if mk in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
    return 1, 1

def video_size(img):
    # tamaños conservadores: 640x640 con flash-attn provocó un reset de la GPU
    if not img:
        return 480, 480
    w, h = image_dims(img)
    r = w / max(h, 1)
    return (512, 384) if r > 1.15 else (384, 512) if r < 0.87 else (480, 480)

def generate_video(prompt, img):
    w, h = video_size(img)
    with lock:
        unload_llms()
        with tempfile.TemporaryDirectory() as d:
            args = VID_ARGS + ["-p", prompt, "-W", str(w), "-H", str(h),
                               "-s", str(random.randint(0, 2**31 - 1)), "-o", f"{d}/v.webm"]
            if img:
                open(f"{d}/in.img", "wb").write(img)
                args += ["-i", f"{d}/in.img"]
            t = time.time()
            p = subprocess.run(args, capture_output=True, text=True, timeout=1800)
            if p.returncode != 0 or not os.path.exists(f"{d}/v.webm"):
                raise RuntimeError((p.stderr or p.stdout)[-800:])
            f = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{d}/v.webm", "-c:v", "libx264",
                                "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", f"{d}/v.mp4"],
                               capture_output=True, text=True, timeout=300)
            if f.returncode != 0:
                raise RuntimeError("ffmpeg: " + f.stderr[-400:])
            print(f"video {w}x{h} {'i2v' if img else 't2v'} en {time.time()-t:.1f}s: {prompt[:80]!r}", flush=True)
            data = open(f"{d}/v.mp4", "rb").read()
        unload_llms(only_partial=True)
    return data

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            return self._send(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local"}]})
        if self.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") == "/v1/videos":
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                prompt = str(body.get("prompt", "")).strip() or "natural subtle motion, cinematic, smooth camera movement"
                img = base64.b64decode(body["image"]) if body.get("image") else None
                data = generate_video(prompt, img)
                self.send_response(200); self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Disposition", 'attachment; filename="video.mp4"')
                self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            except Exception as e:
                print("error video:", e, flush=True)
                self._send(500, {"error": {"message": str(e)}})
            return
        if self.path.rstrip("/") not in ("/v1/images/generations", "/images/generations"):
            return self._send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            prompt = str(body.get("prompt", "")).strip()
            if not prompt:
                return self._send(400, {"error": {"message": "prompt vacío"}})
            imgs = generate(prompt, body.get("size", "1024x1024"), body.get("n", 1))
            self._send(200, {"created": int(time.time()), "data": [{"b64_json": i} for i in imgs]})
        except Exception as e:
            print("error:", e, flush=True)
            self._send(500, {"error": {"message": str(e)}})

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    print("pasarela de imágenes en :7860", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 7860), H).serve_forever()
