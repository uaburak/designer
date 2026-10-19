/**
 * Figma's multiplayer signals in the editor's words (docs/multiplayer.md §18.13; atlas 19 §2.3, §8). Each signal has
 * Figma's two cases — with unsaved changes (`unsaved_changes.syncing.changes_cannot_be_saved` plus the reason) and
 * without — and the limit notices the C++ raises (`your_cursor_has_been_hidden_from_others_users`, …). Figma's English
 * bundle isn't in the cache: the words are the keys' own, as sentences, with the one attested line ("someone revoked
 * access to the file you had open, ask the owner for access to open it again") as it is; where Wecra keeps changes
 * that Figma would drop, the second sentence says where they are.
 */
import type { MultiplayerSignal } from "@shared/multiplayer/types";
import { MAX_CURSORS, MAX_EDITORS } from "@shared/multiplayer/protocol";
import { t } from "@/i18n";

export interface SignalToast {
  message: string;
  /** An error toast (the file can't be worked on together now) rather than a bell */
  error: boolean;
  /** Stays until closed */
  sticky: boolean;
}

export function signalToast(signal: MultiplayerSignal, unsaved: boolean): SignalToast {
  switch (signal) {
    case "too-many-connections":
      return unsaved
        ? { message: t("Changes can’t be saved: there are too many people in this file. They’re kept on this computer and saved when there’s room."), error: true, sticky: true }
        : { message: t("Too many people are in this file. You’ll join it when there’s room."), error: true, sticky: true };
    case "invalid-permissions":
      return unsaved
        ? { message: t("Changes can’t be saved: someone revoked your access to this file. They’re kept in this copy, in your drafts."), error: true, sticky: true }
        : { message: t("Someone revoked access to the file you had open. Ask the owner for access to open it again."), error: true, sticky: true };
    case "client-too-old":
      return unsaved
        ? { message: t("Changes can’t be saved: the app is out of date. Update it to save them; they’re kept on this computer."), error: true, sticky: true }
        : { message: t("The app is out of date for this file. Update it to keep working together."), error: true, sticky: true };
    case "message-decode-failure":
      return { message: unsaved ? t("Experiencing server issues. Your changes are kept and sent again.") : t("Experiencing server issues."), error: true, sticky: false };
    case "converted-to-viewer":
      return {
        message: unsaved
          ? t("You’ve been converted to a viewer with a hidden cursor: this file has reached {n} editors at a time. Your changes are kept and saved when you can edit again.", { n: MAX_EDITORS })
          : t("You’ve been converted to a viewer with a hidden cursor: this file has reached {n} editors at a time.", { n: MAX_EDITORS }),
        error: false,
        sticky: true,
      };
    case "cursor-hidden":
      return { message: t("Your cursor has been hidden from other users: this file shows {n} cursors at most.", { n: MAX_CURSORS }), error: false, sticky: false };
    case "cursor-visible-observed":
      return { message: t("Your cursor is now visible to others as someone is observing you"), error: false, sticky: false };
    case "cursor-visible-left":
      return { message: t("Your cursor is now visible to others as users have left the file"), error: false, sticky: false };
  }
}
