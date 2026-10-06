/**
 * What the window and the desktop say to each other (the preload's
 * `window.designer`): the app's menu, closing with unsaved work, the theme,
 * links, the Google sign-in. Types only — main, preload and the renderer
 * all read them.
 */

/** What a menu item (or its keys) asks: the shell does it, or passes it to the open tab. */
export type MenuCommand =
  | "new-project"
  | "close-tab"
  | "reopen-tab"
  | "next-tab"
  | "previous-tab"
  | "home"
  | `tab-${number}`
  | "save"
  | "toggle-theme"
  | "sign-out";

export type ThemePreference = "system" | "light" | "dark";

/** A Google sign-in made in the browser, handed to the app: Firebase signs in with it (signInWithCredential). */
export interface GoogleCredential {
  idToken: string;
  accessToken: string | null;
}

/** How the browser's sign-in ended, as main answers it (a rejected IPC handler would be logged as an error: a cancel isn't one). */
export type SignInResult = { credential: GoogleCredential } | { cancelled: true } | { error: string };

export interface NativeApi {
  platform: string;
  version: string;
  /** The sign-in, in the system's browser — it settles once the account is picked there (or fails, or is cancelled) */
  signInWithGoogle(): Promise<GoogleCredential>;
  cancelSignIn(): void;
  /** An http(s) address, in the system's browser */
  openExternal(url: string): void;
  setTheme(theme: ThemePreference): void;
  /** On: closing the window asks the page first (onCloseRequested); it closes with closeWindow, or stays (cancelClose) */
  setCloseGuard(on: boolean): void;
  closeWindow(): void;
  cancelClose(): void;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  onCloseRequested(listener: () => void): () => void;
  onFullScreen(listener: (fullScreen: boolean) => void): () => void;
  isFullScreen(): Promise<boolean>;
}
