import { MemoryStore } from "./memory-store.js";
import { PostgresStore } from "./postgres-store.js";
import type { Store } from "./schema.js";

export interface CreateStoreOptions {
  mode: "memory" | "postgres";
  databaseUrl?: string;
}

export async function createStore(options: CreateStoreOptions): Promise<Store> {
  if (options.mode === "postgres") {
    if (!options.databaseUrl) throw new Error("DATABASE_URL is required when PERSISTENCE=postgres");
    const store = new PostgresStore({ connectionString: options.databaseUrl });
    await store.init();
    return store;
  }
  const store = new MemoryStore();
  await store.init();
  return store;
}
