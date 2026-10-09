/**
 * The Design panel's "MCP" section with nothing selected (live design/page-nothing-selected.txt: "MCP", a span
 * whose tooltip names the server and its client — "Figma MCP in Claude" — with "1 connection", and the 24 button
 * "Set up agents for Figma MCP"). Ours counts the MCP sessions of this app's server (outside clients and the
 * Agents tab's own); the button opens Agent settings. Shown only where there is a server (the desktop app).
 */
import { useSyncExternalStore } from "react";
import { IconButton, PanelSection, tooltipProps } from "@/ds";
import { useEditor } from "../../controller";
import { agentsOf } from "../../agents/service";
import styles from "./Agents.module.css";

export function McpSection() {
  const ed = useEditor();
  const service = agentsOf(ed);
  const state = useSyncExternalStore(service.subscribe, service.get);
  if (!state.available) return null;
  const n = state.mcp.connections.length;
  const clients = [...new Set(state.mcp.connections.map((c) => c.client))];
  const tip = clients.length ? clients.map((c) => `MCP in ${c}`).join(", ") : state.mcp.url ? `MCP server at ${state.mcp.url}` : "The MCP server isn't running";
  return (
    <PanelSection
      title="MCP"
      data-mcp-section=""
      className={styles.mcpSection}
      actions={
        <>
          <span className={styles.mcpCount} {...tooltipProps(tip)} data-mcp-connections={n}>
            {n === 1 ? "1 connection" : `${n} connections`}
          </span>
          <IconButton
          icon="24.agents"
          label="Set up agents for MCP"
          tone="secondary"
          onClick={() => {
            ed.ui.set({ railTab: "agents", uiHidden: false, uiMinimized: false });
            service.setView("settings");
          }}
          />
        </>
      }
    />
  );
}
