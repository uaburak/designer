/**
 * Personal Drafts in the cloud for Home (docs/cloud.md §2): the store's sync status — whose Drafts are shown (null:
 * the local workspace, signed out or the browser's dev store) and whether the server answered. Home asks the store to
 * list the Drafts again when it is shown and when its window comes back to the front, at most every few seconds.
 */
import { useEffect, useState } from "react";
import type { CloudRepository, CloudStatus } from "@shared/store/cloud";

/** Refreshes asked for by focus come at most this often */
export const REFRESH_EVERY_MS = 10_000;

export function useCloud(cloud: CloudRepository | undefined): CloudStatus | null {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  useEffect(() => {
    if (!cloud) return;
    let live = true;
    let last = 0;
    const set = (s: CloudStatus) => void (live && setStatus(s));
    const refresh = () => {
      const now = Date.now();
      if (now - last < REFRESH_EVERY_MS) return;
      last = now;
      void cloud.refresh().then(set, () => {});
    };
    void cloud.status().then(
      (s) => {
        set(s);
        if (s.uid) refresh();
      },
      () => {},
    );
    const off = cloud.watch((e) => {
      if (e.type === "status") set(e.status);
    });
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [cloud]);
  return status;
}

/** Signed in and the server didn't answer: Home lists only what is on this computer, each with the offline badge */
export const isOffline = (s: CloudStatus | null): boolean => !!s?.uid && s.checked && !s.online;
