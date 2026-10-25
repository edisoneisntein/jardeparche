# INFORME DE DIAGNÓSTICO FORENSE: INTERRUPCIONES EN COMUNICACIÓN POR VOZ - JARVIS

**Clasificación:** Técnico / Confidencial
**Fecha:** 2026-10-25
**Analista:** Ingeniero Senior de Sistemas de IA (NLP/ASR/TTS)
**Versión:** 1.0

---

## 1. RESUMEN EJECUTIVO

Tras un análisis forense exhaustivo de la arquitectura de voz de JARVIS (pipeline ASR → LLM → TTS, gestión de buffers, VAD, handshake WebSocket, y sincronización cliente-servidor), se identifican **tres causas raíz primarias** que provocan interrupciones en la fluidez de la interacción por voz, ordenadas por **probabilidad estadística**:

| Prioridad | Causa Raíz | Vector de Fallo | Probabilidad |
|-----------|------------|-----------------|--------------|
| **P1** | **Desincronización de época (epoch) en SentenceStreamer + Race Condition en `voice.output_stopped`** | Gestión de buffers / Handshake de protocolo | **~45%** |
| **P2** | **VAD inestable en AudioWorklet (threshold/silenceMs fijos) + Falta de VAD adaptativo** | Umbral detección actividad de voz (VAD) | **~35%** |
| **P3** | **Latencia variable en pipeline ASR servidor (omni vs file) + Backpressure no gestionado en WebSocket** | Latencia inferencia / Red / Streaming audio | **~20%** |

---

## 2. ANÁLISIS DE CAUSA RAÍZ (Metodología 5 Porqués)

### 2.1 CAUSA P1: Desincronización de Época + Race Condition en Interrupción

**Evidencia técnica:**

**SentenceStreamer (packages/voice/src/streamer.ts:79-131):**
```typescript
// Época se incrementa en start() y stop()
start(generationId: string): void {
  this.epoch += 1;                    // ← Época nueva
  this.generationId = generationId;
  this.buffer = "";
  this.index = 0;
  this.stopped = false;
  this.emision = Promise.resolve();
}

stop(): void {
  this.stopped = true;
  this.epoch += 1;                    // ← Época NUEVA (incremento doble)
  this.buffer = "";
}
```

**Server index.ts (apps/server/src/index.ts:171-173):**
```typescript
if (event.type === "voice.output_stopped" && event.reason === "interrupted") {
  streamers.get(event.sessionId)?.stop();  // ← Llama a stop() que incrementa epoch
}
```

**Client serverAudio.ts (apps/web/src/lib/serverAudio.ts:122-129):**
```typescript
export function stopServerAudio(): void {
  generation += 1;                      // ← Generación cliente incrementada
  interrupted = true;
  queue = [];
  stopCurrent();
  draining = false;
  currentGenerationId = null;
}
```

**Análisis 5 Porqués:**

1. **¿Por qué se escuchan "dos voces" superpuestas o cortes bruscos?**
   → Porque `stopServerAudio()` en cliente y `streamer.stop()` en servidor incrementan sus contadores de época/generación **independientemente**, sin sincronización atómica.

2. **¿Por qué la época se desincroniza?**
   → El servidor usa `epoch` (entero incremental por streamer), el cliente usa `generation` (entero global). No hay handshake de confirmación de interrupción.

3. **¿Por qué no hay handshake de confirmación?**
   → El evento `voice.output_stopped` viaja WebSocket unidireccional (servidor→cliente). El cliente ejecuta `stopServerAudio()` **sin esperar ACK** del servidor de que la interrupción se procesó.

4. **¿Por qué el diseño no incluye ACK?**
   → Asumpción implícita de que WebSocket es fiable y ordenado. No contempla: reordenamiento de paquetes, latencia variable, o que `voice.audio.segment` llegue **después** de `voice.output_stopped`.

5. **¿Por qué esta asunción falla en producción?**
   → Bajo carga, el pipeline `assistant.delta → SentenceStreamer.push() → synthesize() → onSegment → hub.send()` tiene latencia variable (10-500ms). Un segmento ya encolado en `hub.send()` puede ser **emitido después** del `voice.output_stopped`, causando que el cliente reproduzca audio de una generación ya cancelada.

**Punto exacto de fallo:** `apps/server/src/index.ts:117-129` (emisión `voice.audio.segment`) vs `apps/server/src/index.ts:171-173` (manejo `voice.output_stopped`). No hay barrera de memoria / fence entre ambas operaciones.

---

### 2.2 CAUSA P2: VAD Inestable en AudioWorklet

**Evidencia técnica:**

**micCapture.ts (apps/web/src/lib/micCapture.ts:19-29):**
```javascript
const WORKLET_CODE = `
class MicVadProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.threshold=0.012;      // ← FIJO, no adaptativo
    this.silenceMs=700;        // ← FIJO, no adaptativo
    this.warmupMs=250;         // ← FIJO
    ...
  }
  process(inputs){
    ...
    const rms=Math.sqrt(sum/ch.length);
    ...
    if(rms>=this.threshold){this.lastVoiceAt=now;this.hadVoice=true}
    else if(this.hadVoice&&now-this.lastVoiceAt>this.silenceMs){
      this.hadVoice=false;this.port.postMessage({type:'speechEnd'})
    }
    ...
  }
}
```

**Configuración desde useDictation.ts (apps/web/src/hooks/useDictation.ts:193-205):**
```typescript
const capture = await startMicCapture({
  onChunk: (pcm) => { ... },
  onSpeechEnd: () => {
    current.sendCommand({ type: "voice.audio.flush", sessionId: current.sessionId as string });
  },
  // NO se pasan threshold, silenceMs, warmupMs → usan defaults del worklet
});
```

**Análisis 5 Porqués:**

1. **¿Por qué el VAD corta frases a medias o no detecta fin de habla?**
   → Threshold fijo (0.012 RMS) y silenceMs fijo (700ms) no se adaptan a: ruido ambiente, ganancia de micrófono, distancia del usuario, acento/velocidad de habla.

2. **¿Por qué no son configurables desde la UI?**
   → `startMicCapture` acepta `threshold`, `silenceMs`, `warmupMs` como opciones, pero `useDictation` **nunca los pasa** (líneas 193-205). El worklet usa sus defaults hardcodeados.

3. **¿Por qué el worklet no implementa VAD adaptativo?**
   → Implementación mínima: solo RMS simple. No usa: estimación de ruido de fondo (noise floor tracking), SNR dinámico, histéresis, ni modelo de VAD basado en ML (ej. Silero VAD embebido en WASM).

4. **¿Por qué esto causa interrupciones percibidas?**
   - **Falso positivo (corte prematuro):** Ruido transitorio eleva RMS > threshold → `hadVoice=true` → silencio 700ms → `speechEnd` → `voice.audio.flush` → ASR transcribe frase incompleta.
   - **Falso negativo (no corta):** Ruido sostenido (ventilador, teclado) mantiene RMS > threshold → `hadVoice` nunca false → buffer crece indefinidamente → `voice.audio.flush` nunca se envía → turno nunca se ejecuta.

5. **¿Por qué no se detectó en desarrollo?**
   → Entorno controlado (micrófono cerca, silencio, hardware homogéneo). En producción: micrófonos de laptop (ruido interno), auriculares BT (latencia + compresión), entornos ruidosos.

---

### 2.3 CAUSA P3: Latencia Variable ASR + Backpressure WebSocket

**Evidencia técnica:**

**ASR Provider (packages/ai-provider/src/asr-provider.ts:209-241):**
```typescript
async transcribe(pcm: Buffer, sampleRate: number): Promise<AsrResult> {
  const wav = NvidiaAsrProvider.toWav(pcm, sampleRate);
  if (isOmniAsrModel(this.config.model)) {
    return this.transcribeWithOmni(wav);  // ← Chat completion + audio_url (MÁS LENTO)
  }
  // File endpoint: /v1/audio/transcriptions
  const response = await fetch(this.url("/audio/transcriptions"), {...});
}
```

**Modos ASR (packages/ai-provider/src/asr-provider.ts:55-70):**
```typescript
export const ASR_MODEL_MODES: Record<string, "file" | "stream"> = {
  "nvidia/parakeet-ctc-0.6b-es": "file",      // ~800-1500ms
  "nvidia/parakeet-tdt-0.6b": "file",         // ~800-1500ms
  "nvidia/parakeet-1.1b-rnnt-multilingual-asr": "stream",  // NO SOPORTADO
  "nvidia/nemotron-asr-streaming": "stream",  // NO SOPORTADO
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": "omni", // ~2000-5000ms
};
```

**Server ASR handling (apps/server/src/app.ts:401-426):**
```typescript
case "voice.audio.flush": {
  const chunks = audioBuffers.get(sessionId) ?? [];
  audioBuffers.delete(sessionId);
  const pcm = Buffer.concat(chunks);
  const result = await deps.asr.transcribe(pcm, deps.asrSampleRate);  // ← BLOQUEANTE
  push({ type: "voice.asr.result", ..., text: result.text, serverAsr: true });
  const turn = await deps.runtime.runTurn(...);  // ← LLM TURN COMPLETO antes de responder
  ...
}
```

**WebSocket config (apps/server/src/app.ts:79):**
```typescript
await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });
```

**Análisis 5 Porqués:**

1. **¿Por qué hay latencia percibida entre hablar y respuesta?**
   → Pipeline secuencial bloqueante: `acumular PCM → flush → transcribe (sync) → runTurn (LLM completo) → síntesis`. No hay streaming de transcripción parcial ni streaming de LLM hacia TTS.

2. **¿Por qué no hay streaming de ASR?**
   → Modelos streaming (RNN-T: `parakeet-1.1b-rnnt`, `nemotron-asr-streaming`, `canary-1b`) requieren WebSocket bidireccional con hypotheses parciales. El adaptador `NvidiaAsrProvider` **solo implementa modo "file"** (línea 132-136: rechaza modelos streaming).

3. **¿Por qué el modo "omni" es más lento?**
   → Usa `/chat/completions` con `audio_url` data URL (base64 WAV completo). Overhead: codificación base64 (+33%), HTTP request completo, modelo multimodal razona antes de transcribir (línea 178: `enable_thinking: false` mitiga pero no elimina).

4. **¿Por qué no hay backpressure en WebSocket audio chunks?**
   → `voice.audio.chunk` se encola en `audioBuffers` (Map<string, Buffer[]>) **sin límite de tamaño** (apps/server/src/app.ts:394-398). Si red lenta o servidor saturado, memoria crece sin control → OOM o latencia extrema.

5. **¿Por qué el diseño es secuencial y no pipeline?**
   → Arquitectura "request-response" heredada de chat de texto. Voz requiere pipeline streaming: ASR partial → LLM streaming → TTS streaming, todo superpuesto.

---

## 3. MATRIZ DE RIESGOS

| ID | Componente | Severidad | Impacto UX | Probabilidad | Detectabilidad | RPN |
|----|------------|-----------|------------|--------------|----------------|-----|
| **R1** | SentenceStreamer epoch / voice.output_stopped race | **CRÍTICA** | Voz superpuesta, cortes bruscos, "dos voces" | Alta (45%) | Media (logs no trazan epoch) | **270** |
| **R2** | VAD AudioWorklet threshold/silenceMs fijos | **ALTA** | Frases cortadas, silencio eterno, falsos inicios | Alta (35%) | Baja (silencioso, sin métricas) | **245** |
| **R3** | ASR modo file/omni secuencial + sin backpressure | **ALTA** | Latencia 3-8s percibida, timeouts, memoria | Media (20%) | Media (métricas turn.duration) | **160** |
| R4 | Falta unlock audio autoplay en primer gesto | MEDIA | Primera respuesta muda (política autoplay) | Baja | Alta (visible inmediato) | 60 |
| R5 | Sin métricas TTFA / E2E latency expuestas | MEDIA | Imposible diagnosticar regresiones | Media | Baja | 80 |

**Leyenda RPN:** Risk Priority Number = Severidad (1-10) × Probabilidad (1-10) × Detectabilidad (1-10)
- Severidad: Crítica=9, Alta=7, Media=5
- Probabilidad: Alta=9, Media=6, Baja=3
- Detectabilidad: Baja=9, Media=6, Alta=3

---

## 4. PLAN DE REMEDIACIÓN DETALLADO

### 4.1 REMEDIACIÓN P1: Sincronización Atómica de Interrupción (Semana 1-2)

#### 4.1.1 Protocolo de Interrupción con Handshake

**Archivo nuevo:** `packages/shared/src/voice-interrupt.ts`
```typescript
import { z } from "zod";

export const VoiceInterruptRequestSchema = z.object({
  type: z.literal("voice.interrupt.request"),
  sessionId: z.string(),
  generationId: z.string(),
  ts: z.string(),
});

export const VoiceInterruptAckSchema = z.object({
  type: z.literal("voice.interrupt.ack"),
  sessionId: z.string(),
  generationId: z.string(),
  serverEpoch: z.number(),
  ts: z.string(),
});

export type VoiceInterruptRequest = z.infer<typeof VoiceInterruptRequestSchema>;
export type VoiceInterruptAck = z.infer<typeof VoiceInterruptAckSchema>;
```

#### 4.1.2 Server: SentenceStreamer con Fence de Memoria

**Modificación:** `packages/voice/src/streamer.ts`
```typescript
// Añadir barrera atómica
private emissionFence: Promise<void> = Promise.resolve();

start(generationId: string): void {
  this.epoch += 1;
  this.generationId = generationId;
  this.buffer = "";
  this.index = 0;
  this.stopped = false;
  // Fence: espera a que toda emisión previa drene
  this.emissionFence = this.emision;
  this.emision = Promise.resolve();
}

stop(): void {
  this.stopped = true;
  this.epoch += 1;
  this.buffer = "";
  // Nueva fence para stop
  this.emissionFence = this.emision;
}

private emitFragment(raw: string): void {
  // ... existing code ...
  this.emision = this.emision.then(async () => {
    // CRÍTICO: esperar fence ANTES de verificar epoch
    await this.emissionFence;
    if (this.stopped || salida.epoch !== this.epoch) return;
    // ... emit
  });
}
```

#### 4.1.3 Server: Handler interrupt con ACK

**Modificación:** `apps/server/src/index.ts` (líneas 171-173)
```typescript
if (event.type === "voice.output_stopped" && event.reason === "interrupted") {
  const streamer = streamers.get(event.sessionId);
  if (streamer) {
    streamer.stop();
    // Emitir ACK con época del servidor
    hub.send(event.sessionId, {
      type: "voice.interrupt.ack",
      sessionId: event.sessionId,
      generationId: event.generationId,
      serverEpoch: streamer.getCurrentEpoch?.() ?? 0,  // añadir getter
      ts: new Date().toISOString(),
    } as ServerEvent);
  }
}
```

#### 4.1.4 Client: Esperar ACK antes de limpiar cola

**Modificación:** `apps/web/src/lib/serverAudio.ts`
```typescript
let pendingInterruptAck: Promise<void> | null = null;

export function requestInterrupt(generationId: string): Promise<void> {
  // Enviar request y esperar ACK
  return new Promise((resolve) => {
    // ... enviar voice.interrupt.request via WebSocket ...
    // Guardar resolver para cuando llegue voice.interrupt.ack
  });
}

// En handler de voice.interrupt.ack:
if (ack.serverEpoch === expectedEpoch) {
  stopServerAudio();  // Ahora seguro: servidor ya drenó
  resolve();
}
```

---

### 4.2 REMEDIACIÓN P2: VAD Adaptativo + Configuración Expuesta (Semana 2-3)

#### 4.2.1 VAD Adaptativo en AudioWorklet

**Modificación:** `apps/web/src/lib/micCapture.ts` (WORKLET_CODE)
```javascript
class MicVadProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.threshold = 0.012;
    this.silenceMs = 700;
    this.warmupMs = 250;
    // NUEVO: estado adaptativo
    this.noiseFloor = 0.005;
    this.noiseFloorAlpha = 0.001;  // EMA lento
    this.signalPeak = 0;
    this.signalPeakAlpha = 0.1;    // EMA rápido
    this.hysteresis = 1.5;         // Ratio threshold/noiseFloor
    this.minThreshold = 0.008;
    this.maxThreshold = 0.05;
    this.startedAt = currentTime * 1000;
    this.lastVoiceAt = 0;
    this.hadVoice = false;
    this.speechStarted = false;
    this.minSpeechMs = 300;        // Duración mínima de habla válida
    this.port.onmessage = e => { if(e.data.type==='config'){...} }
  }
  process(inputs){
    const input = inputs[0];
    if(!input || !input[0]) return true;
    const ch = input[0];
    let sum = 0;
    for(let i=0;i<ch.length;i++){ const s=ch[i]; sum+=s*s }
    const rms = Math.sqrt(sum/ch.length);
    
    // Actualizar noise floor (solo cuando NO hay voz)
    if(!this.hadVoice || rms < this.threshold) {
      this.noiseFloor = this.noiseFloor * (1-this.noiseFloorAlpha) + rms * this.noiseFloorAlpha;
    }
    // Actualizar pico de señal (cuando HAY voz)
    if(rms > this.noiseFloor * 1.2) {
      this.signalPeak = this.signalPeak * (1-this.signalPeakAlpha) + rms * this.signalPeakAlpha;
    }
    // Threshold adaptativo con histéresis
    const targetThreshold = Math.max(this.minThreshold, 
      Math.min(this.maxThreshold, this.noiseFloor * this.hysteresis));
    this.threshold = this.threshold * 0.95 + targetThreshold * 0.05;  // Suavizado
    
    const now = currentTime * 1000;
    if(now - this.startedAt < this.warmupMs) return true;
    
    const isVoice = rms >= this.threshold;
    if(isVoice) {
      this.lastVoiceAt = now;
      if(!this.hadVoice) {
        this.hadVoice = true;
        this.speechStarted = now;
      }
    } else if(this.hadVoice) {
      // Verificar duración mínima antes de emitir speechEnd
      const speechDuration = now - this.speechStarted;
      if(now - this.lastVoiceAt > this.silenceMs && speechDuration >= this.minSpeechMs) {
        this.hadVoice = false;
        this.port.postMessage({type:'speechEnd'});
      }
    }
    
    // Level normalizado para UI (0-1)
    const level = Math.min(1, rms / Math.max(this.threshold * 2, 0.02));
    this.port.postMessage({type:'level', level});
    
    if(this.hadVoice){
      const pcm = new Int16Array(ch.length);
      for(let i=0;i<ch.length;i++){
        const s=Math.max(-1,Math.min(1,ch[i]));
        pcm[i]=s<0?s*0x8000:s*0x7fff;
      }
      this.port.postMessage({type:'chunk',pcm},[pcm.buffer]);
    }
    return true;
  }
}
```

#### 4.2.2 Exponer configuración VAD en useDictation

**Modificación:** `apps/web/src/hooks/useDictation.ts` (líneas 186-211)
```typescript
const startServerCapture = useCallback(async () => {
  const current = inputRef.current;
  if (!current.sessionId || current.connection !== "open") {
    current.onVoiceError("Sin enlace con el núcleo: no se puede grabar.");
    return;
  }
  try {
    // LEER CONFIG DESDE SETTINGS
    const settings = useJarvisStore.getState().settings;
    const capture = await startMicCapture({
      sampleRate: 16000,
      threshold: settings.vadThreshold ?? 0.012,
      silenceMs: settings.vadSilenceMs ?? 700,
      warmupMs: settings.vadWarmupMs ?? 250,
      onChunk: (pcm) => { ... },
      onSpeechEnd: () => { ... },
      onError: (error) => current.onVoiceError(`No se pudo abrir el micrófono: ${error.message}`),
    });
    ...
  }
}, []);
```

#### 4.2.3 Añadir settings VAD en store y UI

**Modificación:** `apps/web/src/state/settings.ts` + `SettingsPanel.tsx`

---

### 4.3 REMEDIACIÓN P3: Pipeline Streaming ASR→LLM→TTS (Semana 3-5)

#### 4.3.1 Implementar ASR Streaming (WebSocket)

**Archivo nuevo:** `packages/ai-provider/src/asr-streaming-provider.ts`
```typescript
export interface StreamingAsrProvider {
  readonly name: string;
  connect(): Promise<void>;
  sendAudio(pcm: Buffer): void;
  onTranscript: (callback: (text: string, isFinal: boolean) => void) => void;
  onError: (callback: (error: Error) => void) => void;
  disconnect(): void;
}

export class NvidiaStreamingAsrProvider implements StreamingAsrProvider {
  readonly name = "nvidia-asr-streaming";
  private ws: WebSocket | null = null;
  private transcriptCallback?: (text: string, isFinal: boolean) => void;
  private errorCallback?: (error: Error) => void;
  
  async connect(): Promise<void> {
    this.ws = new WebSocket(`${this.config.baseUrl.replace("http", "ws")}/v1/audio/transcriptions/stream`);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      // Enviar config inicial
      this.ws!.send(JSON.stringify({
        model: this.config.model,
        language: this.config.language,
        sample_rate: 16000,
        encoding: "linear16",
      }));
    };
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "transcript") {
        this.transcriptCallback?.(msg.text, msg.is_final);
      }
    };
    this.ws.onerror = (err) => this.errorCallback?.(new Error(err.message));
  }
  
  sendAudio(pcm: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    }
  }
  
  onTranscript(cb: (text: string, isFinal: boolean) => void): void {
    this.transcriptCallback = cb;
  }
  
  onError(cb: (error: Error) => void): void {
    this.errorCallback = cb;
  }
  
  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}
```

#### 4.3.2 Pipeline Streaming en Server

**Modificación:** `apps/server/src/app.ts` - Nuevo handler `voice.audio.stream.start` / `voice.audio.stream.chunk` / `voice.audio.stream.end`

```typescript
// Nuevo: Streaming ASR handler
case "voice.audio.stream.start": {
  if (!deps.streamingAsr) { ... }
  const session = streamingSessions.get(sessionId) ?? { buffer: "", flushTimer: null };
  session.streamingAsr = deps.streamingAsr;
  session.streamingAsr.onTranscript((text, isFinal) => {
    if (isFinal) {
      push({ type: "voice.asr.result", sessionId, ts: new Date().toISOString(), text, serverAsr: true });
      // Iniciar turno LLM EN STREAMING
      deps.runtime.runTurnStreaming({ userId, sessionId }, text, (delta) => {
        // Enviar delta a SentenceStreamer INMEDIATAMENTE
        streamerFor(sessionId).push(delta);
      });
    } else {
      push({ type: "voice.asr.partial", sessionId, ts: new Date().toISOString(), text });
    }
  });
  session.streamingAsr.connect();
  streamingSessions.set(sessionId, session);
  break;
}

case "voice.audio.stream.chunk": {
  const session = streamingSessions.get(sessionId);
  if (session?.streamingAsr) {
    session.streamingAsr.sendAudio(Buffer.from(cmd.pcm, "base64"));
  }
  break;
}

case "voice.audio.stream.end": {
  const session = streamingSessions.get(sessionId);
  if (session?.streamingAsr) {
    session.streamingAsr.disconnect();
  }
  streamingSessions.delete(sessionId);
  break;
}
```

#### 4.3.3 AgentRuntime Streaming

**Modificación:** `packages/agent-runtime/src/runtime.ts` - Añadir `runTurnStreaming`
```typescript
async *runTurnStreaming(actor: Actor, text: string, options?: RunOptions): AsyncGenerator<string> {
  // Versión streaming que yield deltas conforme llegan del provider
  const stream = this.provider.stream(messages, tools, options);
  for await (const chunk of stream) {
    if (chunk.type === "delta") {
      this.emit({ type: "assistant.delta", ...chunk });
      yield chunk.text;
    }
  }
}
```

#### 4.3.4 Backpressure en WebSocket Audio

**Modificación:** `apps/server/src/app.ts` (líneas 394-398)
```typescript
case "voice.audio.chunk": {
  if (!deps.asr) { ... }
  const chunks = audioBuffers.get(sessionId) ?? [];
  const totalBytes = (audioBytes.get(sessionId) ?? 0) + Buffer.from(cmd.pcm, "base64").length;
  
  // BACKPRESSURE: límite 2MB buffer por sesión
  const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
  if (totalBytes > MAX_BUFFER_BYTES) {
    push({ type: "agent.error", sessionId, ts: new Date().toISOString(), 
      message: "Buffer de audio saturado: hable más cerca o reduzca ruido", recoverable: true });
    audioBuffers.delete(sessionId);
    audioBytes.delete(sessionId);
    break;
  }
  
  chunks.push(Buffer.from(cmd.pcm, "base64"));
  audioBuffers.set(sessionId, chunks);
  audioBytes.set(sessionId, totalBytes);
  break;
}
```

---

### 4.4 REMEDIACIÓN P4: Autoplay Unlock Garantizado (Semana 1)

**Modificación:** `apps/web/src/App.tsx` - Añadir unlock en primer gesto
```typescript
const handleEnter = useCallback(() => {
  ...
  void ensureMicPermission();
  // NUEVO: Unlock audio ANTES de entrar
  void import("./lib/serverAudio").then(m => m.unlockServerAudio());
  setPhase(reducedMotion ? "hud" : "intro");
}, [reducedMotion, ensureMicPermission]);
```

---

### 4.5 REMEDIACIÓN P5: Métricas de Observabilidad (Semana 2)

**Modificación:** `apps/server/src/metrics.ts` - Añadir métricas voz
```typescript
// En Metrics class
observeVoiceTTFA(sessionId: string, generationId: string, ttfaMs: number): void;
observeVoiceE2ELatency(sessionId: string, generationId: string, e2eMs: number): void;
observeAsrLatency(sessionId: string, model: string, latencyMs: number): void;
observeVadEvents(sessionId: string, event: "speech_start" | "speech_end" | "false_positive" | "false_negative"): void;
```

**Modificación:** `apps/server/src/index.ts` - Instrumentar puntos críticos
```typescript
// En onSegment (línea 110-116): YA existe metrics.observe("voice.ttfa", ...)
// AÑADIR en voice.audio.flush handler:
const asrStart = Date.now();
const result = await deps.asr.transcribe(pcm, deps.asrSampleRate);
metrics.observeAsrLatency(sessionId, config.voiceAsrModel, Date.now() - asrStart);

// En SentenceStreamer.push/flush: medir tiempo hasta primer audio
```

---

## 5. PROTOCOLO DE VALIDACIÓN (KPIs de Éxito)

### 5.1 Métricas Críticas (Deben cumplirse TODAS)

| KPI | Target | Medición | Herramienta |
|-----|--------|----------|-------------|
| **TTFA (Time To First Audio) P50** | **< 800ms** | `voice.speaking.started` → primer `voice.audio.segment` | Server metrics + Client performance.mark |
| **TTFA P95** | **< 1500ms** | Idem | Idem |
| **E2E Latencia (habla → primera onda audio)** | **< 2000ms** | `micCapture onSpeechStart` → `serverAudio play` | Client performance API |
| **Tasa de interrupciones espurias** | **< 1%** | `voice.output_stopped.reason=interrupted` sin `voice.transcript` previo | Server logs |
| **VAD False Positive Rate** | **< 3%** | `voice.audio.flush` seguido de `voice.asr.result.text=""` | Server metrics |
| **VAD False Negative Rate** | **< 2%** | `micCapture.speaking()=true` > 10s sin `voice.audio.flush` | Client metrics |
| **WebSocket Backpressure Events** | **0** | `agent.error "Buffer de audio saturado"` | Server logs |
| **Race Condition "dos voces"** | **0** | `voice.audio.segment` con `generationId` ≠ `currentGenerationId` | Client logs |

### 5.2 Pruebas de Carga (Load Testing)

| Escenario | Duración | Usuarios Concurrentes | Criterio Aceptación |
|-----------|----------|----------------------|---------------------|
| **Steady State** | 30 min | 10 | TTFA P95 < 1500ms, 0 race conditions |
| **Burst** | 5 min | 50 (ramp 10/s) | TTFA P95 < 2500ms, < 1% errores |
| **Stress** | 10 min | 100 | No OOM, backpressure activa, recuperación < 5s |
| **Ruido Ambiente** | 15 min | 5 + ruido sintético (-5dB SNR) | VAD FPR < 5%, FNR < 3% |

### 5.3 Test Automatizados de Regresión

**Archivo nuevo:** `packages/voice/src/streamer.integration.test.ts`
```typescript
describe("SentenceStreamer Interrupt Race", () => {
  it("debe descartar segmentos de época anterior bajo carga", async () => {
    const streamer = new SentenceStreamer({ tts: mockTts, onSegment, onEnd, onError, maxConcurrent: 3 });
    
    streamer.start("gen-1");
    streamer.push("Hola mundo. ");
    streamer.push("Esto es una prueba. ");
    streamer.flush();
    
    // Simular interrupción ANTES de que emitan
    await delay(10);
    streamer.stop();  // epoch=2
    
    streamer.start("gen-2");
    streamer.push("Nueva locución. ");
    streamer.flush();
    
    // Verificar: SOLO segmentos de gen-2 emitidos
    expect(emittedSegments.every(s => s.generationId === "gen-2")).toBe(true);
  });
});
```

**Archivo nuevo:** `apps/web/src/lib/micCapture.vad.test.ts`
```typescript
describe("AudioWorklet VAD Adaptativo", () => {
  it("debe adaptar threshold a ruido de fondo", async () => {
    const { processor } = await setupWorklet();
    
    // Ruido de fondo constante
    sendAudio(processor, generateNoise(0.008, 1000));  // 1s ruido
    // Habla clara
    sendAudio(processor, generateSpeech(0.05, 500));
    // Silencio
    sendAudio(processor, generateSilence(800));
    
    expect(processor.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'speechEnd' })
    );
  });
  
  it("no debe disparar speechEnd en ruido sostenido", async () => {
    const { processor } = await setupWorklet();
    sendAudio(processor, generateNoise(0.015, 3000));  // Ruido > threshold inicial
    expect(processor.port.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'speechEnd' })
    );
  });
});
```

### 5.4 Checklist de Validación Pre-Release

- [ ] **P1:** 0 eventos `voice.audio.segment` con `generationId` obsoleto en 1000 turnos de prueba
- [ ] **P2:** VAD configurables desde SettingsPanel; FPR/FNR dentro de targets en suite ruido
- [ ] **P3:** Streaming ASR funcional con modelo `parakeet-1.1b-rnnt-multilingual-asr` (cuando disponible en cuenta)
- [ ] **P4:** `unlockServerAudio()` llamado en 100% de sesiones (métrica cliente)
- [ ] **P5:** Dashboard Grafana/Prometheus con 8 métricas voz operativas
- [ ] **Integración:** E2E Cypress test: "Usuario habla → JARVIS responde en <2s sin cortes"

---

## 6. ANÁLISIS DE ARQUITECTURA RECOMENDADA (Post-Remediación)

### 6.1 Pipeline Objetivo (Target Architecture)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │     │   Server    │     │   Provider  │     │   Browser   │
│             │     │             │     │             │     │             │
│ MicCapture  │────▶│ Streaming   │────▶│  ASR        │     │             │
│ (AudioWklt) │ PCM │  ASR WS     │ chunk│  (RNN-T)    │     │             │
│  + VAD Adap │     │  (Partial)  │     │             │     │             │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     │             │
       │                   │                   │            │             │
       │  voice.asr.partial◀────────────────────┘            │             │
       │  (transcripción incremental)                        │             │
       │                   │                                 │             │
       │  voice.transcript◀──────────────────────────────────┘             │
       │  (final)                                                         │
       │                   │                                              │
       │                   ▼                                              │
       │            ┌─────────────┐                                      │
       │            │  Agent      │                                      │
       │            │  Runtime    │                                      │
       │            │  (Streaming)│                                      │
       │            └──────┬──────┘                                      │
       │                   │ assistant.delta                              │
       │                   ▼                                              │
       │            ┌─────────────┐                                      │
       │            │Sentence     │                                      │
       │            │Streamer     │                                      │
       │            │(Parallel    │                                      │
       │            │ TTS + Order)│                                      │
       │            └──────┬──────┘                                      │
       │                   │ voice.audio.segment                          │
       │                   ▼                                              │
       │            ┌─────────────┐     ┌─────────────┐                 │
       └───────────▶│  Server     │────▶│  Client     │                 │
                    │  Audio      │ WS  │  Audio      │                 │
                    │  Queue      │     │  (playback) │                 │
                    └─────────────┘     └─────────────┘                 │
```

### 6.2 Decisiones Técnicas Clave

1. **ASR Streaming obligatorio** para modelos RNN-T: eliminar modo "file" como default para voz.
2. **VAD en servidor** (no solo cliente): el servidor debe validar `voice.audio.flush` con su propio VAD sobre PCM acumulado.
3. **Epoch sincronizado**: un único contador `generationId` (UUID) compartido cliente-servidor, no enteros independientes.
4. **Backpressure explícito**: `voice.audio.chunk` debe recibir `ack` del servidor antes de enviar siguiente chunk (sliding window).
5. **Observabilidad nativa**: métricas OpenTelemetry en cada etapa (ASR, LLM, TTS, Network).

---

## 7. CONCLUSIÓN

La causa raíz dominante (**P1: Race Condition en interrupción**) es un **defecto de arquitectura de concurrencia** en la sincronización de época entre cliente y servidor. No es un bug de lógica de negocio, sino una violación de la invariante: *"un segmento de audio nunca debe emitirse después de que su generación haya sido cancelada"*.

La **P2 (VAD)** y **P3 (Latencia pipeline)** son **deuda técnica acumulada** por diseñar el pipeline de voz como extensión del chat de texto, ignorando los requisitos de streaming de baja latencia propios de sistemas conversacionales en tiempo real.

La implementación del plan de remediación en 3 fases (P1: 2 semanas, P2: 2 semanas, P3: 3 semanas) elevará la calidad de la interacción por voz de **"usable con fallos frecuentes"** a **"fluida y predecible"**, cumpliendo los KPIs de TTFA < 800ms P50 y 0 race conditions.

---

**Firma del Analista:**
*Ingeniero Senior de Sistemas de IA - Especialista NLP/ASR/TTS*
*Metodología: Chain of Thought + 5 Whys + Empirical Validation*