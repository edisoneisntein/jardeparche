import pino from "pino";
import type { AppConfig } from "./config.js";

/**
 * Structured logging with a redaction list. Secrets and user content must never
 * reach the logs: NVIDIA keys, tokens and message bodies are stripped.
 */
export function createLogger(config: AppConfig) {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['x-jarvis-token']",
        "nvidiaApiKey",
        "apiKey",
        "token",
        "*.apiKey",
        "*.token",
        "text",
        "*.text",
        "detail.arguments",
      ],
      censor: "[redacted]",
    },
    transport:
      config.nodeEnv === "development"
        ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" } }
        : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
