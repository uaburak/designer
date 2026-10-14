/** A tool call's refusal: its message goes to the agent as the error result. */
export class ToolError extends Error {}

/**
 * The layers a write tool names, as given (`nodeIds`, else `nodeId`). Writes never fall back to the user's selection —
 * a call from an outside MCP client or a chat agent that names nothing (or an empty list) is refused, so a bug on
 * the agent's side can't move, change or delete what the owner has selected. Reads (get_selection,
 * get_design_context …) still default to the selection.
 */
export function explicitNodeIds(args: Record<string, unknown>, tool: string): unknown[] {
  if (Array.isArray(args.nodeIds)) {
    const ids = (args.nodeIds as unknown[]).filter((x) => x !== null && x !== undefined && x !== "");
    if (ids.length) return ids;
    if (args.nodeId === undefined || args.nodeId === null || args.nodeId === "") throw new ToolError(`${tool}: no nodes given — nodeIds is empty. Writes never use the selection: name the layers by id (get_selection / get_metadata list them).`);
  }
  if (args.nodeId !== undefined && args.nodeId !== null && args.nodeId !== "") return [args.nodeId];
  throw new ToolError(`${tool}: no nodes given — pass nodeIds (or nodeId). Writes never use the selection: name the layers by id (get_selection / get_metadata list them).`);
}
