import { dialog, type BaseWindow, type MessageBoxOptions } from "electron";

/**
 * The shell's questions, as native message boxes: a view's DOM can't cover
 * the other views (docs/desktop.md §7). Wording in Figma's/macOS's style.
 *
 * Under test (DESIGNER_TEST=1, scripts/drive.mjs), a queued answer
 * (`testAnswers`, a button's label) replaces the box, and each question is
 * logged — so a scripted run can answer them.
 */

export const testAnswers: string[] = [];
export const asked: { message: string; buttons: string[]; answer: string }[] = [];

async function ask(win: BaseWindow | null, options: MessageBoxOptions & { buttons: string[] }): Promise<string> {
  if (process.env.DESIGNER_TEST === "1" && testAnswers.length) {
    const answer = testAnswers.shift()!;
    asked.push({ message: options.message, buttons: options.buttons, answer });
    console.log(`[dialog] ${options.message} → ${answer}`);
    return answer;
  }
  const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  const answer = options.buttons[response] ?? options.buttons[options.cancelId ?? 0];
  if (process.env.DESIGNER_TEST === "1") asked.push({ message: options.message, buttons: options.buttons, answer });
  return answer;
}

/** A tab's renderer process went away. */
export async function askCrashed(win: BaseWindow | null, title: string): Promise<"reload" | "close"> {
  const answer = await ask(win, {
    type: "error",
    message: `“${title}” crashed.`,
    detail: "Your work is saved up to the moment the tab stopped. Your other tabs are fine.",
    buttons: ["Reload", "Close Tab"],
    defaultId: 0,
    cancelId: 0,
  });
  return answer === "Close Tab" ? "close" : "reload";
}

/** A tab's page has hung. `signal` takes the box away when it answers again. */
export async function askUnresponsive(win: BaseWindow | null, title: string, signal: AbortSignal): Promise<"wait" | "reload"> {
  const answer = await ask(win, {
    type: "warning",
    message: `“${title}” isn’t responding.`,
    detail: "You can wait for it or reload the tab. Changes from the last few seconds may not be saved.",
    buttons: ["Wait", "Reload Tab"],
    defaultId: 0,
    cancelId: 0,
    signal,
  });
  return answer === "Reload Tab" ? "reload" : "wait";
}


// ── Files that save as they go (docs/desktop.md §6, §9) ──────────────────────

/** A file tab's flush failed in the store: try again, let it go, or stay. */
export async function askFlushFailed(win: BaseWindow | null, title: string, reason: string, action: "close" | "quit"): Promise<"retry" | "go" | "cancel"> {
  const go = action === "quit" ? "Quit Anyway" : "Close Anyway";
  const answer = await ask(win, {
    type: "warning",
    message: `Your recent changes to “${title}” couldn’t be saved.`,
    detail: reason,
    buttons: ["Try Again", go, "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });
  return answer === "Try Again" ? "retry" : answer === go ? "go" : "cancel";
}

/** A file tab didn't answer its flush in time. */
export async function askFlushTimeout(win: BaseWindow | null, title: string, action: "close" | "quit"): Promise<"wait" | "go"> {
  const go = action === "quit" ? "Quit Anyway" : "Close Tab";
  const answer = await ask(win, {
    type: "warning",
    message: `“${title}” isn’t responding.`,
    detail: "Changes from the last few seconds may not be saved.",
    buttons: ["Wait", go],
    defaultId: 0,
    cancelId: 0,
  });
  return answer === go ? "go" : "wait";
}

/** The store stopped for the 4th time in a minute. */
export async function askStoreGone(): Promise<"retry" | "quit"> {
  const answer = await ask(null, {
    type: "error",
    message: "DesignerV2 can’t save changes right now.",
    detail: "The part of DesignerV2 that saves your files stopped several times. Changes made since then may not be saved.",
    buttons: ["Try Again", "Quit"],
    defaultId: 0,
    cancelId: 0,
  });
  return answer === "Quit" ? "quit" : "retry";
}

/** An import or a local copy that didn't go through. */
export async function tellFileError(win: BaseWindow | null, message: string, detail: string) {
  await ask(win, { type: "error", message, detail, buttons: ["OK"], defaultId: 0, cancelId: 0 });
}
