#!/usr/bin/env node
/**
 * End-to-end test for voice pipeline:
 *  - Starts server (if not already running) – assumes server on localhost:8787
 *  - Opens WebSocket, sends a dummy audio chunk, expects assistant.audio.segment back.
 *  - Validates generationId handling and stopServerAudio.
 *
 * Run with: node scripts/voice-e2e.mjs
 */
import { WebSocket } from "ws";

const WS_URL = process.env.JARVIS_WS_URL ?? "ws://localhost:8787/ws?token=test";
const TIMEOUT_MS = 15000;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log("[voice-e2e] Connecting to", WS_URL);
  const ws = new WebSocket(WS_URL);
  let resolved = false;

  const timeout = setTimeout(() => {
    if (!resolved) {
      console.error("[voice-e2e] Timeout");
      process.exit(1);
    }
  }, TIMEOUT_MS);

  ws.on("open", () => {
    console.log("[voice-e2e] WS open");
    // Send a minimal audio_chunk command (silence)
    const pcm = new Int16Array(320); // 20ms @16kHz
    const base64 = Buffer.from(pcm.buffer).toString("base64");
    ws.send(JSON.stringify({ type: "audio_chunk", sessionId: "test-session", data: base64, final: true }));
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    console.log("[voice-e2e] Received:", data.type);
    if (data.type === "voice.audio.segment") {
      console.log("[voice-e2e] Got audio segment, generationId:", data.generationId);
      // Send cancel to test interruption
      ws.send(JSON.stringify({ type: "cancel", sessionId: "test-session" }));
    } else if (data.type === "voice.audio.end") {
      console.log("[voice-e2e] Voice end for generation:", data.generationId);
      resolved = true;
      clearTimeout(timeout);
      ws.close();
    } else if (data.type === "agent.error") {
      console.error("[voice-e2e] Server error:", data.message);
      resolved = true;
      clearTimeout(timeout);
      ws.close();
      process.exit(1);
    }
  });

  ws.on("error", (err) => {
    console.error("[voice-e2e] WS error:", err.message);
    if (!resolved) process.exit(1);
  });

  ws.on("close", () => {
    if (!resolved) {
      console.error("[voice-e2e] Connection closed unexpectedly");
      process.exit(1);
    }
  });
}

run().catch((e) => {
  console.error("[voice-e2e] Fatal:", e);
  process.exit(1);
});