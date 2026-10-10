/**
 * "Password required" (docs/multiplayer.md §3; help.figma.com 5726720100247): someone who reaches a file by its link —
 * not invited — enters the password the file's editors set, once per password. Asked when a link opens (Home) and when
 * an open file's password changes (the editor: `FileShareState.locked`).
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Dialog, TextInput } from "@/ds";
import { isStoreError } from "@shared/store/protocol";
import styles from "./Files.module.css";

/** The error is a link password asked for (or a wrong one given). */
export const passwordAsked = (e: unknown): { wrong: boolean } | null => {
  const d = isStoreError(e) ? (e.detail as { passwordRequired?: boolean; wrong?: boolean } | undefined) : undefined;
  return d?.passwordRequired ? { wrong: d.wrong === true } : null;
};

/**
 * Runs `attempt` with the password the person types until it stops asking for one; null when they cancel. The first
 * try is made without a password, unless `ask` says to start with the dialog.
 */
export async function withLinkPassword<T>(attempt: (password?: string) => Promise<T>, { ask = false }: { ask?: boolean } = {}): Promise<T | null> {
  let wrong = false;
  if (!ask) {
    try {
      return await attempt();
    } catch (e) {
      if (!passwordAsked(e)) throw e;
    }
  }
  for (;;) {
    const password = await promptPassword(wrong);
    if (password === null) return null;
    try {
      return await attempt(password);
    } catch (e) {
      const asked = passwordAsked(e);
      if (!asked) throw e;
      wrong = asked.wrong;
    }
  }
}

function promptPassword(wrong: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: string | null) => {
      root.unmount();
      host.remove();
      resolve(v);
    };
    root.render(<PasswordDialog wrong={wrong} onDone={done} />);
  });
}

function PasswordDialog({ wrong, onDone }: { wrong: boolean; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState("");
  return (
    <Dialog
      title="This file is password protected"
      size="small"
      open
      onClose={() => onDone(null)}
      footer={
        <>
          <Button variant="secondary" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!value} onClick={() => onDone(value)} data-link-password="continue">
            Continue
          </Button>
        </>
      }
    >
      <TextInput label="Password" placeholder="Enter password" value={value} onChange={setValue} secret autoFocus invalid={wrong && !value} data-link-password="" />
      {wrong && <p className={styles.passwordError}>Incorrect password. Try again.</p>}
    </Dialog>
  );
}
