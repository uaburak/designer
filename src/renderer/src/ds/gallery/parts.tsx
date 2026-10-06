import { createContext, useContext, type ReactNode } from "react";
import styles from "./Gallery.module.css";

/** The Gallery's search query and the theme column a section is drawn in. */
export const GalleryContext = createContext<{ query: string; theme: "light" | "dark"; isStatic: boolean }>({ query: "", theme: "light", isStatic: false });

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className={styles.section} id={id} data-gallery-section={id}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

/** One component's matrix; hidden when the search does not match its name. */
export function Comp({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  const { query } = useContext(GalleryContext);
  if (query && !name.toLowerCase().includes(query.toLowerCase())) return null;
  return (
    <div className={styles.component} data-gallery-component={name}>
      <h3 className={styles.componentTitle}>{name}</h3>
      {note && <p className={styles.componentNote}>{note}</p>}
      {children}
    </div>
  );
}

export function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      {label && <div className={styles.rowLabel}>{label}</div>}
      {children}
    </div>
  );
}

/** A state cell: `data-gallery-id="<Component>/<variant>/<size>/<state>"`. */
export function Cell({ id, label, children, width }: { id: string; label?: string; children: ReactNode; width?: number }) {
  return (
    <div className={styles.cell} data-gallery-id={id}>
      {width ? <div style={{ width }}>{children}</div> : children}
      <span className={styles.cellLabel}>{label ?? id.split("/").slice(1).join(" · ")}</span>
    </div>
  );
}

export const noop = () => {};
