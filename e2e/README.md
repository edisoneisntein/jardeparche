# Pruebas E2E (Playwright)

Pruebas de extremo a extremo sobre la UI real de JARVIS en `http://localhost:5173`. Verifican **comportamiento visible para el usuario**, nunca el contenido del modelo (es no determinista).

## Qué verifica cada test

| Test | Requiere clave NIM | Qué comprueba |
| --- | --- | --- |
| `la pantalla de arranque muestra estados de salud reales` | No | Que el HUD renderiza estados reales (`up`/`degraded`/`down`/`unknown`), no un "todo operativo" fijo |
| `enviar un mensaje muestra burbuja de usuario y respuesta o error` (@live) | Sí | Que el mensaje se envía, aparece la burbuja del usuario y llega respuesta del asistente **o** un error visible |
| `una tool en ejecución muestra una tarjeta de herramienta` (@live) | Sí | Que al ejecutarse una tool aparece una tarjeta de herramienta |
| `una tool destructiva muestra el diálogo de aprobación` (@live) | Sí | Que `memory.forget` (riesgo `destructive`) bloquea y muestra el diálogo de aprobación |

Los tests @live se ejecutan solo si `NVIDIA_API_KEY` está exportada en el entorno; si no, se marcan como **skipped**.

## Requisitos previos

1. Node >= 20.11 y pnpm.
2. Navegador de Playwright instalado:

   ```bash
   pnpm exec playwright install chromium
   ```

   Si `@playwright/test` no está en las dependencias del repo, añádelo antes (no se ejecutó ninguna instalación al escribir esta guía).

3. El stack de desarrollo **ya corriendo** (el `playwright.config.ts` tiene `webServer` desactivado a propósito):

   ```bash
   docker compose up -d db
   pnpm dev
   ```

4. Para los tests @live, la clave exportada (el runner no lee `.env` solo):

   ```bash
   export NVIDIA_API_KEY=nvapi-...
   ```

## Cómo ejecutarlos

```bash
# Todos (los @live se saltan sin clave)
pnpm exec playwright test

# Solo los que no necesitan clave
pnpm exec playwright test --grep-invert @live

# Solo los @live
export NVIDIA_API_KEY=nvapi-...
pnpm exec playwright test --grep @live

# Un archivo / un test
pnpm exec playwright test e2e/jarvis.spec.ts
pnpm exec playwright test --grep "diálogo de aprobación"
```

Reporte HTML tras un fallo:

```bash
pnpm exec playwright show-report
```

## Configuración

- `playwright.config.ts` (raíz): `testDir: ./e2e`, `baseURL` configurable con `E2E_BASE_URL`, `workers: 1`, timeouts generosos (120 s de test, 20 s de expectativa) y **sin `webServer`**.
- Los tests usan selectores por rol/texto y atributos habituales (`data-testid`, `data-role`) para ser resilientes a cambios de estilo.

## Troubleshooting

- **`webServer` no arranca nada**: es intencional. Levanta `pnpm dev` por tu cuenta.
- **`locator not found`**: la UI puede usar textos/atributos distintos. Ajusta los selectores en `jarvis.spec.ts` (los tests están escritos para tolerar variantes).
- **Los @live se saltan**: falta `export NVIDIA_API_KEY=...` en la misma shell.
- **Timeout esperando respuesta**: comprueba la sonda real con `pnpm --filter @jarvis/ai-provider probe`; si el modelo no responde, el test fallará por causa del backend, no de la UI.
