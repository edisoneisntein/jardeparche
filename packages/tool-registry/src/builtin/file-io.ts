import { z } from "zod";
import { constants, lstat, mkdir, open, readdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "@jarvis/shared";
import { effectiveToolConfig, type ToolConfig } from "../types.js";

/**
 * Gestión de archivos confinada a un workspace explícito.
 *
 * El confinamiento tiene DOS capas, y ambas son necesarias:
 *
 * 1. **Léxica**: la ruta se resuelve contra la raíz y se exige que no escape.
 *    Esto corta el `../../../../etc/passwd` y las rutas absolutas.
 * 2. **Física**: la ruta se resuelve con `realpath`, es decir siguiendo los
 *    enlaces simbólicos, y se exige que el destino FÍSICO siga dentro de la
 *    raíz física. Sin esta capa, un enlace simbólico dentro del workspace que
 *    apunte a `/etc` convierte `file.io read secrets.txt` en una lectura
 *    arbitraria del host.
 *
 * La comparación se hace contra la raíz resuelta (`realpath(root)`): en
 * macOS `/tmp` es un enlace a `/private/tmp`, y comparar contra la raíz
 * léxica daría falsos rechazos. La escritura además usa `O_NOFOLLOW`, de
 * modo que un enlace simbólico preexistente en el destino no se sigue nunca.
 */

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;

const InputSchema = z.object({
  action: z.enum(["read", "write", "edit", "list"]),
  path: z.string().min(1).max(1024),
  content: z.string().max(MAX_WRITE_BYTES).optional(),
  old_text: z.string().max(MAX_WRITE_BYTES).optional(),
  new_text: z.string().max(MAX_WRITE_BYTES).optional(),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
  recursive: z.boolean().optional(),
});

export type FileIoInput = z.infer<typeof InputSchema>;

/** Violación del confinamiento: la ruta física sale del workspace o no se puede verificar. */
class WorkspaceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
  }
}

/** ¿La ruta resuelta sigue dentro de la raíz? Comparación por diferencia de ruta. */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

export function createFileIoTool(rawConfig: ToolConfig): ToolDefinition<FileIoInput> {
  const config = effectiveToolConfig(rawConfig);
  const root = resolve(config.workspaceRoot);
  let realRootPromise: Promise<string> | undefined;

  /** Raíz física del workspace, resuelta una sola vez y cacheada. */
  const realRoot = (): Promise<string> => {
    realRootPromise ??= realpath(root).catch(() => root);
    return realRootPromise;
  };

  const resolveInside = (candidate: string): string => {
    if (isAbsolute(candidate)) {
      throw new Error(`la ruta debe ser relativa al workspace: ${candidate}`);
    }
    const target = resolve(root, candidate);
    if (!isInside(root, target)) {
      throw new Error(`la ruta sale del workspace: ${candidate}`);
    }
    return target;
  };

  /**
   * Exige que el destino FÍSICO esté dentro del workspace.
   *
   * Se usa `lstat` (no `stat`) para no seguir enlaces simbólicos: así se
   * distingue de forma exacta entre «la ruta no existe» (`ENOENT`) y «la
   * ruta es un enlace simbólico roto» (que `lstat` sí ve). Un enlace roto
   * se rechaza: escribir sobre él crearía el archivo fuera del workspace.
   *
   * Si el destino no existe todavía (caso de `write`), se sube en la cadena
   * hasta el ancestro existente más próximo y se valida ése: es el punto del
   * árbol donde un enlace simbólico podría sacar la escritura del workspace.
   * Cualquier error de resolución que no sea `ENOENT` (por ejemplo un bucle
   * de enlaces `ELOOP`) se rechaza: la política es fail-closed.
   */
  const assertResolvedInside = async (target: string, label: string): Promise<void> => {
    const base = await realRoot();
    let current = target;
    for (;;) {
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          const link = await readlink(current);
          const pointed = isAbsolute(link) ? resolve(link) : resolve(dirname(current), link);
          let real: string;
          try {
            real = await realpath(pointed);
          } catch {
            throw new WorkspaceBoundaryError(`el enlace simbólico no apunta a una ruta válida: ${label}`);
          }
          if (!isInside(base, real)) {
            throw new WorkspaceBoundaryError(`la ruta sale del workspace: ${label}`);
          }
          return;
        }
        const real = await realpath(current);
        if (!isInside(base, real)) {
          throw new WorkspaceBoundaryError(`la ruta sale del workspace: ${label}`);
        }
        return;
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw new WorkspaceBoundaryError(`la ruta no se puede resolver de forma segura: ${label}`);
        }
        const parent = dirname(current);
        if (parent === current) {
          throw new WorkspaceBoundaryError(`la ruta sale del workspace: ${label}`);
        }
        current = parent;
      }
    }
  };

  /** Escribe sin seguir enlaces simbólicos en el destino (`O_NOFOLLOW`). */
  const writeWithoutFollowingLinks = async (target: string, content: string): Promise<void> => {
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content, "utf-8");
    } finally {
      await handle.close();
    }
  };

  return {
    name: "file.io",
    title: "Gestor de Archivos",
    description: `Lee, escribe, edita y lista archivos dentro del workspace (${root}). Las rutas son relativas al workspace; se rechazan tanto las rutas que lo abandonan como los enlaces simbólicos que apuntan fuera de él.`,
    risk: "local_reversible",
    requiresApproval: true,
    timeoutMs: 10_000,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "edit", "list"], description: "Operación a realizar." },
        path: { type: "string", description: "Ruta relativa al workspace root." },
        content: { type: "string", description: "Contenido para escribir o editar." },
        old_text: { type: "string", description: "Texto exacto a reemplazar en edit." },
        new_text: { type: "string", description: "Nuevo texto para reemplazar en edit." },
        start_line: { type: "integer", description: "Línea inicial (1-based) para lectura parcial." },
        end_line: { type: "integer", description: "Línea final (inclusive) para lectura parcial." },
        recursive: { type: "boolean", description: "Listado recursivo." },
      },
      required: ["action", "path"],
      additionalProperties: false,
    },
    parse: (raw) => InputSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input) => {
      try {
        const target = resolveInside(input.path);

        if (input.action === "read") {
          await assertResolvedInside(target, input.path);
          const real = await realpath(target);
          const info = await stat(real);
          if (!info.isFile()) return { ok: false, summary: `No es un archivo: ${input.path}`, unavailable: false, error: "not_a_file" };
          if (info.size > MAX_READ_BYTES) {
            return {
              ok: false,
              summary: `El archivo supera el límite de ${MAX_READ_BYTES} bytes (${info.size}).`,
              unavailable: false,
              error: "file_too_large",
            };
          }
          const data = await readFile(real, "utf-8");
          const lines = data.split("\n");
          const start = Math.max(0, (input.start_line ?? 1) - 1);
          const end = Math.min(lines.length, input.end_line ?? lines.length);
          const content = lines.slice(start, end).join("\n");
          return {
            ok: true,
            summary: `Leído ${input.path} (${content.length} caracteres, ${end - start} de ${lines.length} líneas).`,
            unavailable: false,
            data: { path: input.path, content, bytes: info.size, lines: lines.length, truncated: false },
          };
        }

        if (input.action === "write") {
          const content = input.content ?? "";
          if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
            return { ok: false, summary: "El contenido supera el límite de escritura.", unavailable: false, error: "content_too_large" };
          }
          await assertResolvedInside(target, input.path);
          await mkdir(dirname(target), { recursive: true });
          await assertResolvedInside(dirname(target), dirname(input.path));
          await writeWithoutFollowingLinks(target, content);
          const info = await stat(target);
          return {
            ok: true,
            summary: `Archivo ${input.path} escrito (${info.size} bytes).`,
            unavailable: false,
            data: { path: input.path, bytes: info.size },
          };
        }

        if (input.action === "edit") {
          if (!input.old_text) {
            return { ok: false, summary: "edit requiere old_text.", unavailable: false, error: "missing_old_text" };
          }
          await assertResolvedInside(target, input.path);
          const real = await realpath(target);
          const data = await readFile(real, "utf-8");
          if (!data.includes(input.old_text)) {
            return {
              ok: false,
              summary: `No se encontró el bloque exacto en ${input.path}.`,
              unavailable: false,
              error: "block_not_found",
            };
          }
          const updated = data.replace(input.old_text, input.new_text ?? "");
          await writeWithoutFollowingLinks(real, updated);
          return {
            ok: true,
            summary: `Archivo ${input.path} editado.`,
            unavailable: false,
            data: { path: input.path, bytes: Buffer.byteLength(updated, "utf8"), occurrences: data.split(input.old_text).length - 1 },
          };
        }

        await assertResolvedInside(target, input.path);
        const real = await realpath(target);
        const info = await stat(real);
        if (!info.isDirectory()) {
          return { ok: false, summary: `No es un directorio: ${input.path}`, unavailable: false, error: "not_a_directory" };
        }
        const entries = await readdir(real, { withFileTypes: true, recursive: input.recursive ?? false });
        const listing: Array<{ path: string; type: string; bytes?: number }> = [];
        const base = await realRoot();
        for (const entry of entries) {
          const parent = (entry as { parentPath?: string }).parentPath;
          const full = parent ? join(parent, entry.name) : join(real, entry.name);
          if (!isInside(base, await realpath(full).catch(() => full))) continue;
          const relativePath = relative(base, full);
          const type = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : "file";
          let bytes: number | undefined;
          if (type === "file") {
            try {
              bytes = (await stat(full)).size;
            } catch {
              bytes = undefined;
            }
          }
          listing.push({ path: relativePath, type, bytes });
        }
        return {
          ok: true,
          summary: `${listing.length} entrada(s) en ${input.path}.`,
          unavailable: false,
          data: { path: input.path, entries: listing },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as NodeJS.ErrnoException).code;
        const isBoundary = error instanceof WorkspaceBoundaryError || message.includes("workspace");
        const isSymlink = code === "ELOOP";
        return {
          ok: false,
          summary: isBoundary
            ? message
            : isSymlink
              ? `Se rechaza operar sobre un enlace simbólico: ${input.path}`
              : `La operación de archivo falló: ${message}`,
          unavailable: false,
          error: isBoundary ? "path_outside_workspace" : isSymlink ? "symlink_rejected" : "file_operation_failed",
        };
      }
    },
  };
}

/** Verifica que el enlace simbólico no escape del workspace (usado en el listado). */
export async function assertRealpathInside(root: string, candidate: string): Promise<boolean> {
  try {
    const real = await realpath(candidate);
    return isInside(root, real);
  } catch {
    return false;
  }
}
