/**
 * "Create link" (⇧⌘U, Text › Create link): Figma's link field above the selected characters (or over the canvas for
 * whole layers). Enter links the selected text (a run's `hyperlink`, underlined as Figma styles links); an emptied
 * field removes the link; Esc closes. Links open in presentation (the engine's player follows them) and on the canvas
 * (CanvasLinks). A layer's link (⌘L "Copy link") links to that layer — of this file, or of another one.
 */
import { t, useT } from "@/i18n";
import { Popover, TextInput } from "@/ds";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { textRefs } from "../commands";
import { textSummary } from "../model/text";
import { fileKeyOf, hyperlinkOf, hyperlinkTarget, linkText, parseLinkTarget } from "../model/canvasLinks";
import { fields } from "../panels/design/shared";

export function LinkEditor() {
  useT();
  const ed = useEditor();
  const at = useUI((s) => s.linkEditor);
  if (!at) return null;
  const refs = textRefs(ed);
  const summary = textSummary(ed.engine, refs);
  const here = fileKeyOf(ed);
  const current = summary && !summary.mixed.has("hyperlink") ? hyperlinkTarget(summary.values.hyperlink as { url?: string; guid?: unknown } | null, here) : null;
  const close = () => {
    ed.ui.set({ linkEditor: null });
    ed.canvas?.focus({ preventScroll: true });
  };
  const apply = (text: string) => {
    const target = parseLinkTarget(text, here);
    if (!refs.length) return close();
    if (!text.trim()) {
      if (current) ed.setProps(refs, fields({ hyperlink: null }), "Remove link");
    } else if (target) {
      ed.setProps(refs, fields({ hyperlink: hyperlinkOf(target, here), textDecoration: "UNDERLINE" }), current ? "Edit link" : "Create link");
    }
    close();
  };
  const anchor = new DOMRect(at.x, at.y, at.width, at.height);
  return (
    <Popover anchor={anchor} placement="top" onClose={close} label={t("Link")} width={280}>
      <TextInput
        label={t("Link")}
        value={current ? linkText(current, here) : ""}
        placeholder={t("Paste or type a link")}
        autoFocus
        onCommit={apply}
        onExit={(r) => (r === "escape" ? close() : undefined)}
      />
    </Popover>
  );
}
