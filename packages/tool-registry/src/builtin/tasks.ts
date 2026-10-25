import { z } from "zod";
import type { ToolDefinition } from "@jarvis/shared";
import type { ToolServices } from "../types.js";

const CreateSchema = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
  dueAt: z.string().datetime().optional(),
});

const ListSchema = z.object({ status: z.enum(["open", "done", "all"]).default("open") });

const CompleteSchema = z.object({ id: z.string().min(1) });

const DeleteSchema = z.object({ id: z.string().min(1) });

export function createTaskTools(services: ToolServices): ToolDefinition[] {
  const { memory } = services;

  const create: ToolDefinition<z.infer<typeof CreateSchema>> = {
    name: "task.create",
    title: "Crear tarea",
    description: "Crea una tarea personal persistente para el usuario.",
    risk: "local_reversible",
    requiresApproval: false,
    timeoutMs: 3000,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Título de la tarea" },
        notes: { type: "string", description: "Notas opcionales" },
        dueAt: { type: "string", description: "Fecha límite en formato ISO 8601, opcional" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    parse: (raw) => CreateSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input, ctx) => {
      const task = await memory.raw.createTask({
        userId: ctx.userId,
        title: input.title,
        notes: input.notes,
        status: "open",
        dueAt: input.dueAt,
      });
      return {
        ok: true,
        data: task,
        summary: `Tarea creada: «${task.title}» (id ${task.id})`,
        unavailable: false,
      };
    },
  };

  const list: ToolDefinition<z.infer<typeof ListSchema>> = {
    name: "task.list",
    title: "Listar tareas",
    description: "Lista las tareas personales del usuario, filtradas por estado.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 3000,
    parameters: {
      type: "object",
      properties: { status: { type: "string", enum: ["open", "done", "all"], description: "Estado a filtrar" } },
      additionalProperties: false,
    },
    parse: (raw) => ListSchema.parse(raw ?? {}),
    availability: () => ({ available: true }),
    execute: async (input, ctx) => {
      const tasks = await memory.raw.listTasks(ctx.userId, input.status === "all" ? undefined : input.status);
      return {
        ok: true,
        data: { tasks, count: tasks.length },
        summary: tasks.length
          ? `${tasks.length} tarea(s): ${tasks.map((task) => `${task.title}${task.status === "done" ? " ✓" : ""}`).join("; ")}`
          : "No hay tareas que coincidan.",
        unavailable: false,
      };
    },
  };

  const update: ToolDefinition<z.infer<typeof CompleteSchema>> = {
    name: "task.complete",
    title: "Completar o reabrir tarea",
    description: "Marca una tarea como completada o la reabre si ya estaba cerrada.",
    risk: "local_reversible",
    requiresApproval: false,
    timeoutMs: 3000,
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Identificador de la tarea" } },
      required: ["id"],
      additionalProperties: false,
    },
    parse: (raw) => CompleteSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input, ctx) => {
      const current = (await memory.raw.listTasks(ctx.userId)).find((task) => task.id === input.id);
      if (!current) return { ok: false, summary: `No existe la tarea ${input.id}.`, unavailable: false, error: "not_found" };
      const next = current.status === "open" ? "done" : "open";
      const task = await memory.raw.updateTask(input.id, ctx.userId, { status: next });
      return {
        ok: true,
        data: task,
        summary: `Tarea «${current.title}» marcada como ${next === "done" ? "completada" : "reabierta"}.`,
        unavailable: false,
      };
    },
  };

  const remove: ToolDefinition<z.infer<typeof DeleteSchema>> = {
    name: "task.delete",
    title: "Eliminar tarea",
    description: "Elimina permanentemente una tarea personal. Requiere confirmación del usuario.",
    risk: "destructive",
    requiresApproval: true,
    timeoutMs: 3000,
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Identificador de la tarea a eliminar" } },
      required: ["id"],
      additionalProperties: false,
    },
    parse: (raw) => DeleteSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input, ctx) => {
      const task = (await memory.raw.listTasks(ctx.userId)).find((entry) => entry.id === input.id);
      if (!task) return { ok: false, summary: `No existe la tarea ${input.id}.`, unavailable: false, error: "not_found" };
      const deleted = await memory.raw.deleteTask(input.id, ctx.userId);
      return {
        ok: deleted,
        data: { id: input.id },
        summary: deleted ? `Tarea «${task.title}» eliminada.` : "No se pudo eliminar la tarea.",
        unavailable: false,
        error: deleted ? undefined : "delete_failed",
      };
    },
  };

  return [create, list, update, remove];
}
