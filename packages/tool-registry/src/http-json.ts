/**
 * Lectura acotada de respuestas JSON externas.
 *
 * `response.json()` sin más acumula el cuerpo entero en memoria: un endpoint
 * hostil (o un proxy malicioso) puede devolver cientos de megabytes y tumbar
 * el proceso. Aquí el cuerpo se lee con un tope de bytes y el error se
 * declara, no se traga.
 */

/** Tope por defecto para una respuesta JSON externa. */
export const MAX_JSON_BYTES = 1024 * 1024;

/**
 * Lee el cuerpo de una respuesta como JSON, sin superar `maxBytes`.
 *
 * @throws Error si el cuerpo supera el tope o no es JSON válido.
 */
export async function readJsonCapped(response: Response, maxBytes: number = MAX_JSON_BYTES): Promise<unknown> {
  const body = await readBodyCapped(response, maxBytes);
  const text = body.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`respuesta no es JSON válido (${text.length} bytes)`);
  }
}

/** Lee el cuerpo de una respuesta con un tope de bytes. */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const text = await response.text();
    const buffer = Buffer.from(text, "utf8");
    if (buffer.byteLength > maxBytes) {
      throw new Error(`respuesta demasiado grande (${buffer.byteLength} bytes > ${maxBytes})`);
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`respuesta demasiado grande (>${maxBytes} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
