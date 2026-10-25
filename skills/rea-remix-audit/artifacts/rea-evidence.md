# Evidencia de REA (SIREP) sobre el repositorio JARVIS

## Métricas del análisis
- Archivos detectados/analizados: 104/104
- Nodos: 413 (símbolos: 245) · Aristas: 749
- Dependencias: 67 · Hallazgos: 16

## Archivos analizados (104)
jarvis-main/apps/server/scripts/db-migrate.ts
jarvis-main/apps/server/src/app.ts
jarvis-main/apps/server/src/config.ts
jarvis-main/apps/server/src/health.ts
jarvis-main/apps/server/src/hub.ts
jarvis-main/apps/server/src/index.ts
jarvis-main/apps/server/src/logger.ts
jarvis-main/apps/server/src/metrics.ts
jarvis-main/apps/web/src/App.tsx
jarvis-main/apps/web/src/api/client.ts
jarvis-main/apps/web/src/components/fx/HoloDeck.tsx
jarvis-main/apps/web/src/components/fx/HolographicDiagnostics.tsx
jarvis-main/apps/web/src/components/fx/ParticleVeil.tsx
jarvis-main/apps/web/src/components/fx/ScanOverlay.tsx
jarvis-main/apps/web/src/components/hud/ActivityPanel.tsx
jarvis-main/apps/web/src/components/hud/ApprovalModal.tsx
jarvis-main/apps/web/src/components/hud/BootScreen.tsx
jarvis-main/apps/web/src/components/hud/CameraPanel.tsx
jarvis-main/apps/web/src/components/hud/CapabilitiesPanel.tsx
jarvis-main/apps/web/src/components/hud/Composer.tsx
jarvis-main/apps/web/src/components/hud/Conversation.tsx
jarvis-main/apps/web/src/components/hud/Header.tsx
jarvis-main/apps/web/src/components/hud/HealthStrip.tsx
jarvis-main/apps/web/src/components/hud/IntroSequence.tsx
jarvis-main/apps/web/src/components/hud/SettingsPanel.tsx
jarvis-main/apps/web/src/components/hud/icons.tsx
jarvis-main/apps/web/src/components/reactor/Reactor.tsx
jarvis-main/apps/web/src/components/reactor/ReactorScene.tsx
jarvis-main/apps/web/src/components/voice/VoiceVisualizer.tsx
jarvis-main/apps/web/src/hooks/useAgentVisualState.ts
jarvis-main/apps/web/src/hooks/useCamera.ts
jarvis-main/apps/web/src/hooks/useCapabilities.ts
jarvis-main/apps/web/src/hooks/useClock.ts
jarvis-main/apps/web/src/hooks/useDictation.ts
jarvis-main/apps/web/src/hooks/useHealthPolling.ts
jarvis-main/apps/web/src/hooks/useJarvisConnection.ts
jarvis-main/apps/web/src/hooks/useMediaQuery.ts
jarvis-main/apps/web/src/hooks/useMicLevel.ts
jarvis-main/apps/web/src/hooks/useReducedMotion.ts
jarvis-main/apps/web/src/hooks/useSessionBootstrap.ts
jarvis-main/apps/web/src/hooks/useSpeechRecognition.ts
jarvis-main/apps/web/src/lib/audioEngine.ts
jarvis-main/apps/web/src/lib/events.ts
jarvis-main/apps/web/src/lib/format.ts
jarvis-main/apps/web/src/lib/health.ts
jarvis-main/apps/web/src/lib/ids.ts
jarvis-main/apps/web/src/lib/tts.ts
jarvis-main/apps/web/src/main.tsx
jarvis-main/apps/web/src/state/jarvisStore.ts
jarvis-main/apps/web/src/state/serverEvents.ts
jarvis-main/apps/web/src/state/settings.ts
jarvis-main/apps/web/src/types/web-speech.d.ts
jarvis-main/apps/web/src/vite-env.d.ts
jarvis-main/apps/web/vite.config.ts
jarvis-main/e2e/jarvis.spec.ts
jarvis-main/packages/agent-runtime/src/approval-broker.ts
jarvis-main/packages/agent-runtime/src/index.ts
jarvis-main/packages/agent-runtime/src/prompt.ts
jarvis-main/packages/agent-runtime/src/runtime.test.ts
jarvis-main/packages/agent-runtime/src/runtime.ts
jarvis-main/packages/agent-runtime/src/state-machine.ts
jarvis-main/packages/ai-provider/scripts/probe.ts
jarvis-main/packages/ai-provider/src/config.ts
jarvis-main/packages/ai-provider/src/errors.ts
jarvis-main/packages/ai-provider/src/fake-provider.ts
jarvis-main/packages/ai-provider/src/index.ts
jarvis-main/packages/ai-provider/src/nim-provider.integration.test.ts
jarvis-main/packages/ai-provider/src/nim-provider.test.ts
jarvis-main/packages/ai-provider/src/nim-provider.ts
jarvis-main/packages/ai-provider/src/types.ts
jarvis-main/packages/ai-provider/src/unavailable-provider.ts
jarvis-main/packages/memory/scripts/copy-sql.mjs
jarvis-main/packages/memory/src/create-store.ts
jarvis-main/packages/memory/src/index.ts
jarvis-main/packages/memory/src/memory-service.test.ts
jarvis-main/packages/memory/src/memory-service.ts
jarvis-main/packages/memory/src/memory-store.ts
jarvis-main/packages/memory/src/postgres-store.ts
jarvis-main/packages/memory/src/schema.ts
jarvis-main/packages/memory/src/text.ts
jarvis-main/packages/perception/src/index.ts
jarvis-main/packages/perception/src/perception-service.test.ts
jarvis-main/packages/perception/src/perception-service.ts
jarvis-main/packages/shared/src/chat.ts
jarvis-main/packages/shared/src/events.ts
jarvis-main/packages/shared/src/health.ts
jarvis-main/packages/shared/src/index.ts
jarvis-main/packages/shared/src/state.ts
jarvis-main/packages/shared/src/tools.ts
jarvis-main/packages/tool-registry/src/builtin/calculator.ts
jarvis-main/packages/tool-registry/src/builtin/datetime-system.ts
jarvis-main/packages/tool-registry/src/builtin/documents.ts
jarvis-main/packages/tool-registry/src/builtin/index.ts
jarvis-main/packages/tool-registry/src/builtin/memory-tools.ts
jarvis-main/packages/tool-registry/src/builtin/tasks.ts
jarvis-main/packages/tool-registry/src/builtin/web-search.ts
jarvis-main/packages/tool-registry/src/index.ts
jarvis-main/packages/tool-registry/src/registry.test.ts
jarvis-main/packages/tool-registry/src/registry.ts
jarvis-main/packages/tool-registry/src/types.ts
jarvis-main/packages/voice/src/index.ts
jarvis-main/packages/voice/src/voice-service.ts
jarvis-main/playwright.config.ts
jarvis-main/vitest.workspace.ts

## Hallazgos registrados
- [INFO] LANGUAGE: Se detectó código javascript en 1 archivo(s).
- [INFO] LANGUAGE: Se detectó código typescript en 103 archivo(s).
- [INFO] ENTRY_POINT: Punto de entrada detectado.
- [INFO] TEST: Archivo de pruebas detectado.
- [INFO] ENVIRONMENT_VARIABLE: Variable de entorno referenciada: NVIDIA_API_KEY
- [INFO] TEST: Archivo de pruebas detectado.
- [INFO] TEST: Archivo de pruebas detectado.
- [INFO] ENVIRONMENT_VARIABLE: Variable de entorno referenciada: NVIDIA_API_KEY
- [INFO] TEST: Archivo de pruebas detectado.
- [INFO] TEST: Archivo de pruebas detectado.
- [INFO] TEST: Archivo de pruebas detectado.
- [INFO] TEST: Archivo de pruebas detectado.
- [INFO] ENTRY_POINT: Punto de entrada detectado.
- [INFO] ENVIRONMENT_VARIABLE: Variable de entorno referenciada: CI
- [INFO] ENVIRONMENT_VARIABLE: Variable de entorno referenciada: E2E_BASE_URL
- [INFO] ENTRY_POINT: Punto de entrada detectado.

## Tipos de aristas
{
  "declares_dependency": 67,
  "imports_external": 203,
  "is_entrypoint": 3,
  "reads_env": 4,
  "depends_on": 120,
  "defines": 245,
  "is_test": 7,
  "imports": 100
}
