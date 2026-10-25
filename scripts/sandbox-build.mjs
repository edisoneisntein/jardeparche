#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Construye la imagen de sandbox para compilación (C++, Rust, Go).
 *
 * El intérprete (Python/Node) usa imágenes slim oficiales ya presentes; este
 * script cubre el toolchain compilado. La construcción requiere red (el
 * runtime NO la tiene: el sandbox se ejecuta con `--network none`).
 *
 *   pnpm sandbox:build
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = join(root, "infra/sandbox/Dockerfile");
const image = process.env.JARVIS_SANDBOX_IMAGE ?? "jarvis-sandbox:latest";

console.log(`Construyendo ${image} desde ${dockerfile}`);
console.log("La construcción usa red; el sandbox en runtime se ejecuta con --network none.\n");

const result = spawnSync(
  "docker",
  ["build", "-f", dockerfile, "-t", image, join(root, "infra/sandbox")],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  console.error("\nLa construcción falló. Las tools de compilación quedarán reportadas como no disponibles.");
  process.exit(result.status ?? 1);
}

console.log(`\nImagen ${image} lista. Configura las tools con:`);
console.log(`  JARVIS_SANDBOX_IMAGE_CPP=${image}`);
console.log(`  JARVIS_SANDBOX_IMAGE_RUST=${image}`);
console.log(`  JARVIS_SANDBOX_IMAGE_GO=${image}`);
