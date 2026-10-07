/**
 * The instance menu (UI3): a popover listing the file's local components by
 * page and frame, with a search, for swapping an instance, picking an Instance
 * swap property's value or adding preferred values. Preferred components (an
 * Instance swap property's) come first, the current one is ticked.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { Icon, Popover, SearchField, cx } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor } from "../../controller";
import { assetLabel, groupAssets, isPreferred, searchAssets, type ComponentAsset } from "../../model/components";
import styles from "./Component.module.css";

export interface ComponentPickerProps {
  anchor: HTMLElement | DOMRect | null;
  title?: string;
  /** The component (or a variant of the set) shown as current */
  current?: Guid | null;
  /** Component keys listed first, under "Preferred" */
  preferredKeys?: readonly string[];
  /** Components not offered (the instance's own ancestors, which would nest it in itself) */
  exclude?: ReadonlySet<Guid>;
  onPick: (asset: ComponentAsset) => void;
  onClose: () => void;
}

/** The file's components, re-read after document changes. */
export function useComponentAssets(): ComponentAsset[] {
  const ed = useEditor();
  const version = useSyncExternalStore(ed.components.subscribe, ed.components.getVersion);
  return useMemo(() => {
    void version;
    return ed.components.assets();
  }, [ed, version]);
}

export function ComponentPicker({ anchor, title = "Swap instance", current, preferredKeys, exclude, onPick, onClose }: ComponentPickerProps) {
  const ed = useEditor();
  const assets = useComponentAssets();
  const [query, setQuery] = useState("");
  const pages = ed.store.pages.map((p) => p.guid);
  const offered = assets.filter((a) => !exclude?.has(a.id) && !exclude?.has(a.target));
  const found = searchAssets(offered, query);
  const preferred = preferredKeys?.length ? found.filter((a) => preferredKeys.some((k) => isPreferred(a, k))) : [];
  const groups = groupAssets(found, pages);
  const currentAsset = current ? ed.components.assetOf(current) : null;
  const item = (a: ComponentAsset) => {
    const on = currentAsset?.id === a.id;
    return (
      <button
        key={a.id}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        className={cx(styles.pickItem, on && styles.pickItemOn)}
        onClick={() => {
          onPick(a);
          onClose();
        }}
      >
        <span className={styles.pickCheck}>{on && <Icon name="16.check" />}</span>
        <Icon name={a.kind === "set" ? "16.component.set" : "16.component"} className={styles.purpleIcon} />
        <span className={styles.pickName}>{assetLabel(a.name)}</span>
      </button>
    );
  };
  return (
    <Popover anchor={anchor} title={title} width={240} onClose={onClose} label={title}>
      <div className={styles.picker} data-component-picker="">
        <div className={styles.pickSearch}>
          <SearchField value={query} onChange={setQuery} placeholder="Search" autoFocus />
        </div>
        <div className={styles.pickList} role="menu" aria-label="Components">
          {preferred.length > 0 && (
            <>
              <div className={styles.pickHeader}>Preferred</div>
              {preferred.map(item)}
            </>
          )}
          {groups.length === 0 && <div className={styles.pickEmpty}>{query ? `No results for “${query}”` : "No components in this file"}</div>}
          {groups.map((g) => (
            <div key={g.page}>
              <div className={styles.pickHeader}>{g.pageName}</div>
              {g.frames.map((f) => (
                <div key={f.frame ?? "page"}>
                  {f.frameName && <div className={styles.pickSubheader}>{f.frameName}</div>}
                  {f.items.map(item)}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Popover>
  );
}
