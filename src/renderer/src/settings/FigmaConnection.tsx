/**
 * Settings › Account › Figma connection (docs/desktop.md §13 "Images from Figma"): whose Figma token is kept (sealed
 * in main on the desktop; this tab's session in a browser), Replace token / Disconnect, or Connect to Figma… — the
 * same dialog a paste opens.
 */
import { useEffect, useMemo, useState } from "react";
import { t, useT } from "@/i18n";
import type { FigmaConnection as Connection } from "@shared/ipc";
import { figmaClient, onFigmaConnectionChange } from "../figma/connection";
import { FigmaConnectDialog, connectedText } from "../figma/FigmaConnectDialog";
import styles from "./Settings.module.css";

export function FigmaConnection() {
  useT();
  const client = useMemo(() => figmaClient(), []);
  const [state, setState] = useState<Connection | null>(null);
  const [dialog, setDialog] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => void client.status().then((s) => live && setState(s), () => live && setState({ connected: false, user: null }));
    load();
    const off = onFigmaConnectionChange(load);
    return () => {
      live = false;
      off();
    };
  }, [client]);
  return (
    <section className={styles.section} data-settings-section="figma">
      <h3 className={styles.heading}>{t("Figma connection")}</h3>
      <p className={styles.text}>
        {state?.connected ? connectedText(state.user) : t("Not connected. Connect your Figma account to bring images along when you paste layers from Figma.")}
        {state?.connected && client.kind === "web" && ` ${t("Kept until you close this tab.")}`}
      </p>
      {state?.connected ? (
        <>
          <button type="button" className={styles.link} onClick={() => setDialog(true)} data-figma-replace="">
            {t("Replace token")}
          </button>
          <button type="button" className={[styles.link, styles.danger].join(" ")} onClick={() => void client.disconnect()} data-figma-disconnect="">
            {t("Disconnect")}
          </button>
        </>
      ) : (
        <button type="button" className={styles.link} disabled={!state} onClick={() => setDialog(true)} data-figma-connect-link="">
          {t("Connect to Figma…")}
        </button>
      )}
      {dialog && <FigmaConnectDialog client={client} onClose={() => setDialog(false)} />}
    </section>
  );
}
