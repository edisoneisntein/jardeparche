/**
 * Pitidos de interfaz ("tech beeps" del HUD).
 *
 * Se sintetizan con Web Audio (sin ficheros): un clic corto al empezar una
 * herramienta y un chirrido cuando llega la respuesta. Volumen muy bajo: son
 * un detalle, no una banda sonora.
 */

let contexto: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!contexto) contexto = new Ctor();
    if (contexto.state === "suspended") void contexto.resume();
    return contexto;
  } catch {
    return null;
  }
}

function tono(frecuencia: number, duracionMs: number, volumen: number, tipo: OscillatorType = "sine", retardoMs = 0): void {
  const ctx = audio();
  if (!ctx) return;
  const inicio = ctx.currentTime + retardoMs / 1000;
  const oscilador = ctx.createOscillator();
  const ganancia = ctx.createGain();
  oscilador.type = tipo;
  oscilador.frequency.setValueAtTime(frecuencia, inicio);
  ganancia.gain.setValueAtTime(0.0001, inicio);
  ganancia.gain.exponentialRampToValueAtTime(Math.max(0.0002, volumen), inicio + 0.012);
  ganancia.gain.exponentialRampToValueAtTime(0.0001, inicio + duracionMs / 1000);
  oscilador.connect(ganancia);
  ganancia.connect(ctx.destination);
  oscilador.start(inicio);
  oscilador.stop(inicio + duracionMs / 1000 + 0.02);
}

/** Pitido corto: la herramienta arranca. */
export function beepTool(): void {
  tono(1180, 45, 0.035, "triangle");
}

/** Chirrido de dos notas: llegó la respuesta. */
export function beepReply(): void {
  tono(880, 70, 0.045, "sine");
  tono(1320, 90, 0.035, "sine", 70);
}

/** Aviso: hace falta una acción del usuario. */
export function beepAttention(): void {
  tono(660, 90, 0.05, "square");
  tono(520, 110, 0.04, "square", 95);
}
