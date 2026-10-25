import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@jarvis/shared";
import type { ToolServices } from "../types.js";

const ReadSchema = z.object({ path: z.string().min(1).max(1000) });
const ListSchema = z.object({ path: z.string().max(1000).default(".") });

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".log", ".yaml", ".yml", ".toml", ".ini", ".ts", ".js", ".tsx", ".jsx", ".py", ".html", ".css"]);

function withinRoots(target: string, roots: string[]): string | undefined {
  const absolute = resolve(target);
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    const rel = relative(resolvedRoot, absolute);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolvedRoot;
  }
  return undefined;
}

export function createDocumentTools(services: ToolServices): ToolDefinition[] {
  const { documentsRoots: roots, maxResultBytes } = services.config;

  const unavailable = roots.length === 0 ? { available: false, reason: "DOCUMENTS_ROOT no configurado" } : { available: true };

  const read: ToolDefinition<z.infer<typeof ReadSchema>> = {
    name: "document.read",
    title: "Leer documento",
    description: "Lee un documento de texto dentro de los directorios autorizados. Bloquea cualquier ruta fuera del área permitida.",
    risk: "local_reversible",
    requiresApproval: false,
    timeoutMs: 5000,
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Ruta absoluta o relativa al directorio autorizado" } },
      required: ["path"],
      additionalProperties: false,
    },
    parse: (raw) => ReadSchema.parse(raw),
    availability: () => unavailable,
    execute: async (input) => {
      const target = roots.length === 1 && !isAbsolute(input.path) ? join(roots[0] as string, input.path) : input.path;
      const root = withinRoots(target, roots);
      if (!root) {
        return { ok: false, summary: "Ruta fuera de los directorios autorizados.", unavailable: false, error: "path_not_allowed" };
      }
      try {
        const canonical = await realpath(target);
        if (!withinRoots(canonical, roots)) {
          return { ok: false, summary: "La ruta real queda fuera del área autorizada (posible enlace simbólico).", unavailable: false, error: "path_not_allowed" };
        }
        const info = await stat(canonical);
        if (!info.isFile()) return { ok: false, summary: "La ruta no es un archivo.", unavailable: false, error: "not_a_file" };
        const extension = canonical.slice(canonical.lastIndexOf("."));
        if (!TEXT_EXTENSIONS.has(extension.toLowerCase())) {
          return { ok: false, summary: `Extensión no soportada para lectura de texto: ${extension}`, unavailable: false, error: "unsupported_extension" };
        }
        if (info.size > maxResultBytes) {
          return { ok: false, summary: `El archivo supera el límite de ${maxResultBytes} bytes.`, unavailable: false, error: "too_large" };
        }
        const content = await readFile(canonical, "utf8");
        return {
          ok: true,
          data: { path: canonical, bytes: info.size, content },
          summary: `Leído ${canonical} (${info.size} bytes).`,
          unavailable: false,
        };
      } catch (error) {
        return { ok: false, summary: `No se pudo leer el documento: ${(error as Error).message}`, unavailable: false, error: "read_failed" };
      }
    },
  };

  const list: ToolDefinition<z.infer<typeof ListSchema>> = {
    name: "document.list",
    title: "Listar documentos",
    description: "Lista archivos dentro de los directorios autorizados.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 5000,
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Subdirectorio dentro del área autorizada" } },
      additionalProperties: false,
    },
    parse: (raw) => ListSchema.parse(raw ?? {}),
    availability: () => unavailable,
    execute: async (input) => {
      const target = roots.length === 1 && !isAbsolute(input.path) ? join(roots[0] as string, input.path) : input.path;
      if (!withinRoots(target, roots)) {
        return { ok: false, summary: "Ruta fuera de los directorios autorizados.", unavailable: false, error: "path_not_allowed" };
      }
      try {
        const entries = await readdir(target, { withFileTypes: true });
        const files = entries
          .filter((entry) => entry.isFile() && TEXT_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase()))
          .map((entry) => entry.name)
          .slice(0, 200);
        return { ok: true, data: { path: target, files, count: files.length }, summary: `${files.length} documento(s) disponibles.`, unavailable: false };
      } catch (error) {
        return { ok: false, summary: `No se pudo listar: ${(error as Error).message}`, unavailable: false, error: "list_failed" };
      }
    },
  };

  return [read, list];
}
