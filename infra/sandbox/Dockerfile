# Sandbox de ejecución de código para JARVIS.
#
# Contrato de aislamiento (debe coincidir con packages/tool-registry/src/sandbox.ts):
#   · red: ninguna (el runtime la impone con --network none)
#   · filesystem: solo lectura salvo /tmp (tmpfs, el runtime la impone)
#   · usuario: no privilegiado (65534:65534, impuesto por el runtime)
#   · dependencias: registry offline; sin red en tiempo de ejecución
#
# Esta imagen NO necesita red en tiempo de ejecución. La red solo se usa al
# construirla (instalación del toolchain), que es una tarea del operador.

FROM debian:13.4-slim

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    LC_ALL=C.UTF-8 \
    LANG=C.UTF-8 \
    PYTHONHASHSEED=0 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 \
      nodejs \
      g++ \
      make \
      cargo \
      golang-go \
 && rm -rf /var/lib/apt/lists/*

# Directorios de trabajo escribibles (temporal en runtime, tmpfs).
RUN mkdir -p /tmp/target /tmp/cargo /tmp/gocache /tmp/gomodcache /tmp/gopath /w \
 && chmod 1777 /tmp

WORKDIR /w

CMD ["/bin/sh", "-lc", "echo 'sandbox JARVIS listo'"]
