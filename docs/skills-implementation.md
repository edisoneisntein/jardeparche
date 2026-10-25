# JARVIS Skills Implementation

This document describes the skills implemented for the JARVIS project.

## Implemented Skills

### 1. Code Review (`code-review`)
- **Workflow**: `.github/workflows/code-review.yml` - Runs on every PR
- **Script**: `scripts/code-review.mjs` - Invokes the code-review skill
- **Command**: `pnpm code-review`

### 2. Orchestration (`orchestration`)
- **Pipeline Definition**: `orchestration/voice-pipeline.yaml` - Complete voice pipeline definition
- **Script**: `scripts/run-orchestration.mjs` - Runs the orchestration skill
- **Command**: `pnpm orchestrate`

### 3. Computer Use (`computer-use`)
- **Demo Script**: `scripts/demo-computer-use.mjs` - Demonstrates computer.use tool
- **Command**: `pnpm demo:computer`

### 4. Find Skills (`find-skills`)
- **Workflow**: `.github/workflows/scan-skills.yml` - Runs weekly on Mondays
- **Script**: `scripts/scan-skills.mjs` - Scans and catalogs available skills
- **Outputs**: `skills-catalog.json`, `docs/available-skills.md`
- **Command**: `pnpm scan-skills`

### 5. AI Studio Prototype (`aistudio-prototype`)
- **Prototype Config**: `prototypes/jarvis-voice.yaml` - Complete prototype with system prompt, tools, models, test scenarios
- **Script**: `scripts/prototype-aistudio.mjs` - Launches the prototype
- **Command**: `pnpm prototype`

## Usage

All skills can be run via npm scripts:

```bash
# Code review (runs automatically on PRs)
pnpm code-review

# Run orchestration pipeline
pnpm orchestrate

# Demo computer use capabilities
pnpm demo:computer

# Scan for available community skills
pnpm scan-skills

# Launch AI Studio prototype for prompt/tool iteration
pnpm prototype
```

## Voice Pipeline Integration

The orchestration pipeline (`orchestration/voice-pipeline.yaml`) defines the complete voice processing flow:
1. **STT** - Speech-to-Text (browser or server)
2. **Intent** - Intent detection with full tool catalog
3. **Agent Runtime** - Tool execution with auto-approval
4. **TTS** - Text-to-Speech (Kokoro with fallbacks)
5. **Audio Playback** - Streaming with interruption handling
6. **Fallback** - Multi-level fallback chain

All configurations are driven by environment variables set in `start-voice-lowlatency.sh`.