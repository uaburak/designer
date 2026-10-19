/**
 * Inspect's MCP section (Figma's Dev Mode, the owner's capture docs/research/figma/live/owner-2026-10-18/
 * figma-devmode-inspect): "Selection details" — Session activity, Estimated tokens —, an example prompt naming the
 * layer's link, and "Copy example prompt"; "?" and "+" at the title's right. Ours reads this app's MCP server: the tokens
 * are its `get_design_context` answer for the layer (about 4 characters a token), the link one its tools take.
 */
import { useEffect, useState } from "react";
import { Button, IconButton, PanelSection, showToast } from "@/ds";
import { t, useT } from "@/i18n";
import type { Guid } from "@/engine/codec";
import type { McpHost } from "../context";
import styles from "../Viewer.module.css";

export function McpSection({ id, mcp }: { id: Guid; mcp: McpHost }) {
  useT();
  const [open, setOpen] = useState(true);
  const [tokens, setTokens] = useState<{ id: Guid; n: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    mcp.tokens(id).then(
      (n) => live && setTokens({ id, n }),
      () => live && setTokens(null)
    );
    return () => {
      live = false;
    };
  }, [mcp, id, open]);
  const link = mcp.link(id);
  const prompt = `${t("Implement this design from Wecra.")}\n@${link}`;
  return (
    <PanelSection
      title="MCP"
      collapsible
      open={open}
      onOpenChange={setOpen}
      data-dev-mcp=""
      actions={
        <>
          {mcp.onHelp && <IconButton icon="24.help" label={t("About the MCP server")} onClick={mcp.onHelp} />}
          {mcp.onSetup && <IconButton icon="24.plus" label={t("Set up agents for MCP")} onClick={mcp.onSetup} />}
        </>
      }
    >
      {open && (
        <>
          <div className={styles.mcpTitle}>{t("Selection details")}</div>
          <div className={styles.mcpRow}>
            <span className={styles.mcpLabel}>{t("Session activity")}</span>
            <span>{t("Not sent")}</span>
          </div>
          <div className={styles.mcpRow}>
            <span className={styles.mcpLabel}>{t("Estimated tokens")}</span>
            <span data-mcp-tokens={tokens?.id === id ? tokens.n : undefined}>{tokens?.id === id ? tokens.n.toLocaleString() : "…"}</span>
          </div>
          <div className={styles.mcpPrompt} data-mcp-prompt="">
            <div>{t("Implement this design from Wecra.")}</div>
            <div className={styles.mcpLink}>@{link}</div>
          </div>
          <div className={styles.mcpCopy}>
            <Button
              variant="secondary"
              fullWidth
              onClick={() =>
                void navigator.clipboard?.writeText(prompt).then(
                  () => showToast({ message: t("Copied to clipboard") }),
                  () => showToast({ message: t("Couldn't copy") })
                )
              }
            >
              {t("Copy example prompt")}
            </Button>
          </div>
        </>
      )}
    </PanelSection>
  );
}
