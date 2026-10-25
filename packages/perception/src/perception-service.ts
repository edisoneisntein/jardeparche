import type { AiProvider } from "@jarvis/ai-provider";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface ImagePayload {
  mime: string;
  base64: string;
  bytes: number;
  dataUrl: string;
  /** Dimensiones reales, leídas de la cabecera del archivo. */
  width: number;
  height: number;
}

export interface ImageAnalysis {
  text: string;
  bytes: number;
  mime: string;
  model: string;
  oneShot: true;
}

export interface PerceptionOptions {
  visionModel: string;
  /** Hard cap on decoded image bytes. */
  maxBytes: number;
  enabled: boolean;
}

export class PerceptionError extends Error {
  constructor(
    public readonly code: "disabled" | "invalid_payload" | "too_large" | "unsupported_mime",
    message: string,
  ) {
    super(message);
    this.name = "PerceptionError";
  }
}

/**
 * One-shot visual perception. JARVIS never claims continuous real-time vision:
 * each call analyzes exactly one still image supplied by the user's browser.
 * Camera capture itself is a browser concern and is always user-initiated.
 */
/**
 * Lee las dimensiones reales de la imagen desde la cabecera del archivo.
 * PNG, JPEG, GIF y WebP. Devuelve 0×0 si el formato no se reconoce: el
 * llamador debe reflejarlo, nunca inventar un tamaño.
 */
export function readImageDimensions(buffer: Buffer, mime: string): { width: number; height: number } {
  try {
    if (mime === "image/png" && buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mime === "image/gif" && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (mime === "image/webp" && buffer.length >= 30) {
      // VP8X / VP8 / VP8L
      if (buffer.toString("ascii", 12, 16) === "VP8X") {
        return {
          width: 1 + (buffer.readUIntLE(24, 3) & 0xffffff),
          height: 1 + (buffer.readUIntLE(27, 3) & 0xffffff),
        };
      }
      if (buffer.toString("ascii", 12, 16) === "VP8 ") {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      }
      if (buffer.toString("ascii", 12, 16) === "VP8L") {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === "image/jpeg" && buffer.length >= 4) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1] ?? 0;
        const size = buffer.readUInt16BE(offset + 2);
        // SOF0..SOF15 (excepto DHT/JPG/DAC) llevan las dimensiones.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + size;
      }
    }
  } catch {
    return { width: 0, height: 0 };
  }
  return { width: 0, height: 0 };
}

export class PerceptionService {
  private readonly cameraActive = new Map<string, boolean>();

  constructor(
    private readonly provider: AiProvider,
    private readonly options: PerceptionOptions,
  ) {}

  parseDataUrl(dataUrl: string): ImagePayload {
    if (!this.options.enabled) throw new PerceptionError("disabled", "El análisis de imágenes está deshabilitado en la configuración.");
    const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
    if (!match) throw new PerceptionError("invalid_payload", "La imagen no es un data URL base64 válido.");
    const mime = (match[1] as string).toLowerCase();
    const base64 = match[2] as string;
    if (!ALLOWED_MIME.has(mime)) throw new PerceptionError("unsupported_mime", `Formato no soportado: ${mime}`);
    const bytes = Math.floor((base64.length * 3) / 4);
    if (bytes > this.options.maxBytes) {
      throw new PerceptionError("too_large", `La imagen supera el límite de ${Math.round(this.options.maxBytes / 1024)} KB.`);
    }
    const { width, height } = readImageDimensions(Buffer.from(base64, "base64"), mime);
    return { mime, base64, bytes, dataUrl, width, height };
  }

  setCameraState(sessionId: string, active: boolean): void {
    if (active) this.cameraActive.set(sessionId, true);
    else this.cameraActive.delete(sessionId);
  }

  isCameraActive(sessionId: string): boolean {
    return this.cameraActive.get(sessionId) ?? false;
  }

  /**
   * Salud real del subsistema de percepción: comprueba que el proveedor de
   * visión responde y que el modelo está configurado. No devuelve un estado
   * constante.
   */
  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!this.options.enabled) return { ok: false, detail: "el análisis de imágenes está deshabilitado" };
    try {
      const probe = await this.provider.health();
      return {
        ok: probe.ok,
        detail: `${probe.detail} · modelo de visión ${this.options.visionModel}${probe.ok ? "" : " (proveedor no disponible)"}`,
      };
    } catch (error) {
      return { ok: false, detail: `el proveedor no respondió: ${(error as Error).message}` };
    }
  }

  async analyze(payload: ImagePayload, prompt?: string): Promise<ImageAnalysis> {
    const result = await this.provider.chat({
      model: this.options.visionModel,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                prompt ??
                "Describe con precisión lo que se ve en la imagen. Si contiene texto legible, transcríbelo literalmente. No inventes detalles que no puedas observar.",
            },
            { type: "image_url", image_url: { url: payload.dataUrl } },
          ],
        },
      ],
      maxTokens: 1024,
      temperature: 0.1,
    });
    return {
      text: result.content.trim() || "El modelo de visión no devolvió contenido.",
      bytes: payload.bytes,
      mime: payload.mime,
      model: this.options.visionModel,
      oneShot: true,
    };
  }
}
