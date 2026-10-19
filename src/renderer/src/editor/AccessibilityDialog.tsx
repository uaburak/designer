/**
 * Preferences › Accessibility settings… (atlas 21 §4.1, Figma's `ACCESSIBILITY_SETTINGS` modal): seven switches in
 * Figma's order, each a label and a description —
 * 1. Screen reader: kept on this machine and with the account (preferences.ts ROAMING); the canvas's accessible DOM
 *    mirror it turns on in Figma isn't built yet.
 * 2. Underline links: every view's links underlined (ds/theme.ts, `data-underline-links`).
 * 3. Simpler focus in the Actions menu: Tab / ⇧Tab move through the results (ActionsPanel.tsx).
 * 4. Enhanced contrast: Settings › Account's switch, the same store (unset: the system's `prefers-contrast`).
 * 5. Shortcuts in text fields: the menu bar's shortcuts ignored while text is edited on the canvas (desktop.ts).
 * 6. Rotation shortcuts: Preferences' "Use ⌘⌥↑/↓ to rotate layers", the same preference.
 * 7. Spotlight auto-follow: kept for multiplayer's spotlight (docs/roadmap.md Phase 6).
 * The labels and descriptions are unverified (the build has only their keys, atlas 21 §12 #4): the descriptions of
 * 1, 3, 5 and 7 are help.figma.com's ("Use Figma with a screen reader", 35063862380311), 4's Settings', 6's the
 * Preferences item's.
 */
import { Dialog, IS_MAC, Switch, setContrast, setUnderlineLinks, useTheme } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "./controller";
import { useUI } from "./hooks";
import { pref, setPreference, type PreferenceKey } from "./preferences";
import styles from "./AccessibilityDialog.module.css";

export function AccessibilityDialog() {
  const open = useUI((s) => !!s.accessibilityDialog);
  return open ? <AccessibilityForm /> : null;
}

/** A switch row: the label, its description under it, the switch on the right. */
function Row({ id, label, description, checked, onChange }: { id: string; label: string; description?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={styles.row} data-a11y-row={id}>
      <div className={styles.text}>
        <span className={styles.label}>{label}</span>
        {description && <span className={styles.description}>{description}</span>}
      </div>
      <Switch label={label} size="large" checked={checked} onChange={onChange} />
    </div>
  );
}

function AccessibilityForm() {
  useT();
  const ed = useEditor();
  const ui = useUI((s) => s);
  const theme = useTheme();
  const close = () => {
    ed.ui.set({ accessibilityDialog: false });
    ed.focusCanvas();
  };
  const editor = (key: PreferenceKey) => ({ checked: pref(ui, key), onChange: (on: boolean) => setPreference(ed, key, on) });
  return (
    <Dialog title={t("Accessibility settings")} size="medium" open onClose={close}>
      <div className={styles.rows}>
        <Row id="screen-reader" label={t("Screen reader")} description={t("Adapt content to screen readers")} {...editor("screenReader")} />
        <Row id="underline-links" label={t("Underline links")} checked={theme.underlineLinks} onChange={setUnderlineLinks} />
        <Row id="actions-tab-focus" label={t("Actions menu focus")} description={t("Simplify focus navigation in the Actions menu")} {...editor("actionsTabFocus")} />
        <Row id="enhanced-contrast" label={t("Enhanced contrast")} description={t("When enabled, contrast between text and controls and their backgrounds will be increased")} checked={theme.contrast} onChange={setContrast} />
        <Row id="text-input-shortcuts" label={t("Shortcuts in text fields")} description={t("Ignore Wecra-specific shortcuts in text fields")} {...editor("textInputShortcutBlocking")} />
        <Row id="rotation-shortcuts" label={t("Rotation shortcuts")} description={IS_MAC ? t("Use ⌘⌥↑/↓ to rotate layers") : t("Use Ctrl+Alt+↑/↓ to rotate layers")} {...editor("rotateWithArrows")} />
        <Row id="spotlight-auto-follow" label={t("Follow spotlight automatically")} description={t("Automatically follow a collaborator when they turn on spotlight in a file")} {...editor("spotlightAutoFollow")} />
      </div>
    </Dialog>
  );
}
