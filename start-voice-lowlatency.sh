#!/usr/bin/env bash
# --------------------------------------------------------------
# Arranque rápido de JARVIS con latencia de voz minimizada
# --------------------------------------------------------------
set -euo pipefail

# 1️⃣  Variables de entorno óptimas
export JARVIS_ACCESS_TOKEN="${JARVIS_ACCESS_TOKEN:-test}"
export VOICE_TTS_ENGINE=kokoro
export VOICE_TTS_KOKORO_URL=http://127.0.0.1:8788
export VOICE_TTS_KOKORO_VOICE=em_alex
export VOICE_TTS_SAY_VOICE=Jorge
export VOICE_TTS_MAX_SENTENCE_CHARS=160
export VOICE_TTS_MAX_PENDING_CHARS=80
export VOICE_TTS_MAX_CONCURRENT=4
export VOICE_FAST_TURNS=true
export VOICE_STT_PROVIDER=server
export VOICE_ASR_ENABLED=true
export VOICE_ASR_MODEL=nvidia/parakeet-rnnt-1.1b
export VOICE_ASR_BASE_URL=http://127.0.0.1:8789
export VOICE_MIC_SILENCE_MS=500
export VOICE_MIC_WARMUP_MS=150
export VOICE_MIC_THRESHOLD=0.01

# 🔧  Herramientas: catálogo completo + auto‑aprobación
export JARVIS_TOOLS_FULL_CATALOG=1
export JARVIS_TOOLS_AUTO_APPROVE=1

# 2️⃣  Levanta Kokoro si no está vivo
if ! curl -sf "$VOICE_TTS_KOKORO_URL/salud" >/dev/null; then
  echo "🔊  Iniciando servidor Kokoro en $VOICE_TTS_KOKORO_URL ..."
  python scripts/kokoro-voice-server.py >/tmp/kokoro.log 2>&1 &
  KOKORO_PID=$!
  for i in {1..20}; do
    sleep 0.5
    curl -sf "$VOICE_TTS_KOKORO_URL/salud" >/dev/null && break
  done
  echo "✅  Kokoro listo (pid $KOKORO_PID)"
else
  echo "✅  Kokoro ya está corriendo"
fi

# 3️⃣  Compila solo si no existe la build
if [ ! -d "apps/server/dist" ] || [ ! -d "apps/web/dist" ]; then
  echo "🔨  Compilando servidor y cliente..."
  pnpm --filter @jarvis/server build
  pnpm --filter @jarvis/web build
fi

# 4️⃣  Arranca JARVIS (fastify + ws en :8787)
echo "🚀  Iniciando JARVIS en http://localhost:8787  (WS /ws)"
exec pnpm --filter @jarvis/server start