import { defineConfig } from "vitest/config";

/**
 * Configuración local de Vitest para que el script del paquete descubra las
 * suites de `src` sin depender del directorio de trabajo del monorepo.
 */
export default defineConfig({
  test: {
    name: "unit",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
