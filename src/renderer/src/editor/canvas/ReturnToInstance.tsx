/**
 * After "Go to main component": the pill over the canvas (above the toolbar)
 * that goes back — the instance's page, the view there, the instance
 * selected. × (or Esc while it has focus) dismisses it.
 */
import { Icon, IconButton } from "@/ds";
import { useEditor } from "../controller";
import { returnToInstance } from "../components";
import { useUI } from "../hooks";
import styles from "./ReturnToInstance.module.css";

export function ReturnToInstance() {
  const ed = useEditor();
  const back = useUI((s) => s.returnToInstance);
  if (!back) return null;
  return (
    <div className={styles.pill} role="status" data-return-to-instance="">
      <button type="button" className={styles.action} onClick={() => returnToInstance(ed)}>
        <Icon name="16.instance" />
        <span>Return to instance</span>
      </button>
      <IconButton icon="24.close.small" label="Dismiss" className={styles.close} onClick={() => ed.ui.set({ returnToInstance: null })} />
    </div>
  );
}
