import { describe, expect, it } from "vitest";
import { DomoticsError } from "./errors.js";
import { HassClient, toWebSocketUrl } from "./hass-client.js";
import type { HassWebSocket, HassWebSocketEvent } from "./types.js";

class FakeSocket implements HassWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: HassWebSocketEvent) => void>>();

  addEventListener(type: string, listener: (event: HassWebSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: HassWebSocketEvent) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  emit(type: string, data?: unknown): void {
    const event: HassWebSocketEvent = { type, data };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  message(payload: unknown): void {
    this.emit("message", JSON.stringify(payload));
  }

  lastCommand(): Record<string, unknown> {
    const raw = this.sent.at(-1);
    if (!raw) throw new Error("No command sent");
    return JSON.parse(raw) as Record<string, unknown>;
  }
}

function createClient(socket: FakeSocket): HassClient {
  return new HassClient(
    { url: "http://ha.example:8123", token: "token-test" },
    {
      webSocketFactory: () => socket,
      reconnect: { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 0 },
    },
  );
}

async function connect(client: HassClient, socket: FakeSocket): Promise<void> {
  const started = client.start();
  socket.readyState = 1;
  socket.emit("open");
  socket.message({ type: "auth_required" });
  socket.message({ type: "auth_ok" });
  await started;
}

describe("HassClient", () => {
  it("convierte la URL base y completa auth_required -> auth -> auth_ok", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    const started = client.start();
    socket.readyState = 1;
    socket.emit("open");
    socket.message({ type: "auth_required" });
    expect(socket.lastCommand()).toMatchObject({ type: "auth", access_token: "token-test" });
    socket.message({ type: "auth_ok" });
    await started;

    expect(client.isConnected()).toBe(true);
    expect(socket.lastCommand().type).toBe("auth");
    await client.stop();
  });

  it("correlaciona get_states con su identificador", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    await connect(client, socket);

    const pending = client.get_states();
    const command = socket.lastCommand();
    expect(command.type).toBe("get_states");
    socket.message({ id: command.id, type: "result", success: true, result: [{ entity_id: "light.a", state: "on" }] });

    const states = await pending;
    expect(states[0]?.entity_id).toBe("light.a");
    expect(states[0]?.domain).toBe("light");
    await client.stop();
  });

  it("mantiene separadas varias órdenes pendientes", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    await connect(client, socket);

    const first = client.get_states();
    const firstCommand = socket.lastCommand();
    const second = client.list_areas();
    const secondCommand = socket.lastCommand();
    expect(firstCommand.id).not.toBe(secondCommand.id);

    socket.message({ id: secondCommand.id, type: "result", success: true, result: [{ area_id: "kitchen", name: "Cocina" }] });
    socket.message({ id: firstCommand.id, type: "result", success: true, result: [] });

    expect((await first)).toHaveLength(0);
    expect((await second)[0]?.area_id).toBe("kitchen");
    await client.stop();
  });

  it("publica eventos de estado y filtra por entity_id", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    await connect(client, socket);
    const received: string[] = [];
    const pending = client.subscribe_state_changed("light.a", (event) => received.push(event.entity_id));
    const command = socket.lastCommand();
    expect(command).toMatchObject({ type: "subscribe_events", event_type: "state_changed" });
    socket.message({ id: command.id, type: "result", success: true, result: null });
    await pending;

    socket.message({
      type: "event",
      event: {
        event_type: "state_changed",
        data: { entity_id: "light.b", new_state: { state: "on" }, old_state: { state: "off" } },
        time_fired: "2026-01-01T00:00:00Z",
      },
    });
    socket.message({
      type: "event",
      event: { event_type: "state_changed", data: { entity_id: "light.a", new_state: { state: "on" } } },
    });
    expect(received).toEqual(["light.a"]);
    await client.stop();
  });

  it("envía call_service con service_data y target", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    await connect(client, socket);

    const pending = client.call_service("light", "turn_on", { brightness: 100 }, { entity_id: "light.a" });
    const command = socket.lastCommand();
    expect(command).toMatchObject({
      type: "call_service",
      domain: "light",
      service: "turn_on",
      service_data: { brightness: 100 },
      target: { entity_id: "light.a" },
    });
    socket.message({ id: command.id, type: "result", success: true, result: { context: { id: "ctx" } } });
    await pending;
    await client.stop();
  });

  it("responde pong al ping del servidor", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    await connect(client, socket);
    socket.message({ id: 77, type: "ping" });
    expect(socket.lastCommand()).toMatchObject({ id: 77, type: "pong" });
    await client.stop();
  });

  it("rechaza un token inválido con DomoticsError", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    const started = client.start();
    socket.readyState = 1;
    socket.emit("open");
    socket.message({ type: "auth_required" });
    socket.message({ type: "auth_invalid", message: "invalid token" });
    await expect(started).rejects.toBeInstanceOf(DomoticsError);
    await client.stop();
  });

  it("cancela una orden pendiente al cerrar la conexión", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    await connect(client, socket);
    const pending = client.get_states();
    await client.stop();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("rechaza arrancar con una señal ya abortada", async () => {
    const socket = new FakeSocket();
    const client = createClient(socket);
    const controller = new AbortController();
    controller.abort();
    await expect(client.start(controller.signal)).rejects.toMatchObject({ kind: "aborted" });
  });

  it("reconecta después de perder una conexión autenticada", async () => {
    const sockets: FakeSocket[] = [];
    const client = new HassClient(
      { url: "http://ha.example:8123", token: "token-test" },
      {
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        reconnect: { initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 2 },
      },
    );
    const started = client.start();
    const first = sockets[0];
    expect(first).toBeDefined();
    if (!first) return;
    first.readyState = 1;
    first.emit("open");
    first.message({ type: "auth_required" });
    first.message({ type: "auth_ok" });
    await started;
    first?.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets.length).toBeGreaterThan(1);
    const second = sockets[1];
    expect(second).toBeDefined();
    if (!second) return;
    second.readyState = 1;
    second.emit("open");
    second.message({ type: "auth_required" });
    second.message({ type: "auth_ok" });
    expect(client.isConnected()).toBe(true);
    await client.stop();
  });

  it("normaliza URLs HTTP, HTTPS y WS", () => {
    expect(toWebSocketUrl("http://host:8123")).toBe("ws://host:8123/api/websocket");
    expect(toWebSocketUrl("https://host")).toBe("wss://host/api/websocket");
    expect(toWebSocketUrl("ws://host/api/websocket")).toBe("ws://host/api/websocket");
  });
});
