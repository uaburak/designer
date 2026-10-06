/**
 * `?files`: the new Home, Figma's file browser on the store (docs/home.md). Mounts the DS's managers and the theme,
 * finds the workspace (storeAccess.ts) and shows the browser.
 */
import "@/ds/global.css";
import { useEffect, useState } from "react";
import { Spinner, ToastHost, TooltipManager, useThemeRoot } from "@/ds";
import { FileBrowser } from "./FileBrowser";
import { filesBackend, type FilesBackend } from "./storeAccess";
import styles from "./Files.module.css";

export default function FilesApp() {
  useThemeRoot();
  const [backend, setBackend] = useState<FilesBackend | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    filesBackend().then(
      (b) => live && setBackend(b),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  // The desktop shell shows the window once the first view has painted.
  useEffect(() => {
    if (backend) (window as unknown as { designer?: { ready?: () => void } }).designer?.ready?.();
  }, [backend]);
  return (
    <>
      {backend ? (
        <FileBrowser backend={backend} />
      ) : (
        <div className={styles.app} style={{ display: "flex" }}>
          <div className={styles.center} style={{ flex: 1 }}>
            {error ? <p className={styles.dialogText}>{error}</p> : <Spinner size={24} />}
          </div>
        </div>
      )}
      <TooltipManager />
      <ToastHost />
    </>
  );
}
