import { useRef, type HTMLAttributes } from "react";
import { cx } from "../util/cx";
import { rovingTarget } from "../util/rovingFocus";
import styles from "./Tabs.module.css";

export type TabItem = { value: string; label: string; badge?: number };

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  label: string;
  value: string;
  tabs: TabItem[];
  onChange: (v: string) => void;
  /** id prefix: tab `${idBase}-tab-${value}` controls `${idBase}-panel-${value}` */
  idBase?: string;
}

/** Figma's panel tabs (contract §4.14): 24px, the chosen one strong on bg-secondary; ← → Home End move and activate. */
export function Tabs({ label, value, tabs, onChange, idBase, className, ...rest }: TabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" aria-label={label} data-ds="Tabs" className={cx(styles.list, className)} {...rest}>
      {tabs.map((t, i) => (
        <button
          key={t.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={idBase ? `${idBase}-tab-${t.value}` : undefined}
          aria-controls={idBase ? `${idBase}-panel-${t.value}` : undefined}
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          className={styles.tab}
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => {
            const next = rovingTarget(e.key, tabs.length, () => true, i, "horizontal");
            if (next === null || next < 0) return;
            e.preventDefault();
            refs.current[next]?.focus();
            onChange(tabs[next].value);
          }}
        >
          {/* Live Figma: a tab is as wide as its label in the selected weight (a hidden bold copy holds the room) */}
          <span className={styles.labelBox}>
            <span>{t.label}</span>
            <span aria-hidden="true" className={styles.labelBold}>{t.label}</span>
          </span>
          {t.badge !== undefined && t.badge > 0 && <span className={styles.badge}>{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}
