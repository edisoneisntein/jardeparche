import type { ChatMessage } from "@jarvis/shared";

/** Extracts searchable plain text from a message without ever touching secrets logic. */
export function extractText(message: ChatMessage): string {
  const { content } = message;
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `[image ${part.image_url.url.slice(0, 32)}]`))
    .join(" ");
}

export function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Serialización JSON a prueba de payloads hostiles.
 *
 * `JSON.stringify` lanza `TypeError` con estructuras circulares y con
 * `BigInt`: un solo `result.data` así tumbaba el turno entero justo cuando
 * se iba a registrar el mensaje de la tool. Aquí la circularidad se marca,
 * los `BigInt` se convierten a texto y el resultado se acota en caracteres.
 */
export function safeStringify(value: unknown, max = 64 * 1024): string {
  const seen = new WeakSet<object>();
  let text: string;
  try {
    text =
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === "bigint") return item.toString();
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) return "[circular]";
          seen.add(item);
        }
        return item;
      }) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length <= max ? text : `${text.slice(0, max)}…[truncado]`;
}

/** Simple, deterministic lexical overlap score in [0,1]. */
export function lexicalScore(query: string, text: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const textTokens = new Set(tokenize(text));
  let hits = 0;
  for (const token of queryTokens) if (textTokens.has(token)) hits += 1;
  return hits / queryTokens.size;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
