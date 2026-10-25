import { expect, test } from "@playwright/test";

/**
 * Pruebas E2E de JARVIS sobre la UI real (http://localhost:5173).
 *
 * Principios:
 *  - Se verifica COMPORTAMIENTO VISIBLE para el usuario, no detalles internos.
 *  - NO se afirma sobre el contenido del modelo (es no determinista).
 *  - Selectores resilientes (roles/texto) y timeouts generosos.
 *  - Los tests etiquetados @live requieren una NVIDIA_API_KEY real exportada.
 *
 * Requisito previo: `docker compose up -d db && pnpm dev` y navegador instalado.
 */

const ASSISTANT_BUBBLE =
  '[data-role="assistant"], [data-testid="assistant-message"], [data-testid="assistant-bubble"]';
const TOOL_CARD =
  '[data-tool-call], [data-role="tool"], [data-testid="tool-card"], [data-testid="tool-call"]';
const APPROVAL_DIALOG =
  '[data-testid="approval-dialog"], [role="alertdialog"], [role="dialog"]';

async function chatInput(page: import("@playwright/test").Page) {
  return page
    .getByRole("textbox")
    .or(page.getByPlaceholder(/pregunta|escribe|mensaje|habla|comando/i))
    .first();
}

async function sendMessage(page: import("@playwright/test").Page, text: string) {
  const input = await chatInput(page);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

// ─────────────────────────────────────────────────────────────────────
// No requiere clave: la pantalla debe mostrar estados de salud reales.
// ─────────────────────────────────────────────────────────────────────
test("la pantalla de arranque muestra estados de salud reales", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: /jarvis/i }).first(),
  ).toBeVisible({ timeout: 30_000 });

  const healthPanel = page
    .getByTestId("health-panel")
    .or(page.getByRole("region", { name: /salud|estado|health|sistema|diagn/i }))
    .or(page.getByRole("dialog", { name: /salud|estado|health/i }));

  await expect(healthPanel.first()).toBeVisible({ timeout: 30_000 });

  // Debe renderizar estados reales (incluido "unknown"), no un "todo OK" fijo.
  await expect(healthPanel.first()).toContainText(
    /up|degraded|down|unknown|operativ|degradad|caíd|desconocid|conectad|sin conexi|no disponible|n\/a/i,
  );
});

test.describe("@live requiere NVIDIA_API_KEY", () => {
  test.skip(
    !process.env.NVIDIA_API_KEY,
    "Requiere NVIDIA_API_KEY viva exportada en el entorno (ver e2e/README.md).",
  );

  test("enviar un mensaje muestra burbuja de usuario y respuesta o error", async ({ page }) => {
    await page.goto("/");

    const prompt = "Hola JARVIS, responde con una sola frase corta.";
    await sendMessage(page, prompt);

    // La burbuja del usuario aparece con el texto enviado.
    await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 30_000 });

    // Y llega una respuesta del asistente O un error visible. No se valida el contenido.
    const assistant = page.locator(ASSISTANT_BUBBLE).first();
    const error = page.getByText(/error|no disponible|fall[oó]|failed|sin conexi/i).first();
    await expect(assistant.or(error)).toBeVisible({ timeout: 90_000 });
  });

  test("una tool en ejecución muestra una tarjeta de herramienta", async ({ page }) => {
    await page.goto("/");

    await sendMessage(
      page,
      "¿Qué hora es ahora? Usa la herramienta time.now para responder.",
    );

    const toolCard = page
      .locator(TOOL_CARD)
      .or(page.getByRole("listitem").filter({ hasText: /time\.now|herramienta|tool/i }));

    await expect(toolCard.first()).toBeVisible({ timeout: 90_000 });
  });

  test("una tool destructiva muestra el diálogo de aprobación", async ({ page }) => {
    await page.goto("/");

    await sendMessage(
      page,
      'Llama a la herramienta memory.forget con el id "demo-no-existe-123". Debes usar la herramienta.',
    );

    const dialog = page
      .locator(APPROVAL_DIALOG)
      .or(page.getByText(/aprobaci[oó]n|requiere aprobaci|autoriz|approval/i));

    await expect(dialog.first()).toBeVisible({ timeout: 90_000 });

    // Limpieza: denegar para no ejecutar nada.
    const deny = page
      .getByRole("button", { name: /rechazar|denegar|cancelar|no aprobar|deny/i })
      .first();
    if (await deny.isVisible().catch(() => false)) {
      await deny.click();
    }
  });
});
