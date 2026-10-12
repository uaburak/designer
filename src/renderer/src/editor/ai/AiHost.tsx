/**
 * The AI actions' place in the editor (one line in EditorApp): it makes the file's `AiActions` when the editor mounts
 * (so a duplicate can suggest Replace content), shows a run started outside Actions (the Layers row's "Rename layers",
 * the Prototype tab's "Add interactions") as a pill over the toolbar with Stop, and the banners: Add interactions'
 * Preview / Keep it (panels/prototype/AddInteractions.tsx) and the Replace content suggestion after a duplicate.
 */
import { Button, IconButton, Portal, Spinner } from "@/ds";
import { useEditor } from "../controller";
import { AddInteractionsBanner } from "../panels/prototype/AddInteractions";
import { useAiState } from "./AiPanel";
import { aiOf } from "./service";
import styles from "./AiHost.module.css";

export function AiHost() {
  const ed = useEditor();
  const ai = aiOf(ed);
  const s = useAiState(ai);
  const banner = s.banner;
  return (
    <>
      {s.run && !s.run.fromPanel && (
        <Portal>
          <div role="status" className={styles.pill} data-ai-run={s.run.action}>
            <Spinner size={16} label={s.run.label} />
            <span>{s.run.label}</span>
            <Button variant="secondary" onClick={() => ai.stop()}>
              Stop
            </Button>
          </div>
        </Portal>
      )}
      <AddInteractionsBanner ai={ai} />
      {banner?.kind === "replace-content" && !s.run && (
        <Portal>
          <div role="status" className={styles.pill} data-ai-banner="replace-content">
            <span>Replace placeholder content in the copies?</span>
            <Button variant="primary" onClick={() => void ai.replaceContent("", { refs: banner.refs })}>
              Replace content
            </Button>
            <IconButton icon="24.close.small" label="Dismiss" tone="secondary" onClick={() => ai.closeBanner()} />
          </div>
        </Portal>
      )}
    </>
  );
}
