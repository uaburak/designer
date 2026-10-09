import { antigravity } from "./antigravity";
import { claudeCode } from "./claudeCode";
import { codex } from "./codex";
import { cursorAgent } from "./cursor";
import { gemini } from "./gemini";
import type { CliSpec } from "./turns";

/** The CLI agents the Agents tab drives headless, one adapter file each (R12 §4). */
export const CLI_SPECS: CliSpec[] = [claudeCode, antigravity, gemini, codex, cursorAgent];

export const cliSpec = (id: string): CliSpec | undefined => CLI_SPECS.find((s) => s.id === id);

/** The local model servers (OpenAI-compatible, bridged by openaiBridge.ts): where they answer and how to get them. */
export const LOCAL_SERVERS: { id: string; label: string; baseUrl: string; install: { page: string; command?: string } }[] = [
  { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", install: { page: "https://ollama.com/download" } },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", install: { page: "https://lmstudio.ai/download" } },
];

export { antigravity, claudeCode, codex, cursorAgent, gemini };
export type { CliSpec };
