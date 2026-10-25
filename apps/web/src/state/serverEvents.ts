import type { ServerEvent } from "../lib/events";
import { formatNumber } from "../lib/format";
import { useJarvisStore } from "./jarvisStore";
import { setServerEpoch, handleInterruptAck } from "../lib/serverAudio";

export function applyServerEvent(event: ServerEvent): void {
  const store = useJarvisStore.getState();

  if ("taskId" in event && event.taskId) store.setCurrentTask(event.taskId);

  switch (event.type) {
    case "session.created":
      store.recordActivity({
        kind: "session",
        title: "Sesión creada",
        detail: `usuario ${event.userId}`,
        tone: "info",
        ts: event.ts,
      });
      break;

    case "assistant.state_changed":
      store.setAgentState(event.state, event.detail ?? null);
      // El identificador de tarea caduca con el turno: mantenerlo fazia que
      // un "Detener" posterior cancelara una tarea inexistente y mostrara
      // "Tarea cancelada" sin que hubiera ninguna.
      if (event.state === "COMPLETED" || event.state === "FAILED" || event.state === "INTERRUPTED" || event.state === "IDLE") {
        store.setCurrentTask(null);
      }
      store.recordActivity({
        kind: "state",
        title: `Estado: ${event.state}`,
        detail: event.detail,
        tone:
          event.state === "FAILED"
            ? "error"
            : event.state === "INTERRUPTED"
              ? "warn"
              : event.state === "COMPLETED"
                ? "success"
                : "info",
        ts: event.ts,
      });
      break;

    case "assistant.delta":
      store.appendAssistantDelta(event.text);
      break;

    case "assistant.reasoning":
      store.appendAssistantReasoning(event.text);
      break;

    case "assistant.message_completed":
      store.completeAssistantMessage(event.text, event.usage);
      if (event.usage) store.addUsage(event.usage);
      store.recordActivity({
        kind: "assistant",
        title: "Respuesta completada",
        detail: event.usage?.totalTokens
          ? `${formatNumber(event.usage.totalTokens)} tokens`
          : undefined,
        tone: "success",
        tokens: event.usage?.totalTokens,
        ts: event.ts,
      });
      break;

    case "tool.started":
      store.addToolStarted({
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.arguments,
        risk: event.risk,
        ts: event.ts,
      });
      store.recordActivity({
        kind: "tool",
        title: `Herramienta iniciada · ${event.name}`,
        detail: `riesgo ${event.risk}`,
        tone: "tool",
        ts: event.ts,
      });
      break;

    case "tool.awaiting_approval":
      store.addToolAwaitingApproval({
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.arguments,
        risk: event.risk,
        approvalId: event.approvalId,
        description: event.description,
        ts: event.ts,
      });
      store.recordActivity({
        kind: "approval",
        title: `Aprobación solicitada · ${event.name}`,
        detail: event.description,
        tone: "warn",
        ts: event.ts,
      });
      break;

    case "tool.completed":
      store.addToolCompleted({
        toolCallId: event.toolCallId,
        name: event.name,
        summary: event.summary,
        durationMs: event.durationMs,
        data: event.data,
        ts: event.ts,
      });
      store.recordActivity({
        kind: "tool",
        title: `Herramienta completada · ${event.name}`,
        detail: event.summary,
        tone: "success",
        durationMs: event.durationMs,
        ts: event.ts,
      });
      break;

    case "tool.failed":
      store.addToolFailed({
        toolCallId: event.toolCallId,
        name: event.name,
        error: event.error,
        unavailable: event.unavailable,
        ts: event.ts,
      });
      store.recordActivity({
        kind: "tool",
        title: `Herramienta ${event.unavailable ? "no disponible" : "fallida"} · ${event.name}`,
        detail: event.error,
        tone: event.unavailable ? "warn" : "error",
        ts: event.ts,
      });
      break;

    case "voice.input_started":
      store.recordActivity({
        kind: "voice",
        title: "Entrada de voz iniciada",
        tone: "voice",
        ts: event.ts,
      });
      break;

    case "voice.asr.result":
      store.recordActivity({
        kind: "voice",
        title: event.serverAsr ? "Transcripción (servidor)" : "ASR del servidor no disponible",
        detail: event.text || "se usará el reconocedor del navegador",
        tone: event.serverAsr ? "voice" : "warn",
        ts: event.ts,
      });
      break;

    case "voice.transcript":
      store.recordActivity({
        kind: "voice",
        title: event.final ? "Transcripción final" : "Transcripción parcial",
        detail: event.text,
        tone: "voice",
        ts: event.ts,
      });
      break;

    case "voice.output_started":
      store.recordActivity({
        kind: "voice",
        title: "Salida de voz",
        detail: event.text.slice(0, 160),
        tone: "voice",
        ts: event.ts,
      });
      break;

    case "voice.speaking.started":
      // Actualizar época del servidor para sincronización de interrupción (P1)
      if ("serverEpoch" in event && typeof event.serverEpoch === "number") {
        setServerEpoch(event.serverEpoch);
      }
      store.recordActivity({
        kind: "voice",
        title: "Síntesis iniciada",
        detail: event.text.slice(0, 160),
        tone: "voice",
        ts: event.ts,
      });
      break;

    case "voice.audio.segment":
      // Los segmentos incluyen serverEpoch para validación de frescura
      if ("serverEpoch" in event && typeof event.serverEpoch === "number") {
        // La reproducción se maneja en el componente VoiceVisualizer/Conversation
        // Aquí solo registramos actividad
      }
      store.recordActivity({
        kind: "voice",
        title: `Segmento de audio ${event.index + 1}`,
        detail: event.text.slice(0, 80),
        tone: "voice",
        ts: event.ts,
      });
      break;

    case "voice.audio.end":
      store.recordActivity({
        kind: "voice",
        title: "Secuencia de audio completada",
        tone: "voice",
        ts: event.ts,
      });
      break;

    case "voice.output_stopped":
      store.recordActivity({
        kind: "voice",
        title: "Salida de voz detenida",
        detail: event.reason === "interrupted" ? "interrumpida por usuario" : "completada",
        tone: event.reason === "interrupted" ? "warn" : "voice",
        ts: event.ts,
      });
      break;

    case "voice.interrupt.ack":
      // Handshake de interrupción completado (P1)
      if ("confirmedEpoch" in event && "newServerEpoch" in event) {
        handleInterruptAck({
          confirmedEpoch: event.confirmedEpoch,
          newServerEpoch: event.newServerEpoch,
          flushedBytes: event.flushedBytes ?? 0,
        });
      }
      break;

    case "perception.image_received":
      store.recordActivity({
        kind: "perception",
        title: "Fotograma recibido",
        detail: `${event.width}×${event.height} · cámara ${event.cameraActive ? "activa" : "inactiva"}`,
        tone: "info",
        ts: event.ts,
      });
      break;

    case "perception.camera_state":
      store.recordActivity({
        kind: "perception",
        title: `Cámara ${event.cameraActive ? "activa" : "inactiva"}`,
        tone: "info",
        ts: event.ts,
      });
      break;

    case "system.health_changed":
      store.applyHealthChange(event.component, event.status, event.detail, event.ts);
      store.recordActivity({
        kind: "health",
        title: `Salud · ${event.component}: ${event.status}`,
        detail: event.detail,
        tone: event.status === "up" ? "success" : event.status === "down" ? "error" : "warn",
        ts: event.ts,
      });
      break;

    case "task.cancelled":
      store.recordActivity({
        kind: "task",
        title: "Tarea cancelada",
        tone: "warn",
        ts: event.ts,
      });
      store.setCurrentTask(null);
      break;

    case "agent.error":
      store.addSystemMessage(`Error del agente: ${event.message}`, "system");
      store.recordActivity({
        kind: "error",
        title: "Error del agente",
        detail: event.message,
        tone: "error",
        ts: event.ts,
      });
      break;

    default:
      break;
  }
}
