import { describe, expect, it } from "vitest";
import type { ToolContext } from "@jarvis/shared";
import { createDomoticsTools } from "./tools.js";
import type { Area, CameraSnapshot, EntityRegistryItem, PerimeterMode } from "./types.js";

const context: ToolContext = {
  userId: "user-1",
  sessionId: "session-1",
  taskId: "task-1",
  correlationId: "correlation-1",
  now: () => new Date(),
};

function makeServices(configured = true): {
  hass: {
    isConfigured: () => boolean;
    call_service: (
      domain: string,
      service: string,
      data?: Record<string, unknown>,
      target?: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<unknown>;
    get_states: () => Promise<EntityRegistryItem[]>;
    list_areas: () => Promise<Area[]>;
  };
  entities: { get: (entityId: string) => EntityRegistryItem | undefined };
  perimeter: { arm: (mode: PerimeterMode) => Promise<PerimeterMode> };
  cameras: { list: () => Array<{ id: string }>; snapshot: () => Promise<CameraSnapshot> };
  calls: Array<{ domain: string; service: string; data?: Record<string, unknown>; target?: Record<string, unknown> }>;
} {
  const calls: Array<{ domain: string; service: string; data?: Record<string, unknown>; target?: Record<string, unknown> }> = [];
  const states: EntityRegistryItem[] = [
    {
      entity_id: "light.entrada",
      domain: "light",
      friendly_name: "Entrada",
      state: "off",
      attributes: {},
    },
  ];
  return {
    hass: {
      isConfigured: () => configured,
      call_service: async (domain: string, service: string, data?: Record<string, unknown>, target?: Record<string, unknown>) => {
        calls.push({ domain, service, data, target });
        return {};
      },
      get_states: async () => states,
      list_areas: async () => [{ area_id: "hall", name: "Recibidor" }],
    },
    entities: {
      get: (entityId) => states.find((entity) => entity.entity_id === entityId),
    },
    perimeter: {
      arm: async (mode: PerimeterMode) => mode,
    },
    cameras: {
      list: () => [{ id: "front" }],
      snapshot: async () => ({
        imageBase64: "aW1hZ2U=",
        width: 320,
        height: 240,
        timestamp: new Date().toISOString(),
        cameraId: "front",
      }),
    },
    calls,
  };
}

function toolByName(tools: ReturnType<typeof createDomoticsTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

describe("herramientas de domótica", () => {
  it("expone las tres herramientas con sus riesgos", () => {
    const tools = createDomoticsTools(makeServices());
    expect(tools.map((tool) => tool.name)).toEqual(["home.control", "home.list_areas", "camera.snapshot"]);
    expect(toolByName(tools, "home.control").risk).toBe("external_effect");
    expect(toolByName(tools, "home.control").requiresApproval).toBe(true);
    expect(toolByName(tools, "home.list_areas").risk).toBe("public_read");
    expect(toolByName(tools, "camera.snapshot").risk).toBe("public_read");
  });

  it("informa de indisponibilidad cuando Home Assistant no está configurado", () => {
    const tools = createDomoticsTools(makeServices(false));
    expect(toolByName(tools, "home.control").availability()).toEqual({
      available: false,
      reason: "Home Assistant no está configurado.",
    });
    expect(toolByName(tools, "home.list_areas").availability().available).toBe(false);
  });

  it("establece el estado de una entidad mediante el servicio correcto", async () => {
    const services = makeServices();
    const tool = toolByName(createDomoticsTools(services), "home.control");
    const result = await tool.execute(tool.parse({ action: "set_state", entity_id: "light.entrada", state: "on" }), context);

    expect(result.ok).toBe(true);
    expect(services.calls[0]).toMatchObject({ domain: "light", service: "turn_on" });
  });

  it("consulta el estado cacheado de una entidad", async () => {
    const tool = toolByName(createDomoticsTools(makeServices()), "home.control");
    const result = await tool.execute(tool.parse({ action: "get_state", entity_id: "light.entrada" }), context);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ entity_id: "light.entrada", state: "off" });
  });

  it("ejecuta una escena", async () => {
    const services = makeServices();
    const tool = toolByName(createDomoticsTools(services), "home.control");
    const result = await tool.execute(tool.parse({ action: "run_scene", scene_id: "scene.noche" }), context);
    expect(result.ok).toBe(true);
    expect(services.calls[0]).toMatchObject({ domain: "scene", service: "turn_on" });
  });

  it("arma el perímetro en el modo solicitado", async () => {
    const tool = toolByName(createDomoticsTools(makeServices()), "home.control");
    const result = await tool.execute(tool.parse({ action: "arm_perimeter", mode: "away" }), context);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ mode: "away" });
  });

  it("lista áreas como una lectura pública", async () => {
    const tool = toolByName(createDomoticsTools(makeServices()), "home.list_areas");
    const result = await tool.execute(tool.parse({}), context);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ count: 1 });
  });

  it("captura una cámara y devuelve la instantánea", async () => {
    const tool = toolByName(createDomoticsTools(makeServices()), "camera.snapshot");
    const result = await tool.execute(tool.parse({ camera_id: "front" }), context);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ cameraId: "front", width: 320 });
  });

  it("devuelve un error controlado cuando falta un argumento", async () => {
    const tool = toolByName(createDomoticsTools(makeServices()), "home.control");
    const result = await tool.execute(tool.parse({ action: "set_state", entity_id: "light.entrada" }), context);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_input");
  });
});
