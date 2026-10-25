#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Modo de desarrollo HTTPS.
 *
 * El micrófono del navegador exige un ORIGEN CONFIABLE:
 *   - `http://localhost` / `http://127.0.0.1`  -> confiable sin certificado
 *   - cualquier otro origen                      -> exige HTTPS con cadena válida
 *
 * Una IP de red local por HTTP (http://192.168.x.x:5173) NO es confiable: Chrome
 * no expone `navigator.mediaDevices` y bloquea el micrófono sin que exista
 * ningún ajuste que lo revierta. Este script levanta web y servidor con un
 * certificado de mkcert (CA local confiable por el sistema) para que el
 * micrófono funcione también desde la red local.
 *
 * Requisitos: `brew install mkcert` y `mkcert -install` (una vez).
 * Uso: `pnpm dev:https`
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const certDir = join(root, ".certs");
const certFile = join(certDir, "jarvis.pem");
const keyFile = join(certDir, "jarvis-key.pem");

function lanAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      found.push(entry.address);
    }
  }
  return found;
}

function has(binary) {
  return spawnSync("which", [binary], { stdio: "ignore" }).status === 0;
}

function fail(message, detail) {
  console.error(`\n${message}\n`);
  if (detail) console.error(detail);
  process.exit(1);
}

if (!has("mkcert")) {
  fail(
    "mkcert no está instalado.",
    [
      "Instálalo y registra la CA local (una sola vez):",
      "",
      "  brew install mkcert",
      "  mkcert -install",
      "",
      "Después ejecuta de nuevo: pnpm dev:https",
      "",
      "Si solo vas a usar la aplicación en este mismo equipo, no necesitas nada de esto:",
      "abre http://localhost:5173 (el navegador ya lo considera un origen confiable).",
    ].join("\n"),
  );
}

const hosts = ["localhost", "127.0.0.1", ...lanAddresses()];
mkdirSync(certDir, { recursive: true });

if (!existsSync(certFile) || !existsSync(keyFile)) {
  console.log(`Generando certificado local para: ${hosts.join(", ")}`);
  const mkcert = spawnSync("mkcert", ["-cert-file", certFile, "-key-file", keyFile, ...hosts], { stdio: "inherit" });
  if (mkcert.status !== 0) {
    fail("mkcert no pudo generar el certificado.", "Revisa que `mkcert -install` se haya ejecutado correctamente.");
  }
} else {
  console.log(`Certificado reutilizado: ${certFile}`);
}

const env = {
  ...process.env,
  JARVIS_HTTPS_CERT: certFile,
  JARVIS_HTTPS_KEY: keyFile,
};

console.log("\nJARVIS en HTTPS");
for (const host of hosts) {
  console.log(`  web      https://${host}:5173`);
  console.log(`  api      https://${host}:8787`);
}
console.log("\nCtrl+C para detener.\n");

const children = [
  spawn("pnpm", ["--filter", "@jarvis/server", "dev"], { cwd: root, env, stdio: "inherit" }),
  spawn("pnpm", ["--filter", "@jarvis/web", "dev"], { cwd: root, env, stdio: "inherit" }),
];

const stop = () => {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`Proceso terminado con código ${code}.`);
      stop();
    }
  });
}
