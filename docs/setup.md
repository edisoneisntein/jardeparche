# Instalación y puesta en marcha

Guía paso a paso para levantar JARVIS, obtener la clave de NVIDIA NIM, ejecutar sin Postgres, lanzar la sonda de capacidades y correr los tests.

---

## 1. Requisitos

| Herramienta | Versión |
| --- | --- |
| Node.js | >= 20.11 |
| pnpm | 12 (`corepack enable`) |
| Docker + Docker Compose | para PostgreSQL + pgvector |
| Clave NVIDIA NIM | desde [build.nvidia.com](https://build.nvidia.com) (formato `nvapi-...`) |

No se necesita clave para ejecutar `pnpm test:unit` ni el modo `PERSISTENCE=memory` (aunque sin clave no habrá respuestas reales del modelo).

---

## 2. Obtener la clave NVIDIA NIM

1. Entra en [build.nvidia.com](https://build.nvidia.com) e inicia sesión.
2. Abre un modelo (p. ej. `nvidia/nemotron-3.5-lightning-30b-a3b`) y pulsa *Get API Key*.
3. Copia la clave `nvapi-...`.

La base URL por defecto es `https://integrate.api.nvidia.com/v1`.

> Los modelos disponibles dependen de la cuenta. Verifica siempre con la sonda antes de asumir capacidades: algunos modelos devuelven `404` (no disponibles) o `410` (end-of-life) para esta cuenta.

---

## 3. Configurar el entorno

```bash
cp .env.example .env
```

Edita `.env` y, como mínimo:

```bash
NVIDIA_API_KEY=nvapi-...
```

Valores por defecto relevantes:

```bash
NVIDIA_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
NVIDIA_VISION_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b
NVIDIA_EMBEDDING_MODEL=nvidia/nemotron-3-embed-1b   # 2048 dimensiones
DATABASE_URL=postgres://jarvis:jarvis@localhost:55432/jarvis
PERSISTENCE=postgres
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

No edites `.env.example`; es la plantilla.

---

## 4. Arrancar la base de datos

```bash
docker compose up -d db
docker compose ps          # espera a que db esté "healthy"
```

La base publica `55432:5432` porque el puerto `5432` ya está ocupado por otro proyecto en esta máquina. La imagen es `pgvector/pgvector:pg16` porque la memoria semántica necesita `CREATE EXTENSION vector`.

---

## 5. Instalar dependencias, migrar y arrancar

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

- `pnpm db:migrate` aplica `packages/memory/src/sql/001_init.sql` y `002_semantic.sql`.
- `pnpm dev` levanta `@jarvis/server` en `http://localhost:8787` y `@jarvis/web` en `http://localhost:5173`.

Abre `http://localhost:5173`.

---

## 6. Ejecutar sin PostgreSQL (no durable)

```bash
PERSISTENCE=memory pnpm dev
```

`MemoryStore` implementa el contrato completo de `Store`, pero **todo se pierde al reiniciar**. Úsalo para desarrollo o demos, nunca como memoria persistente. Con este modo no necesitas arrancar `db`.

---

## 7. Sonda de capacidades en vivo

Antes de culpar a la UI, comprueba que el cerebro responde **de verdad**:

```bash
pnpm --filter @jarvis/ai-provider probe
```

Hace lo siguiente:

1. Imprime el modelo de chat y de visión configurados.
2. `health()` contra `GET /models` (reintentos incluidos).
3. `probeCapabilities()`: comprueba **streaming** y **tool calling** contra la cuenta real.
4. Sale con código ≠ 0 si la salud falla o si streaming/tools no se confirman.

La salida debe parecerse a:

```
chat model:    nvidia/nemotron-3.5-lightning-30b-a3b
vision model:  nvidia/nemotron-3.5-super-vl-120b-a12b
health: UP - NVIDIA NIM reachable (412ms)
capabilities: { "source": "probe", "streaming": true, "tools": true, ... }
```

---

## 8. Tests

```bash
pnpm test:unit          # unit: no requiere credenciales ni red
pnpm test:integration   # integración NVIDIA: se omite sin NVIDIA_API_KEY
pnpm verify             # typecheck + unit
```

- **Unit** (`packages/**/test`, `packages/**/src/**/*.test.ts`): siempre corre. Cubre memoria (aislamiento, recall, purga), registry (validación, disponibilidad, timeouts, aprobación), provider con `FakeProvider` y clasificación de errores.
- **Integración** (`**/*.integration.test.ts`): `nim-provider.integration.test.ts` se **salta automáticamente** si `NVIDIA_API_KEY` no está presente (`describe.skip`), así que nunca falla por falta de credenciales. Con clave, verifica health, chat, streaming, tool calling y embeddings.

Para ejecutar la integración con clave desde un `.env`, expórtala en la shell (el runner no lee `.env` solo):

```bash
export $(grep -v '^#' .env | xargs) && pnpm test:integration
```

---

## 9. Comprobar la persistencia (criterio de aceptación 5)

```bash
# Crea una sesión, habla con JARVIS, pide una tarea, ejecuta una tool.
# Luego reinicia el server (Ctrl-C y `pnpm dev`) y verifica en la base:

docker exec -it jarvis-db psql -U jarvis -d jarvis \
  -c "SELECT key, value, source FROM jarvis_semantic_memories;" \
  -c "SELECT name, status, duration_ms FROM jarvis_tool_calls ORDER BY started_at DESC LIMIT 5;"
```

Solo deben persistir las **memorias autorizadas** y las sesiones/tareas guardadas. El estado efímero no se inventa al reiniciar.

---

## 10. Micrófono: requisito de origen confiable

El reconocimiento de voz se ejecuta en el navegador (Web Speech API). Chrome solo concede el micrófono en un **origen confiable**, y esa condición no es negociable desde la interfaz:

| URL | Contexto seguro | `navigator.mediaDevices` | Micrófono |
| --- | --- | --- | --- |
| `http://localhost:5173` | sí | disponible | funciona |
| `http://127.0.0.1:5173` | sí | disponible | funciona |
| `http://192.168.x.x:5173` | **no** | **ausente** | **bloqueado** |
| `https://<host>:5173` | sí | disponible | funciona |

En un origen no confiable Chrome **no expone `navigator.mediaDevices`** y el motor de voz responde `not-allowed`. No existe un ajuste del sitio que lo revierta: el bloqueo es del origen, no del permiso. Por eso el HUD distingue las dos causas y, cuando el origen no es confiable, ofrece abrir la aplicación en `localhost`.

### 10.1 Uso en este equipo (sin configuración)

```bash
pnpm dev
# abre http://localhost:5173  (no la IP de la red local)
```

Chrome muestra el aviso de permiso la primera vez. Si lo denegaste, restitúyelo desde el icono de bloqueo de la barra de direcciones → «Micrófono» → «Permitir», y pulsa **Reintentar** en el HUD.

### 10.2 Acceso desde la red local

Para usar el micrófono desde otra IP hace falta un origen confiable. Dos vías:

**a) HTTPS con CA local (`pnpm dev:https`)**

```bash
brew install mkcert
mkcert -install          # una sola vez; registra la CA local en el sistema
pnpm dev:https
```

Genera el certificado en `.certs/` para `localhost`, `127.0.0.1` y las IPv4 de la red local, y levanta web (`5173`) y API (`8787`) por HTTPS. Añade el origen a `ALLOWED_ORIGINS`:

```
ALLOWED_ORIGINS=https://localhost:5173,https://127.0.0.1:5173,https://192.168.1.8:5173
```

**b) Marcar el origen como confiable en Chrome (sin tocar el sistema)**

```bash
# macOS: edita el "Atajo de aplicaciones" de Chrome o ejecútalo con:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --unsafely-treat-insecure-origin-as-secure=http://192.168.1.8:5173
```

Equivale a la opción de `chrome://flags` → «Insecure origins treated as secure». Con el origen marcado, Chrome habilita `navigator.mediaDevices` y pide el permiso con normalidad.

### 10.3 Verificación

```bash
curl -s http://localhost:8787/api/voice | jq .
# stt/tts = browser, browserSupported = true, health.status = unknown
# "unknown" es correcto: el servidor no puede verificar el micrófono del navegador.
```

---

## 11. Voz en el servidor

La síntesis de voz se hace **en el servidor**. Hay cuatro motores y se eligen
con `VOICE_TTS_ENGINE`:

```
VOICE_TTS_ENGINE=kokoro            # say | kokoro | qwen | bank
VOICE_TTS_KOKORO_URL=http://127.0.0.1:8788
VOICE_TTS_KOKORO_VOICE=em_alex      # em_alex (hombre, es) · em_santa · ef_dora
VOICE_TTS_MAX_SENTENCE_CHARS=140   # tamaño máximo de la frase sintetizada
VOICE_TTS_MAX_PENDING_CHARS=60
VOICE_TTS_NAME=                    # solo para el motor "say"
VOICE_TTS_CACHE_DIR=               # caché de frases repetidas (opcional)
VOICE_FAST_TURNS=true              # turnos de voz sin razonamiento del modelo
```

### Qué motor usar (medido en un i5-7500 de 4 hilos, sin GPU)

| motor | voz | 1ª frase | calidad | coste |
| :--- | :--- | ---: | :--- | :--- |
| `say` | voces de macOS (Reed, Mónica) | ~500 ms | **robótica** | 0 |
| **`kokoro`** | **em_alex** (red neuronal, hombre, español) | **~1 s** | **natural** | 0, local |
| `qwen` | **voz clonada** (Qwen3-TTS) | **82 s** | la del clon | 0 |
| `bank` | voz clonada pregrabada | 0 ms | la del clon | 0, offline |

- **`kokoro` es el que se usa por defecto.** Es un modelo neuronal de 82 M
  parámetros (ONNX) que corre en local: voz masculina real en español, sin
  roboticidad y sin depender de las voces instaladas. Arranque:

  ```bash
  pnpm voice:server      # .venv-voice/bin/python scripts/kokoro-voice-server.py
  ```

  El modelo se queda en memoria en ese proceso (por eso hay un servicio y no
  un comando): cargarlo cuesta ~3 s, y por frase ~1 s (1x tiempo real).

- **`qwen` es la voz clonada** (la app "Clonar voz": Qwen3-TTS en GGUF). Es
  la mejor voz posible y, a la vez, **inviable en esta máquina**: 82 s por
  frase, porque el modelo va por CPU. En un equipo con GPU sí sirve en
  directo; aquí solo sirve **offline** (ver más abajo el banco de frases).

- **`bank` reproduce frases ya grabadas con la voz clonada**, con latencia
  cero. Es la forma de tener la voz exacta del clon sin pagar los 82 s:

  ```bash
  pnpm voice:bank       # pregraba las frases del banco (offline, ~85 s cada una)
  ```

  El banco es incremental: las frases ya grabadas no se vuelven a hacer.

### Cómo funciona

1. El modelo escribe la respuesta en streaming (`assistant.delta`).
2. El servidor acumula el texto y, **cada vez que una frase se cierra**, la
   sintetiza y la envía (`voice.audio.segment`).
3. El cliente reproduce las frases en cola: **la primera suena mientras la
   segunda se sigue sintetizando**.

La síntesis de varias frases corre **en paralelo** (la emisión mantiene el
orden). Con un motor a 1x tiempo real, sintetizar en serie dejaba huecos de
varios segundos entre frase y frase; en paralelo la voz no se corta. Por eso
importa `VOICE_TTS_MAX_PENDING_CHARS`: cada fragmento tarda lo que dura su
audio, así que un fragmento de 9 s son 9 s hasta que se oye la siguiente
frase.

Antes de sintetizar, el texto se **normaliza** (`normalizeForSpeech`, en
`@jarvis/shared`): las cifras, las fechas, los porcentajes y los símbolos se
convierten a su forma hablada (`$1,500.50` → «mil quinientos dólares con
cincuenta centavos», `23/10/2026` → «veintitrés de octubre de dos mil
veintiséis», `12,5%` → «doce coma cinco por ciento», `50 km/h` → «cincuenta
kilómetros por hora»). El navegador aplica la **misma** normalización, así que
la voz de respaldo dice exactamente lo mismo que la del servidor.

Consecuencias:

- El instante del primer sonido **es medible** (el `speechSynthesis` del
  navegador no lo expone).
- La interrupción es exacta: se corta el audio en curso.
- La voz es la misma en todos los clientes.
- Si el motor no está disponible, la herramienta se declara no disponible y el
  cliente recurre a la voz del navegador (una sola voz, nunca las dos).

### Latencia real (medida, no estimada)

`scripts/health-check.mjs` mide el primer audio de un turno real por
WebSocket; `pnpm voice:latency` mide la cadena de síntesis sin LLM.

| | antes | ahora |
| :--- | ---: | ---: |
| fin de la voz del usuario → primer audio | 10 476 ms | **2 686 – 4 285 ms** |

Lo que queda en medio es el modelo: hasta que no cierra su primera frase no
hay nada que sintetizar. La auditoría que dio los 10 476 ms tenía además el
cortador de frases roto (no separaba ninguna frase: el audio solo salía al
final del turno) y dos respuestas superpuestas ("dos voces").

### Turnos de voz sin razonamiento

`VOICE_FAST_TURNS=true` envía `chat_template_kwargs.enable_thinking = false`
en los turnos originados por voz. Medido en `nemotron-3.5-lightning-30b-a3b`:

| | primer token | turno completo | herramientas |
| :--- | ---: | ---: | :--- |
| con razonamiento | 1 136 ms | 1 681 ms | 1 ✓ |
| **sin razonamiento** | **199 ms** | **606 ms** | **1 ✓** |

El modelo sigue llamando a las herramientas igual; lo que se paga es el
razonamiento, que en voz no se oye.

## 12. ASR en el servidor (reconocimiento de voz)

El navegador puede dejar de transcribir: solo captura el audio y lo manda. El
servidor decide **cuándo termina la intervención** (VAD de energía) y transcribe
con un modelo de ASR de NVIDIA.

```
VOICE_ASR_ENABLED=true
VOICE_ASR_MODEL=nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
VOICE_ASR_LANGUAGE=es
VOICE_ASR_BASE_URL=          # vacío = la misma base de NVIDIA
```

En Ajustes → «Origen de la transcripción» se elige `Navegador` o `Servidor`.

### Dos motores, según lo que tengas habilitado

| Modelo | Estado | Latencia medida | Nota |
| :--- | :--- | ---: | :--- |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | **Ya está en tu cuenta** | **807 ms** (sin razonamiento) / 2 878 ms (razonando) | Recibe el audio como bloque `audio_url` en una llamada de chat normal. Es el valor por defecto. |
| `nvidia/parakeet-tdt-0.6b` | Hay que **habilitarlo** en build.nvidia.com | purpose-built, más rápido que el omni | 25 idiomas europeos (español ✓), con puntuación y marcas de tiempo. Usa el endpoint de fichero. |
| `nvidia/parakeet-1.1b-rnnt-multilingual-asr` | Hay que habilitarlo | — | Se sirve por **websocket de streaming**, no por el endpoint de fichero: este adaptador no lo cubre y lo dice al arrancar. |

El ASR del servidor aplica `chat_template_kwargs.enable_thinking = false`:
transcribir no necesita razonar, y medirlo dio 807 ms frente a 2 878 ms con la
misma transcripción exacta. También reintenta ante 503/429, porque los modelos
con más tráfico se saturan (medido: 1 de 3 llamadas devolvió
`ResourceExhausted: 16/16`).

Flujo verificado de extremo a extremo (con un ASR local que imita la API de
NVIDIA):

```
navegador  ──PCM 16 kHz──►  servidor  ──HTTP──►  modelo ASR
                                     │  95 ms: transcripción
                                     ▼
                                   turno  ──►  respuesta  ──►  audio
```

Ventajas frente al ASR del navegador: el corte de la intervención lo decide el
sistema con un criterio medible (y no un temporizador fijo de 1,3 s), la
transcripción es reproducible y auditable, y se elimina la clase de problemas
«micrófono bloqueado por el origen».

## 13. Sandbox de ejecución de código

Las tools `code.execute_interpreter` (Python/Node) y `code.compile_and_run`
(C++/Rust/Go) ejecutan código en contenedores efímeros aislados.

```bash
# Intérprete: usa imágenes slim oficiales (deben estar ya descargadas).
docker images | grep -E "python:3.12-slim|node:22-slim"

# Compilación: construye la imagen con los tres toolchains (requiere red UNA vez).
pnpm sandbox:build
```

Configuración opcional (por defecto ya apunta a las imágenes correctas):

```
JARVIS_SANDBOX_IMAGE_PYTHON=python:3.12-slim
JARVIS_SANDBOX_IMAGE_NODEJS=node:22-slim
JARVIS_SANDBOX_IMAGE_CPP=jarvis-sandbox:latest
JARVIS_SANDBOX_IMAGE_RUST=jarvis-sandbox:latest
JARVIS_SANDBOX_IMAGE_GO=jarvis-sandbox:latest
```

Si falta una imagen, la tool se reporta como **no disponible** y no se anuncia
al modelo: el sistema no simula capacidades.

Verificación del aislamiento con contenedores reales:

```bash
pnpm --filter @jarvis/server exec tsx ../../scripts/audit-code-execution.ts
```

| Escenario | Resultado esperado |
| --- | --- |
| uid dentro del contenedor | `65534(nobody)` |
| Escritura fuera de `/tmp` | `Read-only file system` |
| `/tmp` | escribible |
| Reserva de memoria excessive | `oom_killed: true`, `exit_code: 137` |
| Bucle infinito | `timed_out: true`, `exit_code: -1` |
| Salida enorme | `truncated: true` |
| `rm -rf` / red | `static_gate_rejected` (no llega al sandbox) |

---

## 14. Búsqueda web

La herramienta `web.search` está implementada y sólo se anuncia al modelo si
hay un proveedor configurado. Sin configuración aparece en `/api/capabilities`
como no disponible, con su motivo.

| Proveedor | Variable | Credencial |
| :--- | :--- | :--- |
| Brave Search | `WEB_SEARCH_PROVIDER=brave` | `WEB_SEARCH_API_KEY` (obligatoria) |
| Tavily | `WEB_SEARCH_PROVIDER=tavily` | `WEB_SEARCH_API_KEY` (obligatoria) |
| SearXNG (`endless`) | `WEB_SEARCH_PROVIDER=endless` | `ENDLESS_API_KEY` (opcional) y `ENDLESS_BASE_URL` |
| **Federado** (`federated`) | `WEB_SEARCH_PROVIDER=federated` | **Ninguna** |

```bash
# Ejemplo: instancia SearXNG
WEB_SEARCH_PROVIDER=endless
ENDLESS_BASE_URL=https://api.endless.sbs
ENDLESS_API_KEY=...
```

### Proveedor `federated` (coste cero, sin claves)

Meta-buscador que consulta en paralelo y sin credenciales:

| Fuente | Cubre | Latencia medida |
| :--- | :--- | ---: |
| DuckDuckGo (búsqueda web) | general | 300–800 ms |
| DuckDuckGo (Instant Answer) | definiciones | ~400 ms |
| Wikipedia (es) | conceptos y entidades | ~200 ms |
| Google News RSS | actualidad y anuncios | ~400 ms |
| Hacker News (Algolia) | lanzamientos e IA | ~300 ms |
| Stack Exchange | programación y errores | ~400 ms |

Cada fuente es independiente: si una falla, el turno continúa y la fuente caída
se declara en `unresponsive_engines`. Si la consulta larga no casa en ningún
índice, se reintenta con variantes recortadas (`query_variants_tried`).

Complementa a `web.fetch`, que descarga el texto de una URL pública (con
protección SSRF: solo `http(s)` y rechazo de destinos privados).

DuckDuckGo exige un **POST** con cabeceras de navegador; el `GET` sobre `?q=`
devuelve la página de challenge (HTTP 202) en lugar de resultados. El
adaptador lo hace bien y, si aun así llega el challenge, lo declara como fuente
caída.

El proveedor `endless` consulta el endpoint nativo de SearXNG
(`GET {ENDLESS_BASE_URL}/search?q=…&format=json`) y admite `WEB_SEARCH_ENGINES`
para fijar los motores. Cuando la instancia responde con motores degradados
(429, CAPTCHA, suspendidos), la herramienta lo declara en `unresponsive_engines`
y marca `degraded: true`: el agente sabe que la búsqueda fue parcial.

Robustez implementada en el adaptador:

- Validación zod de la respuesta externa (tolerante a `null` y a las tres
  formas de `unresponsive_engines` que emite SearXNG).
- Filtro de URLs: solo `http`/`https` (`javascript:` y `file:` se descartan).
- Saneado de caracteres de control y colapso de espacios.
- Filtro de relevancia determinista: se conservan los resultados que comparten
  un término significativo con la consulta y se declara cuántos se descartaron
  (`discarded_irrelevant`).
- Propagación del `AbortSignal` del turno: la búsqueda se corta si el usuario
  interrumpe o vence el presupuesto.

## 15. Proveedor de respaldo (OpenRouter)

El servidor opera con una **cadena de proveedores**: NVIDIA NIM es el primario y
OpenRouter el respaldo. Si el primario falla por una causa de **proveedor**
(red, timeout, 5xx, rate limit, credenciales), el turno se reintenta con el
respaldo. Si el fallo es de **petición** (400/422) o un **aborto del usuario**,
no hay conmutación: reintentar en otro proveedor daría el mismo resultado.

```bash
# .env
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=minimax/minimax-m3.1-flash
OPENROUTER_REASONING_EFFORT=low
```

Sin `OPENROUTER_API_KEY` **no hay respaldo** y el arranque lo declara:
`openrouter sin configurar (respaldo no disponible)`. El sistema nunca simula
una capacidad que no tiene.

### Reglas de la cadena

| Regla | Comportamiento |
| --- | --- |
| **Sticky** | El proveedor que responde bien pasa a ser el preferido: no se vuelve a probar el caído en cada turno. |
| **Sin conmutación a mitad de stream** | Si ya salió contenido, reintentar duplicaría la respuesta: se propaga el error. |
| **Recuperación automática** | El vigilante de salud (cada 20 s) sondea el primario y lo re-promueve en cuanto responde, sin reiniciar el servidor. |
| **Observabilidad** | Cada conmutación incrementa `provider.failovers` y escribe un `WARN` con el proveedor de origen, el de destino y el motivo. El componente `brain` del health refleja siempre el proveedor **activo**. |

### Verificación

```bash
node scripts/verify-failover.mjs 8788 "escenario"
node scripts/verify-failover-recovery.mjs   # ciclo completo con recuperación
```

El ciclo verificado: con el primario operativo responde el primario
(`failovers: 0`); al caer el primario responde el respaldo (`failovers: 1`); al
restaurarlo, la siguiente respuesta vuelve al primario sin tocar nada.

> Nota sobre `reasoning_effort`: en los modelos con razonamiento, `max` (el
> valor por defecto de MiniMax M3.1 Flash) aumenta el TTFT. Para una vía de
> voz, usa `low`: el respaldo debe ser más rápido que el primario en la
> incidencia, no más lento.

---

## 16. Siguientes pasos

- Protocolo completo: [`docs/api.md`](api.md).
- Seguridad y secretos: [`docs/security.md`](security.md).
- Operación (backups, cambio de modelo): [`docs/operations.md`](operations.md).
- Pruebas E2E: [`../e2e/README.md`](../e2e/README.md).

## Control de interfaz (`computer.use`)

Mueve el ratón y teclea en tu Mac mediante CoreGraphics (driver en
`infra/computer-use/driver.py`, sin dependencias que instalar).

```bash
JARVIS_ENABLE_COMPUTER_USE=true
```

**Está apagado por defecto a propósito**: es la única capacidad de JARVIS que
toca tu escritorio de verdad. Con él activo, **cada acción pide aprobación**
en la interfaz (evento `tool.awaiting_approval` → diálogo → `approval.respond`).
Si la rechazas, la acción no se ejecuta y JARVIS dice el motivo real, sin
inventarse el resultado.

**Permiso de macOS**: el proceso del servidor necesita *Accesibilidad* y
*Grabación de pantalla* en Ajustes del Sistema → Privacidad y seguridad. Sin
ellos, macOS descarta los eventos en silencio y el driver devuelve error.

Se comprueba sin tocar el ratón:

```bash
python3 infra/computer-use/driver.py '{"action":"get_screen_info"}'
```
