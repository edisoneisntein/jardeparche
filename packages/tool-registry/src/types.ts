import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryService } from "@jarvis/memory";
import type { ToolDefinition } from "@jarvis/shared";

export type { ToolDefinition } from "@jarvis/shared";

export interface WebSearchConfig {
  provider?: "brave" | "tavily" | "endless" | "federated";
  apiKey?: string;
  /** Instancia SearXNG del proveedor `endless` (por defecto https://api.endless.sbs). */
  endlessBaseUrl?: string;
  /** Clave propia de la instancia SearXNG. Opcional: las instancias privadas la exigen. */
  endlessApiKey?: string;
  /** Motores concretos del metasearch (por defecto, los de la instancia). */
  engines?: string[];
}

export interface ToolConfig {
  /** Colon or comma separated absolute directories the document reader may access. */
  documentsRoots: string[];
  webSearch: WebSearchConfig;
  /** Hard cap on bytes returned by any single tool. */
  maxResultBytes: number;
  /** Sandbox images per language. Missing images make the tool unavailable, never simulated. */
  sandboxImages?: Record<string, string>;
  /** Workspace raíz de las tools de archivo y shell. */
  workspaceRoot?: string;
  /** Binarios permitidos para `shell.execute`. */
  shellAllowlist?: string[];
  /** Driver de control de interfaz (macOS). */
  computerUseDriver?: string;
  /**
   * Habilita `computer.use` (control del ratón y el teclado del host).
   * Apagado por defecto: es la capacidad con más radio de impacto y menos
   * utilidad everyday; el código queda disponible para activarla a propósito.
   */
  enableComputerUse?: boolean;
}

/**
 * Driver de control de interfaz por defecto. Se resuelve RELATIVO al paquete
 * (no al cwd): el servidor puede arrancar desde cualquier directorio.
 */
function defaultComputerUseDriver(): string {
  try {
    return fileURLToPath(new URL("../../../infra/computer-use/driver.py", import.meta.url));
  } catch {
    return join(process.cwd(), "infra", "computer-use", "driver.py");
  }
}

/**
 * Valores efectivos de la configuración de tools: completa los campos
 * opcionales con los valores por defecto del sistema.
 */
export function effectiveToolConfig(config: ToolConfig): ToolConfig & {
  workspaceRoot: string;
  shellAllowlist: string[];
  computerUseDriver: string;
} {
  return {
    ...config,
    workspaceRoot: config.workspaceRoot?.trim() || join(homedir(), ".jarvis", "workspace"),
    shellAllowlist:
      config.shellAllowlist && config.shellAllowlist.length > 0
        ? config.shellAllowlist
        : ["ls", "pwd", "cat", "grep", "find", "git", "node", "npm", "pnpm", "python3", "wc", "head", "tail"],
    computerUseDriver:
      config.computerUseDriver?.trim() || defaultComputerUseDriver(),
  };
}

export interface ToolServices {
  memory: MemoryService;
  config: ToolConfig;
}

export interface ToolRegistryLike {
  list(): ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
}

export function loadToolConfig(env: NodeJS.ProcessEnv = process.env): ToolConfig {
  const roots = (env.DOCUMENTS_ROOT ?? "")
    .split(/[:,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const sandboxImages: Record<string, string> = {};
  const imageEnv: Record<string, string | undefined> = {
    python: env.JARVIS_SANDBOX_IMAGE_PYTHON,
    nodejs: env.JARVIS_SANDBOX_IMAGE_NODEJS,
    cpp: env.JARVIS_SANDBOX_IMAGE_CPP,
    rust: env.JARVIS_SANDBOX_IMAGE_RUST,
    go: env.JARVIS_SANDBOX_IMAGE_GO,
  };
  for (const [language, image] of Object.entries(imageEnv)) {
    if (image && image.trim()) sandboxImages[language] = image.trim();
  }
  const workspaceRoot = env.JARVIS_WORKSPACE_ROOT?.trim() || join(homedir(), ".jarvis", "workspace");
  const shellAllowlist = (env.JARVIS_SHELL_ALLOWLIST ?? "ls,pwd,cat,grep,find,git,node,npm,pnpm,python3,wc,head,tail")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const computerUseDriver =
    env.JARVIS_COMPUTER_USE_DRIVER?.trim() || join(process.cwd(), "infra", "computer-use", "driver.py");
  return {
    documentsRoots: roots,
    webSearch: {
      provider: env.WEB_SEARCH_PROVIDER === "brave" || env.WEB_SEARCH_PROVIDER === "tavily" ? env.WEB_SEARCH_PROVIDER : undefined,
      apiKey: env.WEB_SEARCH_API_KEY?.trim() || undefined,
    },
    maxResultBytes: 256 * 1024,
    sandboxImages,
    workspaceRoot,
    shellAllowlist,
    computerUseDriver,
  };
}
