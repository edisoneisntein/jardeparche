---
name: rea-remix-audit
description: Flujo de auditoría de código de JARVIS usando dos motores locales: Constructor REA/SIREP (evidencia: análisis estático, grafo de arquitectura, hallazgos, change-sets) y Remix Remix Prompt VIP (criterio: auditoría senior y generación de instrucciones de agentes/subagentes). Se ejecuta en segundo plano por API, sin abrir las interfaces.
---

# Auditoría REA + Remix VIP

JARVIS delega dos trabajos distintos:

- **REA / SIREP** → *hechos*: análisis estático profundo, grafo de arquitectura, hallazgos, change-sets con código real. Es el **analista**.
- **Remix Remix Prompt VIP** → *juicio*: auditoría senior y redacción de instrucciones para agentes/subagentes. Es el **estratega**.

## Requisitos previos
Ver la skill `rea-remix-audit` de opencode (`~/.agents/skills/rea-remix-audit/SKILL.md`) para las **4 reparaciones obligatorias de REA** (parser `@babel/parser` en la imagen, `SIREP_NIM_TIMEOUT_SECONDS=600`, `chat_template_kwargs.enable_thinking=false`, `MAX_OUTPUT_TOKENS=16384` + JSON tolerante). Sin ellas REA reporta `files_analyzed: 0` o su IA devuelve vacío.

## Ejecución

```bash
# 1) Evidencia (REA): analiza el repo y escribe artifacts/rea-evidence.md
node skills/rea-remix-audit/scripts/rea_audit.mjs "$PWD" /tmp/jarvis-main.zip

# 2) Juicio (Remix VIP): auditoría senior -> artifacts/audit.md
node skills/rea-remix-audit/scripts/remix_generate.mjs auditor_elite /tmp/rea-evidence.md artifacts/audit.md

# 3) Instrucciones de agentes/subagentes -> artifacts/agents-prompt.md
node skills/rea-remix-audit/scripts/remix_generate.mjs creator artifacts/audit.md artifacts/agents-prompt.md
```

Requisitos de entorno:
- REA en `http://127.0.0.1:8000` (Docker Compose en `~/Documents/Constructor REA/platform`).
- Remix VIP en `http://127.0.0.1:3010` (`PORT=3010 npx tsx server.ts` en `~/Documents/Remix_Remix_Proms_VIP`; el 3000 lo ocupa REA).
- Token de REA: `REA_TOKEN` o `~/.config/jarvis/rea-token`.

## Artefactos
- `artifacts/rea-evidence.md` — evidencia cruda del análisis (REA).
- `artifacts/audit.md` — auditoría priorizada (Remix VIP, modo `auditor_elite`).
- `artifacts/agents-prompt.md` — instrucciones de coordinador + subagentes (Remix VIP, modo `creator`).

## Reglas
- La auditoría es una **opinión sobre evidencia**, no evidencia. Citarla como tal.
- Si `result_summary.files_analyzed == 0`, la auditoría es inválida: decirlo, no maquillarlo.
- Ningún subagente propone rutas que no existan en la evidencia.
