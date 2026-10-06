import { dialog, type BaseWindow, type MessageBoxOptions } from "electron";

/**
 * The shell's questions, as native message boxes: a view's DOM can't cover
 * the other views (docs/desktop.md §7). Wording in Figma's/macOS's style.
 *
 * Under test (DESIGNER_TEST=1, scripts/drive.mjs), a queued answer
 * (`testAnswers`, a button's label) replaces the box, and each question is
 * logged — so a scripted run can close unsaved tabs.
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

/** Closing one unsaved tab. */
export async function askSaveTab(win: BaseWindow | null, title: string): Promise<"save" | "discard" | "cancel"> {
  const answer = await ask(win, {
    type: "warning",
    message: `Do you want to save the changes you made to “${title}”?`,
    detail: "Your changes will be lost if you don’t save them. Saving writes the draft — the site changes only when you publish.",
    buttons: ["Save", "Don’t Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });
  return answer === "Save" ? "save" : answer === "Don’t Save" ? "discard" : "cancel";
}

/** Closing the window, quitting or signing out with unsaved tabs. */
export async function askSaveAll(win: BaseWindow | null, titles: string[], action: "close" | "quit" | "sign-out"): Promise<"save" | "discard" | "cancel"> {
  const discard = action === "sign-out" ? "Sign Out Without Saving" : action === "quit" ? "Quit Without Saving" : "Close Without Saving";
  const answer = await ask(win, {
    type: "warning",
    message: titles.length === 1 ? `Do you want to save the changes you made to “${titles[0]}”?` : `You have unsaved changes in ${titles.length} files. Do you want to save them?`,
    detail: titles.length === 1 ? "Your changes will be lost if you don’t save them." : `${titles.map((t) => `• ${t}`).join("\n")}\n\nYour changes will be lost if you don’t save them.`,
    buttons: [titles.length === 1 ? "Save" : "Save All", discard, "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });
  return answer === "Save" || answer === "Save All" ? "save" : answer === discard ? "discard" : "cancel";
}

/** A tab's renderer process went away. */
export async function askCrashed(win: BaseWindow | null, title: string): Promise<"reload" | "close"> {
  const answer = await ask(win, {
    type: "error",
    message: `“${title}” crashed.`,
    detail: "This tab stopped working. Changes that weren’t saved are lost; your other tabs are fine.",
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
    detail: "You can wait for it or reload the tab. Reloading loses changes that weren’t saved.",
    buttons: ["Wait", "Reload Tab"],
    defaultId: 0,
    cancelId: 0,
    signal,
  });
  return answer === "Reload Tab" ? "reload" : "wait";
}

/** A save asked of a tab that didn't go through. */
export async function tellSaveFailed(win: BaseWindow | null, title: string, reason: string) {
  await ask(win, { type: "error", message: `“${title}” couldn’t be saved.`, detail: reason, buttons: ["OK"], defaultId: 0, cancelId: 0 });
}
