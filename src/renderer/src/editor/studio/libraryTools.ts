/**
 * The manager's library tools (docs/studio.md §3.3): their definitions and how the editor answers them. 15b fills it;
 * 15a lists LIBRARY_TOOLS among the manager's tools and sends their calls here.
 */
import type { ToolDef, ToolResult } from "../../../../shared/agents/tools";
import { textResult } from "../../../../shared/agents/tools";
import type { EditorController } from "../controller";

export const LIBRARY_TOOLS: ToolDef[] = [];

export async function runLibraryTool(_ed: EditorController, name: string, _args: Record<string, unknown>): Promise<ToolResult> {
  return textResult(`${name} isn't built yet`, true);
}
