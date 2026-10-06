import "./global.css";
import { useMemo, useState } from "react";
import { cx } from "./util/cx";
import { useThemeRoot, setThemePreference, type ThemePreference } from "./theme";
import { TooltipManager } from "./overlay/TooltipManager";
import { ToastHost } from "./components/Toast";
import { SegmentedControl } from "./components/SegmentedControl";
import { Select } from "./components/Select";
import { SearchField } from "./components/SearchField";
import { TokensSection } from "./gallery/TokensSection";
import { IconsSection } from "./gallery/IconsSection";
import { ComponentMatrix } from "./gallery/ComponentMatrix";
import { ScreensSection } from "./gallery/Screens";
import { GalleryContext } from "./gallery/parts";
import styles from "./gallery/Gallery.module.css";

type Mode = "both" | "light" | "dark";
const SECTIONS = [
  { value: "all", label: "All sections" },
  { value: "tokens", label: "Tokens" },
  { value: "icons", label: "Icons" },
  { value: "components", label: "Components" },
  { value: "screens", label: "Screens" },
];

function param(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

/**
 * The design system's Gallery (contract §5.2): every token, icon and
 * component in every state, light and dark side by side, and two screens at
 * the reference size. Standalone: it brings its own CSS (global.css → Inter
 * and tokens.css), tooltip manager and toast host.
 * URL: ?theme=both|light|dark &section=<id> &component=<Name> &static=1
 */
export default function Gallery() {
  const app = useThemeRoot();
  const initialMode = param("theme");
  const [mode, setMode] = useState<Mode>(initialMode === "light" || initialMode === "dark" ? initialMode : "both");
  const [section, setSection] = useState(param("section") ?? "all");
  const [query, setQuery] = useState(param("component") ?? "");
  const [zoom, setZoom] = useState("100");
  const isStatic = param("static") === "1";
  const themes = useMemo(() => (mode === "both" ? (["light", "dark"] as const) : ([mode] as const)), [mode]);
  const show = (id: string) => section === "all" || section === id;

  return (
    <div className={cx(styles.page, isStatic && styles.static)} data-ds-gallery="">
      <div className={styles.topbar}>
        <span className={styles.brand}>Design system</span>
        <SegmentedControl label="Themes shown" value={mode} onChange={(v) => setMode(v as Mode)} options={[{ value: "both", label: "Both" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <Select label="Section" value={section} options={SECTIONS} onChange={setSection} width={140} />
        <SearchField value={query} onChange={setQuery} placeholder="Filter components" style={{ width: 200, flex: "none" }} />
        <Select label="Zoom" value={zoom} options={[{ value: "100", label: "100%" }, { value: "200", label: "200%" }]} onChange={setZoom} width={80} />
        <span className={styles.grow} />
        <Select
          label="App theme"
          value={app.preference}
          width={170}
          options={[{ value: "system", label: "Use system setting" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          onChange={(v) => setThemePreference(v as ThemePreference)}
        />
      </div>
      <div className={styles.scroll}>
        <div style={{ zoom: Number(zoom) / 100 }}>
          {(show("tokens") || show("icons") || show("components")) && (
            <div className={cx(styles.columns, mode === "both" && styles.both)}>
              {themes.map((t) => (
                <GalleryContext.Provider key={t} value={{ query, theme: t, isStatic }}>
                  <div data-theme={t} className={styles.column} data-gallery-theme={t}>
                    <div className={styles.themeLabel}>{t}</div>
                    {show("tokens") && <TokensSection />}
                    {show("icons") && <IconsSection />}
                    {show("components") && <ComponentMatrix />}
                  </div>
                </GalleryContext.Provider>
              ))}
            </div>
          )}
          {show("screens") &&
            themes.map((t) => (
              <GalleryContext.Provider key={t} value={{ query: "", theme: t, isStatic }}>
                <div data-theme={t} className={styles.screensBlock} data-gallery-theme={t}>
                  <div className={styles.themeLabel}>{t}</div>
                  <ScreensSection />
                </div>
              </GalleryContext.Provider>
            ))}
        </div>
      </div>
      <TooltipManager />
      <ToastHost />
    </div>
  );
}
