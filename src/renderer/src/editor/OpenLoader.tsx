/**
 * The file's loader, as Figma's: the logo over a thin bar filling as the file comes in (openProgress.ts) — alone on
 * the page before the document is here, then over the canvas between the panels' placeholders.
 */
import { Icon } from "@/ds";
import { useOpenProgress } from "./openProgress";
import styles from "./OpenLoader.module.css";

export function OpenLoader() {
  const progress = useOpenProgress();
  return (
    <div className={styles.loader} role="progressbar" aria-label="Loading file" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <Icon name="24.figma" size={32} className={styles.logo} />
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${(progress * 100).toFixed(1)}%` }} />
      </div>
    </div>
  );
}
