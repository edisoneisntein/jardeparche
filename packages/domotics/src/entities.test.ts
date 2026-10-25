import { describe, expect, it } from "vitest";
import { EntityRegistry } from "./entities.js";
import type { Area, EntityRegistryItem, EntityStateChangedEvent, Scene } from "./types.js";

function entity(overrides: Partial<EntityRegistryItem> & Pick<EntityRegistryItem, "entity_id">): EntityRegistryItem {
  return {
    domain: overrides.entity_id.split(".", 1)[0] ?? "sensor",
    friendly_name: overrides.entity_id,
    state: "unknown",
    attributes: {},
    ...overrides,
  };
}

class FakeSource {
  states: EntityRegistryItem[] = [];
  registry: EntityRegistryItem[] = [];
  areas: Area[] = [];
  scenes: Scene[] = [];
  stateListener?: (event: EntityStateChangedEvent) => void;

  async get_states(): Promise<EntityRegistryItem[]> {
    return this.states;
  }

  async list_entities(): Promise<EntityRegistryItem[]> {
    return this.registry;
  }

  async list_areas(): Promise<Area[]> {
    return this.areas;
  }

  async list_scenes(): Promise<Scene[]> {
    return this.scenes;
  }

  onStateChanged(listener: (event: EntityStateChangedEvent) => void): () => void {
    this.stateListener = listener;
    return () => {
      this.stateListener = undefined;
    };
  }
}

describe("EntityRegistry", () => {
  it("sincroniza y combina registro, estados, áreas y escenas", async () => {
    const source = new FakeSource();
    source.registry = [entity({ entity_id: "light.entrada", friendly_name: "Entrada", area: "hall" })];
    source.states = [entity({ entity_id: "light.entrada", state: "on", attributes: { brightness: 80 } })];
    source.areas = [{ area_id: "hall", name: "Recibidor" }];
    source.scenes = [{ scene_id: "scene.noche", name: "Noche" }];
    const registry = new EntityRegistry(source);

    await expect(registry.sync()).resolves.toBe(1);
    expect(registry.get("light.entrada")?.state).toBe("on");
    expect(registry.get("light.entrada")?.area).toBe("hall");
    expect(registry.get("light.entrada")?.attributes.brightness).toBe(80);
    expect(registry.areas).toEqual(source.areas);
    expect(registry.scenes).toEqual(source.scenes);
  });

  it("busca por domain, area, device_class y nombre", async () => {
    const source = new FakeSource();
    source.states = [
      entity({ entity_id: "switch.bomba", friendly_name: "Bomba de riego", area: "garden", device_class: "switch" }),
      entity({ entity_id: "light.entrada", friendly_name: "Luz Entrada", area: "hall" }),
    ];
    const registry = new EntityRegistry(source);
    await registry.sync();

    expect(registry.findByDomain("switch")).toHaveLength(1);
    expect(registry.findByArea("garden")[0]?.entity_id).toBe("switch.bomba");
    expect(registry.findByDeviceClass("switch")[0]?.entity_id).toBe("switch.bomba");
    expect(registry.findByName("luz")[0]?.entity_id).toBe("light.entrada");
    expect(registry.search({ domain: "switch", area: "garden" })).toHaveLength(1);
  });

  it("detecta las capacidades por dominio", async () => {
    const source = new FakeSource();
    source.states = [
      entity({ entity_id: "switch.a" }),
      entity({ entity_id: "light.a" }),
      entity({ entity_id: "lock.a" }),
      entity({ entity_id: "climate.a" }),
      entity({ entity_id: "camera.a" }),
      entity({ entity_id: "sensor.a" }),
      entity({ entity_id: "binary_sensor.a" }),
      entity({ entity_id: "scene.a" }),
    ];
    const registry = new EntityRegistry(source);
    await registry.sync();

    expect(registry.supports("switch.a", "switch")).toBe(true);
    expect(registry.supports("light.a", "light")).toBe(true);
    expect(registry.supports("lock.a", "lock")).toBe(true);
    expect(registry.supports("climate.a", "climate")).toBe(true);
    expect(registry.supports("camera.a", "camera")).toBe(true);
    expect(registry.supports("sensor.a", "sensor")).toBe(true);
    expect(registry.supports("binary_sensor.a", "binary_sensor")).toBe(true);
    expect(registry.supports("scene.a", "scene")).toBe(true);
    expect(registry.supports("switch.a", "camera")).toBe(false);
  });

  it("aplica cambios de estado recibidos en tiempo real", async () => {
    const source = new FakeSource();
    source.states = [entity({ entity_id: "sensor.temperatura", state: "20" })];
    const registry = new EntityRegistry(source);
    await registry.sync();

    source.stateListener?.({
      type: "entity_state_changed",
      entity_id: "sensor.temperatura",
      old_state: "20",
      new_state: "21",
      changed_at: new Date().toISOString(),
    });
    expect(registry.get("sensor.temperatura")?.state).toBe("21");
  });

  it("devuelve copias de metadatos y listas cacheadas", async () => {
    const source = new FakeSource();
    source.states = [entity({ entity_id: "sensor.a", attributes: { unit: "°C" } })];
    const registry = new EntityRegistry(source);
    await registry.sync();

    const metadata = registry.getMetadata("sensor.a");
    expect(metadata).toBeDefined();
    if (!metadata) return;
    metadata.attributes.unit = "K";
    expect(registry.get("sensor.a")?.attributes.unit).toBe("°C");
    expect(registry.list()).not.toBe(registry.list());
  });
});
