import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * HTTPS opcional para el HUD.
 *
 * El navegador solo concede el micrófono en orígenes de confianza. `localhost`
 * ya lo es por HTTP; una IP de red local no lo es, así que `pnpm dev:https`
 * arranca el servidor con un certificado local (mkcert) para que el micrófono
 * funcione también desde la LAN.
 */
const certFile = process.env.JARVIS_HTTPS_CERT;
const keyFile = process.env.JARVIS_HTTPS_KEY;
const https = certFile && keyFile && existsSync(certFile) && existsSync(keyFile)
  ? { key: readFileSync(keyFile), cert: readFileSync(certFile) }
  : undefined;

/**
 * Secretos del servidor que NUNCA deben poder leerse desde el navegador.
 *
 * El bundle web es público: lo sirve nginx sin autenticación. Si un secreto
 * del servidor llegara al bundle, cualquiera que abra el HUD se lo lleva.
 */
const SERVER_SECRETS = [
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "JARVIS_ACCESS_TOKEN",
  "DATABASE_URL",
  "WEB_SEARCH_API_KEY",
  "ENDLESS_API_KEY",
] as const;

/**
 * Falla la build si el cliente intenta leer un secreto del servidor.
 *
 * Sin esto, `import.meta.env.NVIDIA_API_KEY` se compila a `undefined` (Vite
 * solo expone los prefijos permitidos) y el fallo aparece en PRODUCCIÓN, en
 * silencio, cuando ya no hay forma de arreglarlo sin tocar el bundle.
 */
function blockServerSecrets() {
  return {
    name: "jarvis:block-server-secrets",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.includes("/src/") || !code.includes("import.meta.env")) return null;
      for (const secret of SERVER_SECRETS) {
        if (code.includes(`import.meta.env.${secret}`)) {
          this.error(
            `El cliente no puede leer ${secret}: es un secreto del servidor y "import.meta.env.${secret}" no existe en el bundle.`,
          );
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  /**
   * SEC-001 · Aislamiento del entorno en el bundle del navegador.
   *
   * `envPrefix` decide qué variables de `process.env` pueden leerse desde el
   * código del cliente. Se fija EXCLUSIVAMENTE en `VITE_`: cualquier otra
   * variable (y en particular `NVIDIA_API_KEY`, `JARVIS_ACCESS_TOKEN` o
   * `DATABASE_URL`) queda fuera del bundle por definición, no por costumbre.
   *
   * El plugin `blockServerSecrets` es la red de seguridad: si alguien escribe
   * `import.meta.env.NVIDIA_API_KEY` en el cliente, la build FALLA en vez de
   * compilar un `undefined` silencioso que esconde el error de seguridad.
   */
  envPrefix: ["VITE_"],
  plugins: [react(), blockServerSecrets()],
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    https,
  },
  preview: {
    port: 4173,
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
