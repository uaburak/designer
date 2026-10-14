/**
 * "Bring images from Figma" (docs/desktop.md §13 "Images from Figma"): Figma's clipboard names images by hash and
 * keeps the bytes on its servers, so a paste brings them with the person's own personal access token. The dialog
 * walks through making one (Figma › Settings › Security › Personal access tokens › Generate new token, File content
 * read-only), checks it with Figma, says whose it is, then brings the paste's images in. Settings › Account opens it
 * too, without a paste (connect / replace the token).
 */
import { useEffect, useRef, useState } from "react";
import { Banner, Button, Dialog, Icon, Spinner, TextInput } from "@/ds";
import { t, tp, useT } from "@/i18n";
import { FIGMA_SETTINGS_URL, type FigmaApiError, type FigmaUser } from "@shared/figmaApi";
import { openLink } from "../settings/bridge";
import type { FigmaClient } from "./connection";
import styles from "./FigmaConnect.module.css";

/** What bringing a paste's images came to. */
export type BringOutcome = { ok: true; brought: number; missing: number } | { ok: false; error: FigmaApiError };

export interface PendingImages {
  /** Images the paste is waiting for */
  count: number;
  /** Fetches and ingests them (with the connection now made) */
  run(onProgress: (done: number, total: number) => void): Promise<BringOutcome>;
}

/** A Figma error, in words. `web`: the browser build (a refused request looks like no connection there). */
export function figmaErrorText(error: FigmaApiError, web = false): string {
  switch (error) {
    case "invalid-token":
    case "no-token":
      return t("Figma didn’t accept this token. Check that you copied all of it, or generate a new one.");
    case "expired":
      return t("This token has expired. Generate a new one in Figma and paste it here.");
    case "no-access":
      return t("This token can’t read the file you copied from. Make sure you can open that file in Figma, and that the token’s File content scope is set to Read-only.");
    case "not-found":
      return t("Figma couldn’t find the file you copied from. You need access to that file in Figma.");
    case "rate-limited":
      return t("Figma is receiving too many requests right now. Wait a minute and try again.");
    case "offline":
      return web ? t("Couldn’t reach Figma from the browser. Check your connection, or use the desktop app, which can always reach Figma.") : t("Couldn’t reach Figma. Check your internet connection and try again.");
    default:
      return t("Something went wrong while talking to Figma. Try again.");
  }
}

/** "Connected as Ada Lovelace (ada@example.com)" */
export function connectedText(user: FigmaUser | null): string {
  if (!user || (!user.handle && !user.email)) return t("Connected to Figma");
  if (user.handle && user.email) return t("Connected as {name} ({email})", { name: user.handle, email: user.email });
  return t("Connected as {name}", { name: user.handle || user.email });
}

type Phase = { kind: "form" } | { kind: "checking" } | { kind: "fetching"; user: FigmaUser | null; done: number; total: number } | { kind: "done"; user: FigmaUser | null; outcome: BringOutcome | null };

export function FigmaConnectDialog({ client, pending, reason, onClose }: { client: FigmaClient; pending?: PendingImages | null; reason?: FigmaApiError | null; onClose: () => void }) {
  useT();
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [error, setError] = useState<FigmaApiError | null>(reason ?? null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const web = client.kind === "web";

  const connect = async () => {
    if (!token.trim()) return;
    setError(null);
    setPhase({ kind: "checking" });
    const r = await client.connect(token);
    if (!live.current) return;
    if (!r.ok) {
      setError(r.error);
      setPhase({ kind: "form" });
      return;
    }
    setToken("");
    const user = r.value.user;
    if (!pending) return setPhase({ kind: "done", user, outcome: null });
    setPhase({ kind: "fetching", user, done: 0, total: pending.count });
    const outcome = await pending.run((done, total) => live.current && setPhase({ kind: "fetching", user, done, total }));
    if (!live.current) return;
    if (!outcome.ok && outcome.error !== "rate-limited" && outcome.error !== "offline") {
      // The token was good for /v1/me but not for this file (no access, the scope): back to the form, with why.
      setError(outcome.error);
      setPhase({ kind: "form" });
      return;
    }
    setPhase({ kind: "done", user, outcome });
  };

  const title = pending ? t("Bring images from Figma") : t("Connect to Figma");
  if (phase.kind === "fetching" || phase.kind === "done") {
    const outcome = phase.kind === "done" ? phase.outcome : null;
    return (
      <Dialog
        open
        size="medium"
        title={title}
        onClose={onClose}
        footer={
          <Button variant="primary" disabled={phase.kind === "fetching"} onClick={onClose} data-figma-done="">
            {t("Done")}
          </Button>
        }
      >
        <div className={styles.body} data-figma-connect={phase.kind}>
          <div className={styles.account}>
            <Icon name="24.check" />
            <span data-figma-account="">{connectedText(phase.user)}</span>
          </div>
          {phase.kind === "fetching" && (
            <div className={styles.progress} role="status">
              <Spinner />
              <span>{phase.total ? t("Bringing {done} of {total} images…", { done: phase.done, total: phase.total }) : t("Bringing images from Figma…")}</span>
            </div>
          )}
          {outcome?.ok && (
            <p className={styles.lead} role="status">
              {tp(outcome.brought, "Brought {n} image from Figma.", "Brought {n} images from Figma.")}
              {outcome.missing > 0 && ` ${tp(outcome.missing, "{n} image wasn’t found in the Figma file.", "{n} images weren’t found in the Figma file.")}`}
            </p>
          )}
          {outcome && !outcome.ok && <Banner tone="danger">{figmaErrorText(outcome.error, web)}</Banner>}
          {!pending && <p className={styles.muted}>{t("Images in layers you paste from Figma will come along from now on.")}</p>}
        </div>
      </Dialog>
    );
  }

  const checking = phase.kind === "checking";
  return (
    <Dialog
      open
      size="medium"
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-figma-not-now="">
            {pending ? t("Not now") : t("Cancel")}
          </Button>
          <Button variant="primary" disabled={!token.trim()} loading={checking} onClick={() => void connect()} data-figma-connect-button="">
            {t("Connect")}
          </Button>
        </>
      }
    >
      <div className={styles.body} data-figma-connect="form">
        {error && <Banner tone="danger" data-figma-error={error}>{figmaErrorText(error, web)}</Banner>}
        <p className={styles.lead}>
          {pending
            ? tp(pending.count, "Figma doesn’t put images on the clipboard, so {n} image in what you pasted is shown as a placeholder. Connect your Figma account once and images will come along whenever you paste.", "Figma doesn’t put images on the clipboard, so {n} images in what you pasted are shown as placeholders. Connect your Figma account once and images will come along whenever you paste.")
            : t("Connect your Figma account to bring images along when you paste layers from Figma.")}
        </p>
        <p className={styles.muted}>{t("You need a personal access token from Figma. It takes a minute:")}</p>
        <ol className={styles.steps}>
          <li>
            {t("In Figma, click your account menu at the top left and choose Settings.")}
            <div>
              <Button variant="secondary" className={styles.open} onClick={() => openLink(FIGMA_SETTINGS_URL)} data-figma-open-settings="">
                {t("Open Figma settings")}
              </Button>
            </div>
          </li>
          <li>{t("Open the Security tab and find Personal access tokens.")}</li>
          <li>{t("Click Generate new token and give it a name, such as “Designer”.")}</li>
          <li>{t("Choose when it expires. Under Scopes, set File content to Read-only. To see your name here, also set Current user to Read-only.")}</li>
          <li>{t("Click Generate token and copy the token. Figma shows it only once.")}</li>
          <li>{t("Paste it below and click Connect.")}</li>
        </ol>
        <div className={styles.field}>
          <span className={styles.label}>{t("Personal access token")}</span>
          <TextInput label={t("Personal access token")} value={token} onChange={setToken} placeholder="figd_…" secret selectAllOnFocus={false} disabled={checking} variant="outlined" data-figma-token="" />
        </div>
        <p className={styles.muted}>
          {web
            ? t("In the browser, the token is kept only until you close this tab, and it is sent only to Figma.")
            : t("The token is stored encrypted on this computer and is sent only to Figma.")}{" "}
          {t("You need to be able to open the file you copy from in Figma.")}
        </p>
      </div>
    </Dialog>
  );
}
