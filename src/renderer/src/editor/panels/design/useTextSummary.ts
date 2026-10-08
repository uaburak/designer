/** The selected texts' run style for the Design panel (Typography, Fill): model/text.ts over the engine. */
import { useEffect, useMemo, useState } from "react";
import { useEditor } from "../../controller";
import { textSummary, type TextSummary } from "../../model/text";
import type { PanelNode } from "./shared";

/**
 * The texts' run style from the engine (the edited selection, else the whole layers), re-read when the nodes change
 * and whenever the text selection moves (TEXT_EDIT). Null when `nodes` holds no text or the engine can't read ranges.
 */
export function useTextSummary(nodes: readonly PanelNode[]): TextSummary | null {
  const ed = useEditor();
  const [version, setVersion] = useState(0);
  useEffect(() => ed.engine.on("TEXT_EDIT", () => setVersion((v) => v + 1)), [ed]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (nodes.length ? textSummary(ed.engine, nodes.map((n) => n.guid)) : null), [ed, nodes, version]);
}
