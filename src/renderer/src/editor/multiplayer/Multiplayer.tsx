/**
 * The editor's multiplayer chrome, as live Figma draws it (docs/research/figma/live/multiplayer/README.md; R13 §1–2):
 *
 * - the header's facepile: others' 24 px avatars in a ring of the panel's colour, overlapping, each with a 4×2 bar in
 *   their colour; then your avatar with the count of people in the file — "Multiplayer tools" (you, "(You)", Spotlight me,
 *   everyone else as "Click to follow <name>");
 * - observation mode: the UI minimized, the window framed 5 px in the followed person's colour, "Following <name>" with
 *   Stop at the top centre;
 * - "can view": the file read-only, the banner "You can only view and comment on this file." with Ask to edit;
 * - notices: an "Ask to edit" request (editors), its answer (the person who asked), a copy replaced by a fresh one;
 * - "Ask to spotlight" (a person's More options): the asked person's canvas framed in the asker's colour with
 *   "<name> is asking you to spotlight" · Spotlight me · ✕;
 * - audio: Multiplayer tools' headphones start or join the file's conversation; a widget at the canvas's top right
 *   (avatars, microphone, Leave);
 * - a link's landing (node-id, Dev Mode, prototype) and a changed link password (entered again).
 */
import { useEffect, useRef, useState } from "react";
import { Avatar, Button, Icon, IconButton, MenuButton, Popover, showToast, tooltipProps } from "@/ds";
import { getStoreClient } from "@/store";
import { useAccount } from "../../files/account";
import { withLinkPassword } from "../../files/LinkPassword";
import { useEditor } from "../controller";
import { editorBridge } from "../desktop";
import { applyIntent, openIntent } from "./links";
import { presenceOf, usePresence, type Peer } from "./presence";
import styles from "./Multiplayer.module.css";

/** Rendered once in the editor: presence runs while it is mounted. */
export function Multiplayer() {
  const ed = useEditor();
  const state = usePresence(ed);
  useEffect(() => {
    const p = presenceOf(ed);
    if (!p) return;
    p.start();
    return () => p.stop();
  }, [ed]);

  // "can view": read-only (Figma's view-only), as long as that is the role.
  const viewer = state.shared && state.role === "viewer";
  useEffect(() => {
    if (!viewer || ed.engine.destroyed) return;
    ed.engine.setViewerMode(true);
    return () => {
      if (!ed.engine.destroyed) ed.engine.setViewerMode(false);
    };
  }, [ed, viewer]);

  // Observation mode minimizes the UI (live Figma), and gives it back as it was.
  const following = state.following !== null;
  useEffect(() => {
    if (!following) return;
    const was = ed.ui.get().uiMinimized;
    ed.ui.set({ uiMinimized: true });
    return () => ed.ui.set({ uiMinimized: was });
  }, [ed, following]);

  useNotices();
  useLinkLanding();
  useLinkPassword(state.locked);

  const followed = state.peers.find((p) => p.id === state.following);
  const offer = state.peers.find((p) => p.id === state.spotlightOffer);
  const asking = state.peers.find((p) => p.id === state.askedBy);
  return (
    <>
      {followed && <ObservationFrame peer={followed} />}
      {offer && !followed && <SpotlightOffer peer={offer} />}
      {asking && !followed && !offer && <AskSpotlight peer={asking} />}
      {state.audio.inCall && <AudioWidget />}
      {viewer && <ViewerBanner />}
    </>
  );
}

/** The link that opened this file: its frame or page, then Dev Mode or the prototype (once, when the editor is up). */
function useLinkLanding() {
  const ed = useEditor();
  useEffect(() => {
    const fileKey = (ed.source as unknown as { fileKey?: string }).fileKey;
    if (!fileKey) return;
    let live = true;
    void openIntent(fileKey).then((intent) => {
      if (!live || !intent) return;
      requestAnimationFrame(() => live && applyIntent(ed, intent));
    });
    return () => {
      live = false;
    };
  }, [ed]);
}

/** The file's link password changed under this person (in by the link): entered again, or the copy stops following. */
function useLinkPassword(locked: boolean) {
  const ed = useEditor();
  useEffect(() => {
    const fileKey = (ed.source as unknown as { fileKey?: string }).fileKey;
    if (!locked || !fileKey) return;
    let live = true;
    void withLinkPassword((password) => getStoreClient().multiplayer.unlockFile(fileKey, password ?? ""), { ask: true }).then(
      (r) => live && !r && showToast({ message: "This file’s password changed. Your copy stays here but won’t get new changes until you enter it." }),
      (e: unknown) => live && showToast({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [ed, locked]);
}

/** Someone asked this person to spotlight (live: the canvas framed in the asker's colour, the bell 8 below its top). */
function AskSpotlight({ peer }: { peer: Peer }) {
  const ed = useEditor();
  return (
    <div className={styles.frame} style={{ "--peer": peer.color } as React.CSSProperties} data-ask-spotlight={peer.name}>
      <div className={`${styles.bell} ${styles.ask}`}>
        <span className={styles.bellMessage}>{`${peer.name} is asking you to spotlight`}</span>
        <button type="button" className={styles.askButton} onClick={() => presenceOf(ed)?.spotlight(true)}>
          Spotlight me
        </button>
        <IconButton icon="24.close.small" label={`Dismiss request to spotlight from ${peer.name}`} tooltip={false} className={styles.askClose} onClick={() => presenceOf(ed)?.dismissAsk()} />
      </div>
    </div>
  );
}

/** The audio conversation (live: 151×40 at the canvas's top right, 12 in): who is in it, the microphone, Leave. */
function AudioWidget() {
  const ed = useEditor();
  const state = usePresence(ed);
  const me = useAccount().state?.user;
  const p = presenceOf(ed);
  const a = state.audio;
  const others = state.peers.filter((x) => x.presence?.audio);
  const micLabel = a.noMic ? "Check your microphone permissions to start chatting." : a.muted ? "Unmute" : "Mute";
  return (
    <div className={styles.audio} role="region" aria-label="Audio conversation" data-audio="">
      <span className={styles.audioPeople}>
        <span className={styles.audioFace} data-speaking={undefined}>
          <Avatar name={me?.name || me?.email || "You"} size={24} />
        </span>
        {others.map((o) => (
          <span key={o.id} className={styles.audioFace} data-speaking={a.speaking.includes(o.id) || undefined} style={{ "--peer": o.color } as React.CSSProperties} {...tooltipProps(o.presence?.audio?.muted ? `${o.name} (muted)` : o.name)}>
            <Avatar name={o.name} size={24} />
          </span>
        ))}
      </span>
      <IconButton icon={a.muted || a.noMic ? "24.microphone.off" : "24.microphone"} label={micLabel} onClick={() => p?.audio.setMuted(!a.muted)} disabled={a.noMic} data-audio="mic" />
      <button type="button" className={styles.leave} onClick={() => p?.audio.leave()} data-audio="leave">
        Leave
      </button>
    </div>
  );
}

function ObservationFrame({ peer }: { peer: Peer }) {
  const ed = useEditor();
  return (
    <div className={styles.frame} style={{ "--peer": peer.color } as React.CSSProperties} data-following={peer.name}>
      <div className={styles.bell}>
        <span className={styles.bellMessage}>{peer.presence?.spotlight ? `${peer.name} is spotlighting` : `Following ${peer.name}`}</span>
        <button type="button" className={styles.bellButton} onClick={() => presenceOf(ed)?.stopFollowing()}>
          Stop
        </button>
      </div>
    </div>
  );
}

/** Someone started spotlighting: the bell in their colour, followed in a moment unless "Not now". */
function SpotlightOffer({ peer }: { peer: Peer }) {
  const ed = useEditor();
  return (
    <div className={styles.offer} style={{ "--peer": peer.color } as React.CSSProperties} data-spotlight-offer={peer.name}>
      <div className={styles.bell}>
        <span className={styles.bellMessage}>{`${peer.name} is spotlighting`}</span>
        <button type="button" className={styles.bellButton} onClick={() => presenceOf(ed)?.declineSpotlight()}>
          Not now
        </button>
        <button type="button" className={styles.bellButton} onClick={() => presenceOf(ed)?.follow(peer.id)}>
          Follow
        </button>
      </div>
    </div>
  );
}

function ViewerBanner() {
  const ed = useEditor();
  const [closed, setClosed] = useState(false);
  const [asked, setAsked] = useState(false);
  if (closed) return null;
  const fileKey = (ed.source as unknown as { fileKey?: string }).fileKey;
  return (
    <div className={styles.viewer} role="status" data-viewer-banner="">
      <Icon name="24.info" className={styles.viewerIcon} />
      <span className={styles.viewerText}>You can only view and comment on this file.</span>
      <Button
        variant="primary"
        disabled={asked || !fileKey}
        {...tooltipProps("Any of this file's editors can give you access")}
        onClick={() => {
          if (!fileKey) return;
          setAsked(true);
          void getStoreClient()
            .multiplayer.requestEdit(fileKey)
            .then(
              () => showToast({ message: "Request sent. You’ll be notified when an editor answers." }),
              (e: unknown) => {
                setAsked(false);
                showToast({ kind: "error", message: `Couldn’t ask to edit: ${e instanceof Error ? e.message : String(e)}` });
              },
            );
        }}
      >
        {asked ? "Requested" : "Ask to edit"}
      </Button>
      <IconButton icon="24.close.small" label="Close" tooltip={false} onClick={() => setClosed(true)} />
    </div>
  );
}

/** Toasts for the room's notices and a replaced copy. */
function useNotices() {
  const ed = useEditor();
  const state = usePresence(ed);
  const shownReplaced = useRef<string | null>(null);
  useEffect(() => {
    const fileKey = (ed.source as unknown as { fileKey?: string }).fileKey;
    if (!fileKey) return;
    return getStoreClient().multiplayer.watch((e) => {
      if (e.fileKey !== fileKey || !e.notice) return;
      const n = e.notice;
      if (n.kind === "access-request") showToast({ message: `${n.name ?? "Someone"} asked to edit this file`, action: { label: "Review", onAction: () => ed.ui.set({ shareOpen: true }) } });
      else if (n.kind === "access-granted") showToast({ message: "You can now edit this file" });
      else showToast({ message: "Your request to edit wasn’t approved" });
    });
  }, [ed]);
  useEffect(() => {
    const to = state.replacedBy;
    if (!to || shownReplaced.current === to) return;
    shownReplaced.current = to;
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
}

// ---------------------------------------------------------------------------------------------------------------------
// The header's facepile and Multiplayer tools
// ---------------------------------------------------------------------------------------------------------------------

/** Others shown before the count takes over (live showed two others with three people; more is unverified). */
const MAX_SHOWN = 3;

/** True when the header shows the facepile instead of the account avatar. */
export function useFacepile(): boolean {
  const ed = useEditor();
  const state = usePresence(ed);
  return state.shared && state.peers.length > 0;
}

export function Facepile() {
  const ed = useEditor();
  const state = usePresence(ed);
  const me = useAccount().state?.user;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null;
  const setOpen = (on: boolean) => !on && setAnchor(null);
  if (!state.shared || !state.peers.length) return null;
  const shown = state.peers.slice(0, MAX_SHOWN);
  const myName = me?.name || me?.email || "You";
  const p = presenceOf(ed);
  return (
    <span className={styles.facepile} data-peers={state.peers.length}>
      {shown.map((peer) => {
        const following = state.following === peer.id;
        return (
          <button
            key={peer.id}
            type="button"
            className={styles.face}
            data-following={following || undefined}
            style={{ "--peer": peer.color } as React.CSSProperties}
            aria-label={following ? `Stop following ${peer.name}` : `Follow ${peer.name}`}
            {...tooltipProps(peer.name)}
            onClick={() => (following ? p?.stopFollowing() : p?.follow(peer.id))}
          >
            <span className={styles.bar} />
            <span className={styles.ring}>
              <Avatar name={peer.name} size={24} />
            </span>
          </button>
        );
      })}
      <button type="button" className={styles.tools} aria-label="Multiplayer tools" aria-expanded={open} data-open={open || undefined} onClick={(e) => setAnchor(open ? null : e.currentTarget)} style={{ "--peer": "var(--figma-color-bg-brand)" } as React.CSSProperties}>
        <span className={styles.face} data-me="">
          <span className={styles.bar} />
          <span className={styles.ring} data-spotlight={state.spotlighting || undefined}>
            <Avatar name={myName} size={24} />
          </span>
        </span>
        <span className={styles.count}>{state.peers.length + 1}</span>
      </button>
      {open && (
        <Popover anchor={anchor} placement="bottom" width={224} label="Multiplayer tools" onClose={() => setOpen(false)}>
          <div className={styles.toolsBody}>
            <div className={styles.me}>
              <Avatar name={myName} size={24} />
              <span className={styles.meName}>
                {myName} <span>(You)</span>
              </span>
            </div>
            <div className={styles.toolsRow}>
              <Button
                variant="primary"
                className={styles.spotlight}
                onClick={() => {
                  p?.spotlight(!state.spotlighting);
                  setOpen(false);
                }}
              >
                {state.spotlighting ? "Stop spotlight" : "Spotlight me"}
              </Button>
              <button
                type="button"
                className={styles.headphones}
                data-on={state.audio.inCall || undefined}
                aria-label={state.audio.inCall ? "Leave conversation" : state.peers.some((x) => x.presence?.audio) ? "Join conversation" : "Start conversation"}
                {...tooltipProps(state.audio.inCall ? "Leave conversation" : state.peers.some((x) => x.presence?.audio) ? "Join conversation" : "Start conversation")}
                onClick={() => {
                  if (state.audio.inCall) p?.audio.leave();
                  else void p?.audio.join();
                  setOpen(false);
                }}
                data-audio="start"
              >
                <Icon name="24.headphones" />
              </button>
            </div>
            <div className={styles.toolsDivider} />
            {state.peers.map((peer) => (
              <div key={peer.id} className={styles.person} data-person={peer.name}>
                <button
                  type="button"
                  className={styles.personFollow}
                  aria-label={state.following === peer.id ? `Stop following ${peer.name}` : `Click to follow ${peer.name}`}
                  onClick={() => {
                    if (state.following === peer.id) p?.stopFollowing();
                    else p?.follow(peer.id);
                    setOpen(false);
                  }}
                >
                  <span className={styles.ring} style={{ "--peer": peer.color } as React.CSSProperties}>
                    <Avatar name={peer.name} size={24} />
                  </span>
                  <span className={styles.personText}>
                    <span className={styles.personName}>
                      {peer.name}
                      {peer.role === "owner" && " (Owner)"}
                    </span>
                    <span className={styles.personHint}>{state.following === peer.id ? "Click to stop following" : "Click to follow"}</span>
                  </span>
                </button>
                <MenuButton
                  label="More options"
                  className={styles.personMore}
                  entries={[{ id: "ask", label: "Ask to spotlight" }]}
                  onSelect={() => {
                    p?.askToSpotlight(peer.id);
                    showToast({ message: `Asked ${peer.name} to spotlight` });
                    setOpen(false);
                  }}
                >
                  <Icon name="24.more" />
                </MenuButton>
              </div>
            ))}
          </div>
        </Popover>
      )}
    </span>
  );
}

/** Saving / offline, as an icon in the header (Figma's toolbar icons; tooltips unverified). */
export function ConnectionDot() {
  const ed = useEditor();
  const state = usePresence(ed);
  if (!state.shared || state.connection === "live") return null;
  const label = state.connection === "connecting" ? "Connecting…" : "You're offline. Your changes are saved on this computer and sent when you're back online.";
  return (
    <span className={styles.offline} {...tooltipProps(label)} aria-label={label} role="img" data-connection={state.connection}>
      <Icon name="24.warning" />
    </span>
  );
}
