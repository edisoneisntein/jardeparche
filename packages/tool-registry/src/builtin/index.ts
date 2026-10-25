import type { ToolDefinition } from "@jarvis/shared";
import { ToolRegistry } from "../registry.js";
import type { ToolServices } from "../types.js";
import { calculatorTool } from "./calculator.js";
import { systemInfoTool, timeTool } from "./datetime-system.js";
import { createTaskTools } from "./tasks.js";
import { createMemoryTools } from "./memory-tools.js";
import { createWebSearchTool } from "./web-search.js";
import { createDocumentTools } from "./documents.js";
import { createCompileAndRunTool, createExecuteCodeInterpreterTool, warmupSandboxImages } from "./code-execution.js";
import { createLocalRagTool } from "./local-rag.js";
import { createFileIoTool } from "./file-io.js";
import { createSafeShellTool } from "./safe-shell.js";
import { createComputerUseTool } from "./computer-use.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createCodeReviewTool } from "./code-review.js";
import { createOrchestrationTool } from "./orchestration.js";
import { createComputerUseSkillTool } from "./computer-use-skill.js";
import { createFindSkillsTool } from "./find-skills.js";
import { createAIStudioPrototypeTool } from "./aistudio-prototype.js";
import { createYoutubeSearchTool, createYoutubeTranscriptTool } from "./youtube.js";
import { createMusicTool } from "./music.js";

export function createBuiltinTools(services: ToolServices): ToolDefinition[] {
  return [
    timeTool,
    systemInfoTool,
    calculatorTool,
    ...createTaskTools(services),
    ...createMemoryTools(services),
    createWebSearchTool(services),
    ...createDocumentTools(services),
    createLocalRagTool(services),
    createWebFetchTool(services),
    createYoutubeSearchTool(services),
    createYoutubeTranscriptTool(services),
    createMusicTool(services),
    createFileIoTool(services.config),
    createSafeShellTool(services.config),
    createComputerUseTool(services.config),
    createExecuteCodeInterpreterTool(services.config),
    createCompileAndRunTool(services.config),
    // Skills integrations
    createCodeReviewTool(services),
    createOrchestrationTool(services),
    createComputerUseSkillTool(services),
    createFindSkillsTool(services),
    createAIStudioPrototypeTool(services),
  ];
}

export function createToolRegistry(services: ToolServices): ToolRegistry {
  return new ToolRegistry({ maxResultBytes: services.config.maxResultBytes }).registerAll(createBuiltinTools(services));
}

export { warmupSandboxImages };
