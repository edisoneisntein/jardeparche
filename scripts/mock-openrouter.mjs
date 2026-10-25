#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Mock de un endpoint compatible con OpenRouter/OpenAI para verificar el
 * failover de forma reproducible y sin gastar créditos.
 *
 *   GET  /v1/models            -> catálogo con capacidades reales
 *   POST /v1/chat/completions  -> SSE con contenido identificable
 */

import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8899);
const MODEL = process.env.MOCK_MODEL ?? "minimax/minimax-m3.1-flash";

const server = createServer((req, res) => {
  if (req.url && req.url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          {
            id: MODEL,
            name: "Mock OpenRouter Model",
            context_length: 1000000,
            supported_parameters: ["stream", "tools", "tool_choice", "reasoning", "include_usage"],
            architecture: { modality: "text->text", input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
          },
        ],
      }),
    );
    return;
  }

  if (req.url && req.url.endsWith("/chat/completions")) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = {};
      }
      if (payload.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const send = (data) => res.write("data: " + JSON.stringify(data) + "\n\n");
        send({ model: MODEL, choices: [{ delta: { reasoning: "razonamiento de " + MODEL } }] });
        send({ model: MODEL, choices: [{ delta: { content: "RESPUESTA DE " + MODEL } }] });
        send({ model: MODEL, choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: MODEL,
          choices: [{ message: { content: "RESPUESTA DE " + MODEL }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        }),
      );
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("mock openrouter escuchando en http://127.0.0.1:" + PORT + "/v1 (modelo " + MODEL + ")");
});
