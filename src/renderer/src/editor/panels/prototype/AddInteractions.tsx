/**
 * Add interactions with AI (help.figma.com 24004778051479; docs/ai.md §3): the Prototype tab's Interactions section
 * offers "Add interactions" when two or more top-level frames are selected; the AI connects them (editor/ai,
 * `addInteractions`) as one step, and a banner at the bottom offers "Preview" (the inline preview from the first
 * frame) and "Keep it"; ✕ takes the step back [unverified]. The banner's wording beyond its buttons is ours.
 */
import { Badge, Button, IconButton, Portal } from "@/ds";
import { useEditor } from "../../controller";
import { aiOf, type AiActions } from "../../ai/service";
import { useAiState } from "../../ai/AiPanel";
import styles from "./Prototype.module.css";
import { t, tp, useT } from "@/i18n";

export function AddInteractionsButton() {
  useT();
  const ed = useEditor();
  const ai = aiOf(ed);
  const s = useAiState(ai);
  const running = s.run?.action === "add-interactions";
  return (
    <div className={styles.aiRow}>
      <Button variant="secondary" fullWidth icon="24.prototyping" loading={running} disabled={!s.enabled || (!!s.run && !running)} onClick={() => (running ? ai.stop() : void ai.addInteractions())} tooltip={running ? t("Stop") : undefined}>
        {running ? t("Adding interactions…") : t("Add interactions")}
      </Button>
      <Badge>AI</Badge>
    </div>
  );
}

export function AddInteractionsBanner({ ai }: { ai: AiActions }) {
  useT();
  const s = useAiState(ai);
  const b = s.banner;
  if (b?.kind !== "interactions") return null;
  return (
    <Portal>
      <div role="status" className={styles.aiBanner} data-ai-banner="interactions">
        <span className={styles.aiBannerText}>{tp(b.count, "Added {n} interaction", "Added {n} interactions")}</span>
        <Button variant="secondary" onClick={() => ai.previewInteractions()}>
          {t("Preview")}
        </Button>
        <Button variant="primary" onClick={() => ai.closeBanner()}>
          {t("Keep it")}
        </Button>
        <IconButton icon="24.close.small" label={t("Undo")} tone="secondary" onClick={() => ai.closeBanner(true)} />
      </div>
    </Portal>
  );
}
