/**
 * Espectro de la voz de JARVIS.
 *
 * El servidor manda el audio ya sintetizado en PCM (WAV 16 bits). Aquí se
 * calcula el **envolvente de amplitud** directamente de los bytes: no hace
 * falta Web Audio (que dependería del contexto y del gesto de usuario) ni
 * inventar una señal: son las muestras reales de la voz.
 */

const BARRAS = 84;

type Escucha = (barras: Float32Array) => void;

let actual = new Float32Array(BARRAS);
const escuchas = new Set<Escucha>();

/** Publica el envolvente recién calculado. */
export function publishVoiceSpectrum(barras: Float32Array): void {
  actual = barras;
  for (const escucha of escuchas) escucha(barras);
}

/** Se suscribe al envolvente; devuelve la función para cancelar. */
export function subscribeVoiceSpectrum(escucha: Escucha): () => void {
  escuchas.add(escucha);
  escucha(actual);
  return () => {
    escuchas.delete(escucha);
  };
}

export function voiceSpectrum(): Float32Array {
  return actual;
}

/** Localiza el chunk de datos de un WAV PCM 16 bits. */
function encontrarDatos(wav: Uint8Array): { inicio: number; largo: number; canales: number; tasa: number } | null {
  if (wav.length < 44) return null;
  const vista = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let offset = 12;
  let canales = 1;
  let tasa = 24_000;
  while (offset + 8 <= wav.length) {
    const id = String.fromCharCode(wav[offset] ?? 0, wav[offset + 1] ?? 0, wav[offset + 2] ?? 0, wav[offset + 3] ?? 0);
    const size = vista.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 16 <= wav.length) {
      canales = vista.getUint16(offset + 10, true) || 1;
      tasa = vista.getUint32(offset + 12, true) || tasa;
    }
    if (id === "data") {
      return { inicio: offset + 8, largo: Math.min(size, wav.length - offset - 8), canales, tasa };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * Envolvente de amplitud por barras (RMS de cada tramo), normalizado a 0..1.
 */
export function envelopeFromWav(wav: Uint8Array, barras = BARRAS): Float32Array {
  const salida = new Float32Array(barras);
  const datos = encontrarDatos(wav);
  if (!datos || datos.largo < 4) return salida;
  const muestras = Math.floor(datos.largo / 2 / datos.canales);
  if (muestras < barras) return salida;
  const vista = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const porBarra = Math.floor(muestras / barras);
  let maximo = 0.0001;
  for (let barra = 0; barra < barras; barra += 1) {
    const desde = barra * porBarra;
    const hasta = desde + porBarra;
    let suma = 0;
    for (let indice = desde; indice < hasta; indice += 1) {
      const posicion = datos.inicio + indice * 2 * datos.canales;
      if (posicion + 1 >= wav.length) break;
      const valor = vista.getInt16(posicion, true) / 32768;
      suma += valor * valor;
    }
    const rms = Math.sqrt(suma / Math.max(1, porBarra));
    salida[barra] = rms;
    if (rms > maximo) maximo = rms;
  }
  for (let barra = 0; barra < barras; barra += 1) {
    salida[barra] = Math.min(1, (salida[barra] ?? 0) / maximo);
  }
  return salida;
}
