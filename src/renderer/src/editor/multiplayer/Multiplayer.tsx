/**
 * The editor's multiplayer chrome (docs/multiplayer.md §6): starts presence for a shared file, draws the observation
 * frame (a border in the followed person's colour around the canvas, their name at the top), makes "can view" files
 * read-only, and offers the fresh copy when this one fell behind the room's history.
 */
import { useEffect, useRef } from "react";
import { Avatar, IconButton, showToast, tooltipProps } from "@/ds";
import { useEditor } from "../controller";
import { editorBridge } from "../desktop";
import { presenceOf, usePresence, type Peer } from "./presence";
import styles from "./Multiplayer.module.css";

/** Rendered once in the canvas view: presence runs while it is mounted. */
export function Multiplayer() {
  const ed = useEditor();
  const state = usePresence(ed);
  useEffect(() => {
    const p = presenceOf(ed);
    if (!p) return;
    p.start();
    return () => p.stop();
  }, [ed]);

  // "can view": the file opens read-only (Figma's view-only), as long as that is the role.
  const viewer = state.shared && state.role === "viewer";
  useEffect(() => {
    if (!viewer || ed.engine.destroyed) return;
    ed.engine.setViewerMode(true);
    showToast({ message: "You can view this file. Ask its owner for edit access." });
    return () => {
      if (!ed.engine.destroyed) ed.engine.setViewerMode(false);
    };
  }, [ed, viewer]);

  const shown = useRef<string | null>(null);
  useEffect(() => {
    const to = state.replacedBy;
    if (!to || shown.current === to) return;
    shown.current = to;
    showToast({
      message: "This file changed a lot while you were away. The latest version is in your files; this copy is no longer shared.",
      duration: 0,
      action: {
        label: "Open latest",
        onAction: () => {
          const bridge = editorBridge();
          if (bridge) void bridge.nav.openFile(to);
          else location.assign(`${location.pathname}?editor&file=${encodeURIComponent(to)}`);
        },
      },
    });
  }, [state.replacedBy]);

  const followed = state.peers.find((p) => p.id === state.following);
  if (!followed) return null;
  return (
    <div className={styles.follow} style={{ "--peer": followed.color } as React.CSSProperties} data-following={followed.name}>
      <span className={styles.followLabel}>
        {followed.presence?.spotlight ? `${followed.name} is spotlighting` : `Following ${followed.name}`}
        <button type="button" className={styles.followStop} onClick={() => presenceOf(ed)?.stopFollowing()}>
          Stop
        </button>
      </span>
    </div>
  );
}

/** The header's people: up to three avatars in their colours (click: follow), then "+N". */
export function PeerAvatars() {
  const ed = useEditor();
  const state = usePresence(ed);
  if (!state.shared || !state.peers.length) return null;
  const shown = state.peers.slice(0, 3);
  const more = state.peers.length - shown.length;
  return (
    <span className={styles.peers} data-peers={state.peers.length}>
      {shown.map((p) => (
        <PeerAvatar key={p.id} peer={p} following={state.following === p.id} />
      ))}
      {more > 0 && <span className={styles.more}>+{more}</span>}
    </span>
  );
}

function PeerAvatar({ peer, following }: { peer: Peer; following: boolean }) {
  const ed = useEditor();
  const label = following ? `Stop following ${peer.name}` : `Follow ${peer.name}`;
  return (
      <button
        type="button"
        {...tooltipProps(`${peer.name}${peer.role === "viewer" ? " (can view)" : ""}`)}
        className={styles.peer}
        data-following={following || undefined}
        style={{ "--peer": peer.color } as React.CSSProperties}
        aria-label={label}
        aria-pressed={following}
        onClick={() => {
          const p = presenceOf(ed);
          if (!p) return;
          if (following) p.stopFollowing();
          else p.follow(peer.id);
        }}
      >
        <Avatar name={peer.name} size={24} />
      </button>
  );
}

/** The connection, when it isn't live: shown next to the avatars. */
export function ConnectionDot() {
  const ed = useEditor();
  const state = usePresence(ed);
  if (!state.shared || state.connection === "live") return null;
  return <IconButton icon="24.link" label={state.connection === "connecting" ? "Connecting…" : "Offline — your changes are kept and sent when you’re back online"} tone="default" className={styles.offline} onClick={() => {}} />;
}
