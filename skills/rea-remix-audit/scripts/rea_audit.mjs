#!/usr/bin/env node
/**
 * Evidencia de REA/SIREP sobre un repositorio.
 *
 * Uso: node rea_audit.mjs <dir-repo> [ruta.zip]
 * Salida: artifacts/rea-evidence.md  (y JSON crudo por stdout con --json)
 *
 * Requisitos: REA escuchando en REA_BASE (default http://127.0.0.1:8000) con las
 * 4 reparaciones aplicadas (ver SKILL.md). Token en REA_TOKEN o en las
 * credenciales por defecto de abajo (se registran una sola vez).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO_DIR = process.argv[2] ?? process.cwd();
const ZIP = process.argv[3] ?? "/tmp/jarvis-audit.zip";
const BASE = process.env.REA_BASE ?? "http://127.0.0.1:8000";
const EMAIL = process.env.REA_EMAIL ?? "jarvis.audit@gmail.com";
const PASSWORD = process.env.REA_PASSWORD ?? "Jarvis!2026Audit#1";
const OUT_DIR = path.resolve(REPO_DIR, "skills/rea-remix-audit/artifacts");
const REPO_NAME = path.basename(path.resolve(REPO_DIR));
const EXCLUDES = ["*/node_modules/*", "*/.git/*", "*/dist/*", "*/.next/*", "*/__pycache__/*", "*/.venv/*", "*/coverage/*"];

const log = (...a) => console.error("[rea-audit]", ...a);

async function api(pathname, { method = "GET", body, token, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(BASE + pathname, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function token_() {
  if (process.env.REA_TOKEN) return process.env.REA_TOKEN;
  try {
    const reg = await api("/api/v1/auth/register", { method: "POST", body: { email: EMAIL, password: PASSWORD, display_name: "JARVIS Audit", organization_name: "JARVIS Lab" } });
    return reg.token;
  } catch {
    const login = await api("/api/v1/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    return login.token;
  }
}

function zipRepo() {
  const parent = path.dirname(path.resolve(REPO_DIR));
  const name = path.basename(path.resolve(REPO_DIR));
  const args = ["-rq", ZIP, name, "-x", ...EXCLUDES];
  execFileSync("zip", args, { cwd: parent });
  return ZIP;
}

async function main() {
  const token = await token_();
  log("token ok");

  const zipPath = zipRepo();
  const size = (await fs.stat(zipPath)).size;
  log(`zip ${zipPath} (${(size / 1e6).toFixed(1)} MB)`);

  const project = await api("/api/v1/projects", { method: "POST", token, body: { name: `${REPO_NAME} Audit` } });
  const form = new FormData();
  form.append("file", new Blob([await fs.readFile(zipPath)], { type: "application/zip" }), path.basename(zipPath));
  const artifact = await api(`/api/v1/projects/${project.id}/artifacts`, { method: "POST", token, form });
  log("artefacto", artifact.id);

  const analysis = await api(`/api/v1/projects/${project.id}/analyses`, { method: "POST", token, body: { artifact_id: artifact.id, deep_analysis: true } });
  log("análisis", analysis.id, "-> esperando…");

  let job;
  for (let i = 0; i < 120; i += 1) {
    const r = await api(`/api/v1/analyses/${analysis.id}`, { token });
    job = r.job;
    log(`${job.status} ${job.phase} ${job.progress_completed}/${job.progress_total}`);
    if (["COMPLETED", "COMPLETED_WITH_LIMITATIONS", "FAILED", "CANCELLED"].includes(job.status)) break;
    await new Promise((r2) => setTimeout(r2, 3000));
  }

  const [findingsResp, archResp] = await Promise.all([
    api(`/api/v1/analyses/${analysis.id}/findings`, { token }),
    api(`/api/v1/analyses/${analysis.id}/architecture`, { token }),
  ]);
  const findings = Array.isArray(findingsResp) ? findingsResp : findingsResp.items ?? findingsResp.findings ?? [];
  const nodes = archResp.nodes ?? archResp.items ?? [];

  const s = job.result_summary ?? {};
  const files = nodes.filter((n) => (n.type ?? n.node_type) === "file").map((n) => n.label ?? n.path ?? n.name);
  const evidence = `# Evidencia de REA (SIREP) — ${REPO_NAME}

## Métricas
- Archivos analizados/detectados: ${s.files_analyzed}/${s.files_detected}
- Nodos: ${s.node_count} · Aristas: ${s.edge_count} · Dependencias: ${s.dependency_count}
- Hallazgos: ${s.finding_count}
- Estado: ${job.status}
- Limitaciones: ${JSON.stringify(s.limitations ?? [])}

## Archivos (${files.length})
${files.join("\n")}

## Hallazgos
${findings.map((f) => `- [${f.severity}] ${f.category}: ${f.message ?? ""}`).join("\n")}

## Aristas por tipo
${JSON.stringify(s.edge_type_counts ?? {}, null, 2)}
`;

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "rea-evidence.md"), evidence);
  await fs.writeFile(path.join(OUT_DIR, "rea-analysis.json"), JSON.stringify({ job, findings, architecture: archResp }, null, 2));
  log(`evidencia -> ${path.join(OUT_DIR, "rea-evidence.md")}`);

  if (process.argv.includes("--json")) console.log(JSON.stringify({ project: project.id, artifact: artifact.id, analysis: analysis.id, status: job.status, summary: s }));
  if (s.files_analyzed === 0) {
    log("ADVERTENCIA: files_analyzed=0 — falta @babel/parser en la imagen de REA (ver SKILL.md). Auditoría inválida.");
    process.exitCode = 2;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
