import { migratePostgres } from "@jarvis/memory";
import { loadAppConfig } from "../src/config.js";

/**
 * Aplica las migraciones del esquema.
 *
 * ARCH-002: el script invoca el MISMO gestor de migraciones que usa el
 * servidor al arrancar (`migratePostgres`), sin depender de ficheros `.sql`
 * duplicados en el build. Las migraciones se aplican en una transacción: si
 * una falla, no queda el esquema a medias.
 */
async function main() {
  const config = loadAppConfig();
  if (config.persistence !== "postgres") {
    console.log("PERSISTENCE no es postgres; no hay migraciones que aplicar.");
    return;
  }
  if (!config.databaseUrl) throw new Error("DATABASE_URL es obligatorio para migrar");
  const applied = await migratePostgres(config.databaseUrl);
  console.log(applied.length > 0 ? `migraciones aplicadas: ${applied.join(", ")}` : "esquema al día: no había migraciones pendientes");
}

main().catch((error) => {
  console.error("migración fallida:", (error as Error).message);
  process.exit(1);
});
