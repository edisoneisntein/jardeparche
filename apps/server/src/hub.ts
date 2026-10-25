import type { ServerEvent } from "@jarvis/shared";
import type { Logger } from "./logger.js";

export interface ConnectionMeta {
  sessionId: string;
  userId: string;
  connectedAt: string;
}

interface Connection {
  socket: WebSocketLike;
  meta: ConnectionMeta;
}

/** Minimal socket surface so the hub is testable without a real ws server. */
export interface WebSocketLike {
  send(data: string): void;
  readyState: number;
}

const OPEN = 1;

/**
 * Routes typed events to the connections of a single session. Events are never
 * broadcast across users: a session only ever receives its owner's events.
 */
export class EventHub {
  private readonly connections = new Set<Connection>();

  constructor(private readonly log?: Logger) {}

  add(socket: WebSocketLike, meta: ConnectionMeta): void {
    this.connections.add({ socket, meta });
  }

  remove(socket: WebSocketLike): void {
    for (const connection of this.connections) if (connection.socket === socket) this.connections.delete(connection);
  }

  send(sessionId: string, event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const connection of this.connections) {
      if (connection.meta.sessionId !== sessionId) continue;
      if (connection.socket.readyState !== OPEN) continue;
      try {
        connection.socket.send(payload);
      } catch (error) {
        this.log?.warn({ err: (error as Error).message }, "failed to send event");
      }
    }
  }

  /** Envía un evento a todas las sesiones abiertas (no cruza usuarios: cada socket recibe solo lo suyo). */
  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const connection of this.connections) {
      if (connection.socket.readyState !== OPEN) continue;
      try {
        connection.socket.send(payload);
      } catch (error) {
        this.log?.warn({ err: (error as Error).message }, "failed to broadcast event");
      }
    }
  }

  connectionCount(): number {
    return this.connections.size;
  }

  sessions(): string[] {
    return [...new Set([...this.connections].map((connection) => connection.meta.sessionId))];
  }
}
