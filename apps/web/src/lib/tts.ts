import { normalizeForSpeech } from "@jarvis/shared";
import { useJarvisStore } from "../state/jarvisStore";

export function isSpeechSynthesisAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function listVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSynthesisAvailable()) return [];
  return window.speechSynthesis.getVoices();
}

let activeGeneration: string | null = null;

/**
 * Limpia el texto antes de sintetizarlo.
 *
 * Quita el markdown y convierte las cifras, fechas y símbolos a su forma
 * hablada ("$1,500.50" → "mil quinientos dólares con cincuenta centavos").
 * Es la MISMA normalización que aplica el servidor antes de sintetizar: así
 * la voz de respaldo dice exactamente lo mismo que la del servidor.
 */
export function sanitizeForSpeech(input: string): string {
  return normalizeForSpeech(input);
}

/**
 * Corta SOLO la voz del navegador, sin tocar el audio del servidor.
 *
 * `cancelSpeech` sirve para interrumpir la locución entera (y por eso apaga
 * también el audio del servidor). Aquí hace falta lo contrario: cuando llega
 * audio del servidor hay que silenciar al navegador para que no se oigan dos
 * voces montadas una sobre otra, sin matar el fragmento que acaba de llegar.
 */
export function stopBrowserSpeech(): void {
  activeGeneration = null;
  if (isSpeechSynthesisAvailable()) {
    window.speechSynthesis.cancel();
  }
  useJarvisStore.getState().setTtsSpeaking(false);
}

export function cancelSpeech(): void {
  if (activeGeneration === null && !isSpeechSynthesisAvailable()) return;
  activeGeneration = null;
  // El audio del servidor también se corta: sin esto, la interrupción
  // dejaría sonando la respuesta anterior.
  void import("./serverAudio").then((module) => module.stopServerAudio()).catch(() => undefined);
  if (isSpeechSynthesisAvailable()) {
    window.speechSynthesis.cancel();
  }
  useJarvisStore.getState().setTtsSpeaking(false);
}

export function stopGeneration(generationId: string): void {
  if (activeGeneration === generationId) {
    cancelSpeech();
  }
}

/**
 * Dice UN fragmento con la voz del navegador, sin tocar el audio del servidor.
 *
 * Es el plan B cuando el navegador no deja reproducir el WAV del servidor
 * (política de reproducción automática): mejor una voz del navegador que
 * un silencio.
 */
export function speakFragment(input: {
  generationId: string;
  text: string;
  language: string;
  voiceURI: string;
}): void {
  if (!isSpeechSynthesisAvailable()) return;
  const text = sanitizeForSpeech(input.text);
  if (!text) return;
  // Solo se corta la voz del navegador: el audio del servidor puede estar
  // sonando y no se toca aquí.
  window.speechSynthesis.cancel();
  activeGeneration = input.generationId;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = input.language || "es-ES";
  if (input.voiceURI) {
    const voice = listVoices().find((item) => item.voiceURI === input.voiceURI);
    if (voice) utterance.voice = voice;
  }
  utterance.onstart = () => useJarvisStore.getState().setTtsSpeaking(true);
  const finish = () => useJarvisStore.getState().setTtsSpeaking(false);
  utterance.onend = finish;
  utterance.onerror = finish;
  window.speechSynthesis.speak(utterance);
}

export function speakGeneration(input: {
  generationId: string;
  text: string;
  language: string;
  voiceURI: string;
}): void {
  if (!isSpeechSynthesisAvailable()) return;
  const text = sanitizeForSpeech(input.text);
  if (!text) return;

  if (activeGeneration === input.generationId && window.speechSynthesis.speaking) return;

  cancelSpeech();

  activeGeneration = input.generationId;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = input.language || "es-ES";
  if (input.voiceURI) {
    const voice = listVoices().find((item) => item.voiceURI === input.voiceURI);
    if (voice) utterance.voice = voice;
  }

  utterance.onstart = () => {
    if (activeGeneration !== input.generationId) return;
    // El store alimenta el corte de eco: mientras hay voz, el micrófono se
    // silencia para no capturarla.
    useJarvisStore.getState().setTtsSpeaking(true);
  };

  const finish = () => {
    // El final de la locución debe liberar el estado de voz aunque la
    // generación ya haya cambiado: si no, el micrófono queda mudo para siempre.
    useJarvisStore.getState().setTtsSpeaking(false);
    if (activeGeneration !== input.generationId) return;
    activeGeneration = null;
  };

  utterance.onend = finish;
  utterance.onerror = finish;

  window.speechSynthesis.speak(utterance);
}
