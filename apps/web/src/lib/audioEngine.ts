/**
 * Single shared microphone pipeline.
 *
 * Opening getUserMedia more than once is wasteful and some browsers get grumpy
 * about several concurrent streams, so every consumer (dictation level meter,
 * voice visualizer) shares one analyser here. Activation is reference-counted:
 * the microphone only opens while at least one consumer retains it, and it is
 * released the moment the last one lets go.
 */

export interface AudioFrame {
  /** Root-mean-square loudness of the waveform, already scaled to 0..1. */
  level: number;
  /** Average magnitude across all frequency bins, 0..1. */
  energy: number;
  /** Spectral centroid normalised to 0..1 (brightness of the sound). */
  centroid: number;
  /** Raw frequency magnitudes, 0..255 per bin. */
  bands: Uint8Array;
  /** Time-domain samples in -1..1. */
  wave: Float32Array;
  /** Number of frequency bins currently available. */
  binCount: number;
}

const FFT_SIZE = 1024;
const SMOOTHING = 0.78;

const frame: AudioFrame = {
  level: 0,
  energy: 0,
  centroid: 0,
  bands: new Uint8Array(0),
  wave: new Float32Array(0),
  binCount: 0,
};

let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let stream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let frequency: Uint8Array | null = null;
let waveform: Float32Array | null = null;
let animationFrame = 0;
let retainCount = 0;
let starting: Promise<boolean> | null = null;

function tick(): void {
  if (!analyser || !frequency || !waveform) {
    animationFrame = 0;
    return;
  }

  analyser.getByteFrequencyData(frequency);
  analyser.getFloatTimeDomainData(waveform);

  let sumSquares = 0;
  for (let index = 0; index < waveform.length; index += 1) {
    const sample = waveform[index] ?? 0;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / waveform.length);

  let magnitudeSum = 0;
  let weightedSum = 0;
  for (let index = 0; index < frequency.length; index += 1) {
    const magnitude = frequency[index] ?? 0;
    magnitudeSum += magnitude;
    weightedSum += magnitude * index;
  }

  frame.level = Math.min(1, rms * 3.4);
  frame.energy = frequency.length > 0 ? Math.min(1, magnitudeSum / frequency.length / 140) : 0;
  frame.centroid = magnitudeSum > 0 ? weightedSum / magnitudeSum / frequency.length : 0;
  frame.bands = frequency;
  frame.wave = waveform;
  frame.binCount = frequency.length;

  animationFrame = requestAnimationFrame(tick);
}

async function start(): Promise<boolean> {
  if (context && analyser) return true;
  if (starting) return starting;

  starting = (async () => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext();
      const node = ctx.createAnalyser();
      node.fftSize = FFT_SIZE;
      node.smoothingTimeConstant = SMOOTHING;
      const source = ctx.createMediaStreamSource(media);
      source.connect(node);
      try {
        await ctx.resume();
      } catch {
        /* resume can fail if no gesture happened yet; the loop still runs silent */
      }

      stream = media;
      context = ctx;
      analyser = node;
      sourceNode = source;
      frequency = new Uint8Array(node.frequencyBinCount);
      waveform = new Float32Array(node.fftSize);
      if (!animationFrame) animationFrame = requestAnimationFrame(tick);
      return true;
    } catch {
      starting = null;
      return false;
    }
  })();

  return starting;
}

function stop(): void {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  sourceNode?.disconnect();
  sourceNode = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  if (context) void context.close();
  context = null;
  analyser = null;
  frequency = null;
  waveform = null;
  starting = null;
  frame.level = 0;
  frame.energy = 0;
  frame.centroid = 0;
  frame.bands = new Uint8Array(0);
  frame.wave = new Float32Array(0);
  frame.binCount = 0;
}

/** Keeps the microphone open; call the returned function to release it. */
export function retainAudio(): () => void {
  retainCount += 1;
  void start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainCount = Math.max(0, retainCount - 1);
    if (retainCount === 0) stop();
  };
}

/** True while the microphone pipeline is open. */
export function isAudioActive(): boolean {
  return analyser !== null;
}

/**
 * Latest analysed frame. The returned object is reused every frame, so read
 * what you need immediately instead of keeping a reference.
 */
export function getAudioFrame(): AudioFrame {
  return frame;
}
