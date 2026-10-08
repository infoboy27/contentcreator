# Pasarela de imágenes y video (stable-diffusion.cpp con Vulkan).
# Funciona con GPUs AMD (Mesa RADV) y, con el override de NVIDIA, con el driver Vulkan de NVIDIA.
FROM ubuntu:24.04
ARG SD_RELEASE_URL=https://github.com/leejet/stable-diffusion.cpp/releases/download/master-945-a1ded76/sd-master-a1ded76-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip
RUN apt-get update \
 && apt-get install -y --no-install-recommends mesa-vulkan-drivers libvulkan1 libgomp1 python3 ffmpeg ca-certificates curl unzip \
 && curl -fsSL "$SD_RELEASE_URL" -o /tmp/sd.zip \
 && mkdir -p /tmp/sd /opt/sd && unzip -q /tmp/sd.zip -d /tmp/sd \
 && cp -a "$(dirname "$(find /tmp/sd -type f -name sd-cli | head -1)")"/. /opt/sd/ \
 && chmod +x /opt/sd/sd-cli \
 && rm -rf /tmp/sd /tmp/sd.zip \
 && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY gateway.py /opt/gateway.py
ENV LD_LIBRARY_PATH=/opt/sd PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "/opt/gateway.py"]
