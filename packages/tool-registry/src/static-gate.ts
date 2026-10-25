/**
 * Gate estático previo a la ejecución.
 *
 * Es la CAPA AUTORITATIVA de seguridad: se ejecuta en el servidor, sobre el
 * código que el modelo propone, antes de tocar el sandbox. El auto-análisis
 * del modelo es disuasorio; este gate es un límite.
 *
 * El gate NO es el único límite (el sandbox lo es), y por diseño no pretende
 * ser indemostrable: el código puede ofuscar una llamada (`getattr(b,"ev"+"al")`).
 * Lo que sí garantiza es que ninguna llamada *explícita* a las categorías
 * prohibidas llegue al sandbox, y que el agente reciba un diagnóstico accionable
 * en lugar de un fallo opaco.
 */

export type GateSeverity = "reject" | "warn";

export interface GateRule {
  id: string;
  severity: GateSeverity;
  description: string;
  pattern: RegExp;
}

export interface GateFinding {
  ruleId: string;
  severity: GateSeverity;
  description: string;
  line: number;
  excerpt: string;
}

export interface GateVerdict {
  allowed: boolean;
  findings: GateFinding[];
}

/**
 * Denylist. `reject` impide la ejecución; `warn` no la impide pero viaja al
 * agente para que sepa que su códigoProbably no funcionará como espera.
 */
export const GATE_RULES: readonly GateRule[] = [
  // ── Sistema de archivos destructivo ───────────────────────────────────
  { id: "fs.rm_rf", severity: "reject", description: "Borrado masivo del sistema de archivos (rm -rf / rmtree).", pattern: /\brm\s+-[a-z]*[rR][a-z]*f|\bshutil\.rmtree\b|\bos\.removedirs?\b|\bfs\.rmSync\s*\([^)]*recursive\s*:\s*true/i },
  { id: "fs.raw_device", severity: "reject", description: "Escritura sobre dispositivos de bloque (dd/mkfs sobre /dev).", pattern: /\bdd\s+if=|\bmkfs(\.\w+)?\b|\bfdisk\b|\bshred\b/i },
  { id: "fs.chmod_777", severity: "reject", description: "Permisos abiertos (chmod 777) sobre rutas del sistema.", pattern: /\bchmod\s+(-R\s+)?777\b/i },
  { id: "fs.etc_write", severity: "reject", description: "Escritura en rutas del sistema (/etc, /usr, /bin, /var).", pattern: /["'`]\/(etc|usr\/local\/bin|bin|sbin|boot|var\/lib)\//i },

  // ── Escalada de privilegios y evasión ─────────────────────────────────
  { id: "priv.sudo", severity: "reject", description: "Escalada de privilegios (sudo/su/setuid).", pattern: /\bsudo\b|\bsu\s+-\b|\bsetuid\s*\(|\bseteuid\s*\(/i },
  { id: "priv.process_escape", severity: "reject", description: "Manipulación de procesos o espacios de nombres (ptrace/mount/nsenter/unshare).", pattern: /\bptrace\b|\bnsenter\b|\bunshare\b|\bsetns\s*\(|\bchroot\s*\(/i },
  { id: "priv.capabilities", severity: "reject", description: "Capacidades de Linux (cap_set_proc, CAP_SYS_ADMIN).", pattern: /\bcap_set_proc\b|CAP_SYS_ADMIN|\bsetcap\b/i },

  // ── Red y exfiltración ────────────────────────────────────────────────
  { id: "net.socket_raw", severity: "reject", description: "Sockets crudos o de paquetes (SOCK_RAW / AF_PACKET).", pattern: /SOCK_RAW|AF_PACKET|AF_LINK|\bscapy\b/i },
  { id: "net.egress", severity: "reject", description: "Egreso de red: el sandbox se ejecuta con network: none.", pattern: /\bcurl\b|\bwget\b|\bnc\s+-|\bnetcat\b|\burllib\.request\b|\bhttp\.client\b|\brequests\.(get|post|put)\b|\bsocket\.create_connection\b|\bfetch\s*\(|\baxios\b|\burlopen\b/i },

  // ── Bombas de procesos ────────────────────────────────────────────────
  { id: "proc.fork_bomb", severity: "reject", description: "Bomba de procesos: creación de procesos en bucle sin cota.", pattern: /while\s*\(\s*(?:true|1)\s*\)\s*\{[^}]*\b(fork|multiprocessing\.Process|ProcessPoolExecutor)\b/is },
  { id: "proc.unbounded_spawn", severity: "warn", description: "Creación de procesos sin cota explícita.", pattern: /\bProcessPoolExecutor\s*\(|\bmultiprocessing\.Pool\s*\(\s*\d*\s*\)|\.fork\s*\(/i },
  { id: "proc.daemon", severity: "reject", description: "Proceso en segundo plano que sobrevive a la ejecución.", pattern: /\bnohup\b|\bdaemon\s*=\s*True|\bsetsid\s*\(|\bdisown\b|&\s*$/m },

  // ── Persistencia ──────────────────────────────────────────────────────
  { id: "persist.scheduler", severity: "reject", description: "Persistencia vía planificador del sistema (cron/systemd/launchd).", pattern: /\bcrontab\b|\bsystemctl\b|\blaunchctl\b|\bschtasks\b/i },
  { id: "persist.shell_rc", severity: "reject", description: "Modificación de ficheros de arranque del shell.", pattern: /~?\/?\.(bashrc|zshrc|bash_profile|profile)\b/i },

  // ── Secretos ──────────────────────────────────────────────────────────
  { id: "secret.env_sensitive", severity: "reject", description: "Acceso a variables de entorno sensibles (tokens, claves, credenciales).", pattern: /(?:os\.environ|process\.env|getenv)\s*[\(\[]?\s*["'`]?[A-Z_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL)[A-Z_]*/i },
  { id: "secret.aws", severity: "reject", description: "Acceso a credenciales de nube (AWS_*, GOOGLE_*, AZURE_*).", pattern: /\b(AWS_|GOOGLE_|AZURE_|NVIDIA_API_KEY|GITHUB_TOKEN)\b/i },
  { id: "secret.files", severity: "reject", description: "Lectura de ficheros de credenciales del sistema.", pattern: /["'`]\/etc\/(passwd|shadow|hosts)|\bid_rsa\b|\.aws\/credentials|\.ssh\/id_/i },

  // ── Deserialización y ejecución dinámica ──────────────────────────────
  { id: "exec.eval", severity: "warn", description: "Ejecución dinámica de código (eval/exec/Function): puede eludir el análisis estático.", pattern: /\beval\s*\(|\bexec\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/ },
  { id: "exec.pickle", severity: "reject", description: "Deserialización insegura (pickle/marshal/yaml.load sin SafeLoader).", pattern: /\bpickle\.loads?\b|\bmarshal\.loads?\b|\byaml\.load\s*\((?![^)]*Safe)/ },
  { id: "exec.compile", severity: "warn", description: "Compilación de código en tiempo de ejecución (compile/exec de cadenas).", pattern: /\bcompile\s*\([^)]*["'`]|\b__import__\s*\(/i },

  // ── Crypto-miners y recursos ─────────────────────────────────────────
  { id: "miner.stratum", severity: "reject", description: "Indicaciones de pool de minería.", pattern: /stratum\+tcp:\/\/|\bxmrig\b|\bminerd\b/i },
];

const MAX_EXCERPT = 160;

/**
 * Posición de inicio de cada línea del código.
 *
 * Antes, localizar la línea de una coincidencia recorría el fichero desde el
 * principio: con veinte reglas, cincuenta coincidencias por regla y doscientos
 * mil caracteres, el gate leía cientos de millones de caracteres en el event
 * loop. Ahora se indexa una vez por fichero y cada consulta es una búsqueda
 * binaria.
 */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/** Número de línea (1-based) del índice indicado, en O(log n). */
function lineAt(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function excerptAt(source: string, index: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(source.length, index + 100);
  return source.slice(start, end).replace(/\s+/g, " ").slice(0, MAX_EXCERPT);
}

/**
 * Evalúa el código contra la denylist.
 * `reject` bloquea la ejecución; `warn` solo informa.
 */
export function analyseSource(source: string, extraFiles: Record<string, string> = {}): GateVerdict {
  const findings: GateFinding[] = [];
  const sources: Array<{ name: string; text: string }> = [{ name: "<codigo>", text: source }];
  for (const [name, text] of Object.entries(extraFiles)) sources.push({ name, text });

  for (const { name, text } of sources) {
    const starts = lineStarts(text);
    for (const rule of GATE_RULES) {
      // La regex no es global: se evalúa sobre la última coincidencia por archivo.
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", ""));
      let match = pattern.exec(text);
      let guard = 0;
      while (match && guard < 50) {
        const line = lineAt(starts, match.index);
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          description: rule.description,
          line,
          excerpt: `${name}:${line} ${excerptAt(text, match.index)}`,
        });
        guard += 1;
        match = pattern.exec(text);
      }
    }
  }

  const blocking = findings.filter((finding) => finding.severity === "reject");
  return { allowed: blocking.length === 0, findings };
}
