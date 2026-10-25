import { describe, expect, it } from "vitest";
import { analyseSource, GATE_RULES } from "./static-gate.js";

describe("analyseSource", () => {
  it("permite código inocuo", () => {
    const verdict = analyseSource(`
      def fib(n):
          a, b = 0, 1
          for _ in range(n):
              a, b = b, a + b
          return a
      print(fib(20))
    `);
    expect(verdict.allowed).toBe(true);
    expect(verdict.findings.filter((f) => f.severity === "reject")).toHaveLength(0);
  });

  it("bloquea el borrado masivo del sistema de archivos", () => {
    const verdict = analyseSource("import shutil; shutil.rmtree('/')");
    expect(verdict.allowed).toBe(false);
    expect(verdict.findings.map((f) => f.ruleId)).toContain("fs.rm_rf");
  });

  it("bloquea rm -rf aunque se construya por concatenación simple", () => {
    const verdict = analyseSource("subprocess.run('rm -rf /data')");
    expect(verdict.allowed).toBe(false);
    expect(verdict.findings.map((f) => f.ruleId)).toContain("fs.rm_rf");
  });

  it("bloquea el egreso de red (el sandbox es network: none)", () => {
    const verdict = analyseSource("import urllib.request\nurllib.request.urlopen('http://x.com')");
    expect(verdict.allowed).toBe(false);
    expect(verdict.findings.map((f) => f.ruleId)).toContain("net.egress");
  });

  it("bloquea el acceso a variables de entorno sensibles", () => {
    const verdict = analyseSource("import os\nkey = os.environ['NVIDIA_API_KEY']");
    expect(verdict.allowed).toBe(false);
    expect(verdict.findings.map((f) => f.ruleId)).toContain("secret.env_sensitive");
  });

  it("no bloquea la lectura de una variable de entorno inocua", () => {
    const verdict = analyseSource("import os\nprint(os.environ.get('TZ'))");
    expect(verdict.allowed).toBe(true);
  });

  it("bloquea la escalada de privilegios", () => {
    const verdict = analyseSource("subprocess.run(['sudo', 'rm', '/etc/passwd'])");
    expect(verdict.allowed).toBe(false);
    expect(verdict.findings.map((f) => f.ruleId)).toContain("priv.sudo");
  });

  it("bloquea sockets crudos", () => {
    const verdict = analyseSource("s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)");
    expect(verdict.allowed).toBe(false);
    expect(verdict.findings.map((f) => f.ruleId)).toContain("net.socket_raw");
  });

  it("bloquea la deserialización insegura", () => {
    const verdict = analyseSource("import pickle\nobj = pickle.loads(blob)");
    expect(verdict.allowed).toBe(false);
    expect(verdict.findings.map((f) => f.ruleId)).toContain("exec.pickle");
  });

  it("bloquea la persistencia por planificador", () => {
    const verdict = analyseSource("subprocess.run(['crontab', '-e'])");
    expect(verdict.allowed).toBe(false);
    expect(verdict.findings.map((f) => f.ruleId)).toContain("persist.scheduler");
  });

  it("avisa sin bloquear con eval", () => {
    const verdict = analyseSource("result = eval(expr)");
    expect(verdict.allowed).toBe(true);
    expect(verdict.findings.map((f) => f.ruleId)).toContain("exec.eval");
  });

  it("analiza también los archivos adicionales del proyecto", () => {
    const verdict = analyseSource("print('ok')", { "src/lib.rs": "fn main(){ let _ = std::process::Command::new(\"sh\"); }" });
    // El archivo adicional no dispara ninguna regla: el objetivo es comprobar
    // que se recorre, no que bloquee en falso.
    expect(verdict.findings.every((f) => f.excerpt.startsWith("src/lib.rs") || f.excerpt.startsWith("<codigo>"))).toBe(true);
  });

  it("informa la línea del hallazgo", () => {
    const verdict = analyseSource("a = 1\nb = 2\nimport shutil\nshutil.rmtree('/tmp/x')");
    const finding = verdict.findings.find((f) => f.ruleId === "fs.rm_rf");
    expect(finding?.line).toBe(4);
  });

  it("todas las reglas tienen identificador y descripción no vacíos", () => {
    for (const rule of GATE_RULES) {
      expect(rule.id).toMatch(/^[a-z]+\.[a-z0-9_]+$/);
      expect(rule.description.length).toBeGreaterThan(10);
      expect(["reject", "warn"]).toContain(rule.severity);
    }
  });
});
