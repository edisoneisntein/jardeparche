/**
 * Reproducción del audio SINTETIZADO POR EL SERVIDOR con Handshake Atómico de Interrupción (P1).
 *
 * Invariantes de seguridad:
 * 1. Un segmento de audio NUNCA se reproduce si su serverEpoch < currentServerEpoch
 * 2. La interrupción del usuario inicia handshake: request -> ack (síncrono en cliente)
 * 3. AudioContext se desbloquea en el primer gesto de usuario (pointerdown/keydown)
 * 4. Cola de reproducción drena secuencialmente con backpressure implícito
 */

import { envelopeFromWav, publishVoiceSpectrum } from "./voiceSpectrum";
import type { ClientCommand } from "./events";

const PLAY_BLOQUEADO_MS = 1500;
const INTERRUPT_ACK_TIMEOUT_MS = 2000;

interface PendingSegment {
  url: string;
  text: string;
  serverEpoch: number;
}

let queue: PendingSegment[] = [];
let current: HTMLAudioElement | null = null;
let draining = false;
let interrupted = false;
/** Libera el `drain` pendiente cuando el audio en curso se corta. */
let releaseDrain: (() => void) | null = null;

/** Generación del cliente (monotónicamente creciente) */
let clientGeneration = 0;
/** Época del servidor confirmada como activa */
let currentServerEpoch = 0;
/** Época del servidor de la locución en reproducción */
let playingServerEpoch = 0;
/** Promesa de resolución del ACK de interrupción pendiente */
let pendingInterruptAck: { resolve: (value: { confirmedEpoch: number; newServerEpoch: number; flushedBytes: number }) => void; reject: (reason: Error) => void; timeout: ReturnType<typeof setTimeout> } | null = null;
/** Handler para audio bloqueado por autoplay */
let onBlocked: ((text: string) => void) | null = null;
/** AudioContext compartido para desbloqueo temprano */
let sharedAudioContext: AudioContext | null = null;
/** Flag de desbloqueo completado */
let audioUnlocked = false;

/** Obtiene o crea el AudioContext compartido */
function getSharedAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContext({ latencyHint: "interactive" });
  }
  return sharedAudioContext;
}

/** Desbloquea el AudioContext globalmente (llamar en primer gesto de usuario) */
export function unlockServerAudio(): void {
  if (audioUnlocked) return;
  const ctx = getSharedAudioContext();
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => undefined);
  }
  // Reproducir silencio de 1ms para desbloquear
  try {
    const audio = new Audio();
    audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";
    audio.volume = 0.01;
    void audio.play().catch(() => undefined);
    audioUnlocked = true;
  } catch {
    // Se intentará en el siguiente gesto
  }
}

/** Registra handler para primer gesto de usuario (pointerdown/keydown) */
let gestureHandlerAttached = false;
export function attachAudioUnlockGesture(): void {
  if (gestureHandlerAttached) return;
  const unlock = () => {
    unlockServerAudio();
    // Solo necesitamos el primer gesto
    document.removeEventListener("pointerdown", unlock, true);
    document.removeEventListener("keydown", unlock, true);
    gestureHandlerAttached = false;
  };
  document.addEventListener("pointerdown", unlock, { capture: true, once: true, passive: true });
  document.addEventListener("keydown", unlock, { capture: true, once: true, passive: true });
  gestureHandlerAttached = true;
}

export function setBlockedHandler(handler: ((text: string) => void) | null): void {
  onBlocked = handler;
}

function enqueue(url: string, text: string, serverEpoch: number): void {
  // Descartar segmentos de épocas obsoletas ANTES de encolar
  if (serverEpoch < currentServerEpoch) return;
  queue.push({ url, text, serverEpoch });
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  const next = queue.shift();
  if (!next) return;
  
  // Verificación de frescura: descartar si la época cambió mientras esperaba en cola
  if (next.serverEpoch < currentServerEpoch) {
    URL.revokeObjectURL(next.url);
    return void drain();
  }

  draining = true;
  interrupted = false;
  playingServerEpoch = next.serverEpoch;
  const audio = new Audio(next.url);
  current = audio;

  const resultado = await new Promise<"sono" | "bloqueado" | "error">((resolve) => {
    const fin = (valor: "sono" | "bloqueado" | "error") => {
      releaseDrain = null;
      resolve(valor);
    };
    let arrancado = false;
    const vigilante = setTimeout(() => {
      if (!arrancado) fin("bloqueado");
    }, PLAY_BLOQUEADO_MS);
    audio.addEventListener("ended", () => { clearTimeout(vigilante); fin("sono"); }, { once: true });
    audio.addEventListener("error", () => { clearTimeout(vigilante); fin("error"); }, { once: true });
    audio.play().then(
      () => { arrancado = true; },
      () => { clearTimeout(vigilante); fin("error"); },
    );
  });

  if (resultado === "bloqueado") {
    onBlocked?.(next.text);
  }
  // Verificar si la generación cambió durante la reproducción
  if (playingServerEpoch !== currentServerEpoch) {
    // Nueva locución activa: no continuar drenando esta cola
    current = null;
    draining = false;
    return;
  }
  current = null;
  draining = false;
  if (!interrupted) void drain();
}

function stopCurrent(): void {
  if (current) {
    current.pause();
    current.currentTime = 0;
    current.removeAttribute("src");
    current = null;
  }
  releaseDrain?.();
  releaseDrain = null;
}

/**
 * Inicia handshake atómico de interrupción (P1).
 * Envía voice.interrupt.request y espera voice.interrupt.ack.
 * Retorna la nueva época del servidor confirmada.
 */
export async function requestInterrupt(sessionId: string, sendCommand: (cmd: ClientCommand) => boolean): Promise<number> {
  // Incrementar generación del cliente
  clientGeneration += 1;
  const requestGeneration = clientGeneration;
  const requestServerEpoch = currentServerEpoch;

  // Crear promesa para esperar ACK
  let currentAck: { resolve: (value: { confirmedEpoch: number; newServerEpoch: number; flushedBytes: number }) => void; reject: (reason: Error) => void; timeout: ReturnType<typeof setTimeout> } | null = null;
  const ackPromise = new Promise<{ confirmedEpoch: number; newServerEpoch: number; flushedBytes: number }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingInterruptAck === currentAck) {
        pendingInterruptAck = null;
        reject(new Error("Interrupt ACK timeout"));
      }
    }, INTERRUPT_ACK_TIMEOUT_MS);
    currentAck = { resolve, reject, timeout };
    pendingInterruptAck = currentAck;
  });

  // Enviar request
  const sent = sendCommand({
    type: "voice.interrupt.request",
    sessionId,
    serverEpoch: requestServerEpoch,
    clientGeneration: requestGeneration,
    clientTimestamp: Date.now(),
  });

  if (!sent) {
    pendingInterruptAck = null;
    throw new Error("Failed to send interrupt request: connection closed");
  }

  try {
    const ack = await ackPromise;
    // Actualizar época del servidor confirmada
    currentServerEpoch = ack.newServerEpoch;
    return ack.newServerEpoch;
  } catch (error) {
    // En timeout o error, forzar avance de época local para no bloquear
    currentServerEpoch = requestServerEpoch + 1;
    throw error;
  }
}

/** Manejador interno para voice.interrupt.ack (llamado desde el event handler) */
export function handleInterruptAck(ack: { confirmedEpoch: number; newServerEpoch: number; flushedBytes: number }): void {
  if (pendingInterruptAck) {
    clearTimeout(pendingInterruptAck.timeout);
    pendingInterruptAck.resolve(ack);
    pendingInterruptAck = null;
  }
  // Actualizar época del servidor
  currentServerEpoch = ack.newServerEpoch;
}

/**
 * Corta la reproducción en curso y vacía la cola (interrupción del usuario).
 * Incluye handshake atómico con el servidor.
 */
export async function stopServerAudio(sessionId?: string, sendCommand?: (cmd: ClientCommand) => boolean): Promise<void> {
  // Handshake atómico: esperar ACK antes de limpiar estado local
  if (sessionId && sendCommand) {
    try {
      await requestInterrupt(sessionId, sendCommand);
    } catch {
      // Ignorar errores de handshake: forzar limpieza local
    }
  }
  // Limpieza local inmediata tras ACK (o timeout)
  clientGeneration += 1;
  interrupted = true;
  // Revocar URLs en cola para liberar memoria
  for (const segment of queue) {
    URL.revokeObjectURL(segment.url);
  }
  queue = [];
  stopCurrent();
  draining = false;
  playingServerEpoch = 0;
}

/**
 * Comienza una locución nueva: descarta lo que quedara de la anterior.
 * Incrementa época del servidor localmente (el servidor confirmará con ACK si hubo interrupción).
 */
export function resetServerAudio(_generationId?: string): void {
  clientGeneration += 1;
  interrupted = false;
  for (const segment of queue) {
    URL.revokeObjectURL(segment.url);
  }
  queue = [];
  stopCurrent();
  draining = false;
  // La época del servidor se sincronizará via voice.speaking.started.serverEpoch
  playingServerEpoch = 0;
}

/** Actualiza la época del servidor desde voice.speaking.started */
export function setServerEpoch(epoch: number): void {
  currentServerEpoch = epoch;
  playingServerEpoch = epoch;
}

/** ¿Pertenece este segmento a la época actual? */
export function isCurrentServerEpoch(serverEpoch: number): boolean {
  return serverEpoch >= currentServerEpoch;
}

export function isServerAudioPlaying(): boolean {
  return draining || queue.length > 0;
}

/**
 * Reproduce un segmento de audio recibido del servidor.
 * Valida serverEpoch antes de encolar.
 */
export function playServerSegment(base64: string, mimeType: string, _generationId: string | undefined, serverEpoch: number, text = ""): void {
  if (!isCurrentServerEpoch(serverEpoch)) return;
  const bytes = base64ToBytes(base64);
  if (bytes.length === 0) return;
  publishVoiceSpectrum(envelopeFromWav(bytes));
  const blob = new Blob([bytes], { type: mimeType || "audio/wav" });
  enqueue(URL.createObjectURL(blob), text, serverEpoch);
}

function base64ToBytes(base64: string): Uint8Array {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return new Uint8Array();
  }
}