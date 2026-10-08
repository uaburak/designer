/**
 * "Create link" (⇧⌘U, Text › Create link): Figma's link field above the selected characters (or over the canvas for
 * whole layers). Enter links the selected text (a run's `hyperlink`, underlined as Figma styles links); an emptied
 * field removes the link; Esc closes. Links open in presentation (the engine's player follows them).
 */
import { Popover, TextInput } from "@/ds";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { textRefs } from "../commands";
import { normalizeLink, textSummary } from "../model/text";
import { fields } from "../panels/design/shared";

export function LinkEditor() {
  const ed = useEditor();
  const at = useUI((s) => s.linkEditor);
  if (!at) return null;
  const refs = textRefs(ed);
  const summary = textSummary(ed.engine, refs);
  const current = summary && !summary.mixed.has("hyperlink") ? (summary.values.hyperlink as { url?: string } | null) : null;
  const close = () => {
    ed.ui.set({ linkEditor: null });
    ed.canvas?.focus({ preventScroll: true });
  };
  const apply = (text: string) => {
    const url = normalizeLink(text);
    if (!refs.length) return close();
    if (!text.trim()) {
      if (current?.url) ed.setProps(refs, fields({ hyperlink: null }), "Remove link");
    } else if (url) {
      ed.setProps(refs, fields({ hyperlink: { url }, textDecoration: "UNDERLINE" }), current?.url ? "Edit link" : "Create link");
    }
    close();
  };
  const anchor = new DOMRect(at.x, at.y, at.width, at.height);
  return (
    <Popover anchor={anchor} placement="top" onClose={close} label="Link" width={280}>
      <TextInput
        label="Link"
        value={current?.url ?? ""}
        placeholder="Paste or type a link"
        autoFocus
        onCommit={apply}
        onExit={(r) => (r === "escape" ? close() : undefined)}
      />
    </Popover>
  );
}
