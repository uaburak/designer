/**
 * Figma's Settings modal (help.figma.com 1500006061462; the owner's screenshots 3–9.png; docs/design-system.md
 * "Settings modal"): "Account | Community | Notifications | Security" — and ours, "AI" (providers, credits, local models;
 * docs/ai.md §7) and "Agents" (the settings of our own AIs) — beside the close button, a scrolling body under them. Opened from Home's account menu (Settings) and the
 * editor's main menu (Help and account › Account settings); `SettingsHost` renders it in each view.
 */
import { useRef } from "react";
import { IconButton, Portal } from "@/ds";
import { useFocusScope } from "@/ds/overlay/FocusTrap";
import { AccountTab } from "./AccountTab";
import { AgentsTab } from "./AgentsTab";
import { AiBalanceHost } from "./AiBalance";
import { AiTab } from "./AiTab";
import { closeSettings, setSettingsTab, SETTINGS_TABS, useSettingsState, type SettingsTab } from "./bridge";
import { CommunityTab } from "./CommunityTab";
import { NotificationsTab } from "./NotificationsTab";
import { SecurityTab } from "./SecurityTab";
import styles from "./Settings.module.css";

export interface SettingsModalProps {
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
}

export function SettingsModal({ tab, onTab, onClose }: SettingsModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusScope(panel, { trap: true, enabled: true });
  const move = (dir: 1 | -1) => {
    const i = SETTINGS_TABS.findIndex((t) => t.id === tab);
    const next = SETTINGS_TABS[(i + dir + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    onTab(next.id);
    panel.current?.querySelector<HTMLElement>(`[data-settings-tab="${next.id}"]`)?.focus();
  };
  return (
    <Portal>
      <div className={styles.scrim} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
        <div
          ref={panel}
          role="dialog"
          aria-modal
          aria-label="Settings"
          tabIndex={-1}
          className={styles.modal}
          data-settings-modal=""
          onKeyDown={(e) => {
            if (e.key === "Escape" && !e.defaultPrevented) {
              e.stopPropagation();
              onClose();
            }
          }}
        >
          <div className={styles.header}>
            <div role="tablist" aria-label="Settings" className={styles.tabs}>
              {SETTINGS_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${t.id}`}
                  aria-selected={t.id === tab}
                  aria-controls="settings-panel"
                  tabIndex={t.id === tab ? 0 : -1}
                  className={styles.tab}
                  data-settings-tab={t.id}
                  onClick={() => onTab(t.id)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight") move(1);
                    else if (e.key === "ArrowLeft") move(-1);
                    else return;
                    e.preventDefault();
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <IconButton icon="24.close.small" label="Close" tooltip={false} onClick={onClose} data-settings-close="" />
          </div>
          <div className={styles.body} role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${tab}`} data-settings-panel={tab}>
            {tab === "account" && <AccountTab />}
            {tab === "community" && <CommunityTab />}
            {tab === "notifications" && <NotificationsTab />}
            {tab === "security" && <SecurityTab />}
            {tab === "ai" && <AiTab />}
            {tab === "agents" && <AgentsTab />}
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** The modal while it is open (`openSettings`), in the view that opened it. */
export function SettingsHost() {
  const { open, tab } = useSettingsState();
  return (
    <>
      {open && <SettingsModal tab={tab} onTab={setSettingsTab} onClose={closeSettings} />}
      {/* "AI balance" (main menu, Settings › AI › See usage) — docs/ai.md §7 */}
      <AiBalanceHost />
    </>
  );
}
