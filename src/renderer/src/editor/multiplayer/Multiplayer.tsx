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
import { Avatar, Button, Icon, IconButton, MenuButton, Popover, initials, showToast, tooltipProps } from "@/ds";
import { t, useT } from "@/i18n";
import { getStoreClient } from "@/store";
import { useAccount } from "../../files/account";
import { withLinkPassword } from "../../files/LinkPassword";
import { useCurrentPage } from "@/engine/hooks";
import { useEditor } from "../controller";
import { editorBridge } from "../desktop";
import { applyIntent, openIntent } from "./links";
import { presenceOf, usePresence, type Peer } from "./presence";
import { FileBlocked } from "./FileBlocked";
import { useAgentPresence, type AgentPeer } from "./agentPresence";
import { agentPresenceOf, startAgentPresence } from "./agentsOnCanvas";
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
  // The agents working on the file (any file, shared or not): their cursors, outlines and following.
  useEffect(() => startAgentPresence(ed), [ed]);

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
  usePolicy(state);

  const followed = state.peers.find((p) => p.id === state.following);
  const offer = state.peers.find((p) => p.id === state.spotlightOffer);
  const asking = state.peers.find((p) => p.id === state.askedBy);
  return (
    <>
      {followed && <ObservationFrame peer={followed} />}
      {!followed && <AgentObservationFrame />}
      {offer && !followed && <SpotlightOffer peer={offer} />}
      {asking && !followed && !offer && <AskSpotlight peer={asking} />}
      {state.audio.inCall && <AudioWidget />}
      {viewer && <ViewerBanner />}
      {state.blocked && <FileBlocked fileKey={(ed.source as unknown as { fileKey?: string }).fileKey ?? null} blocked={state.blocked} />}
    </>
  );
}

/**
 * The org's room switches, live (docs/multiplayer.md §15.6, §15.9 — Admin › Communication › Cursor chat, Other › Audio):
 * cursor chat off closes an open bubble ("/" doesn't open one: commands.ts asks `chatAllowed`); audio off leaves an
 * ongoing call (presence.ts) and says so, and the headphones go from Multiplayer tools.
 */
/** The peers' photos by user id: the room knows only their names, the file's members carry the photos (none: initials) */
function usePeerPictures(userIds: string[]): Map<string, string> {
  const ed = useEditor();
  const fileKey = (ed.source as unknown as { fileKey?: string }).fileKey;
  const ids = [...new Set(userIds)].sort().join(",");
  const [pictures, setPictures] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    if (!fileKey || !ids) return;
    let live = true;
    void getStoreClient()
      .multiplayer.members(fileKey)
      .then((members) => {
        if (live) setPictures(new Map(members.flatMap((m) => (m.userId && m.picture ? [[m.userId, m.picture] as [string, string]] : []))));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [fileKey, ids]);
  return pictures;
}

function usePolicy(state: ReturnType<typeof usePresence>) {
  const ed = useEditor();
  const chatOff = state.policy?.cursorChat === false;
  const audioOff = state.policy?.audio === false;
  useEffect(() => {
    if (chatOff && ed.ui.get().cursorChat) ed.ui.set({ cursorChat: null });
  }, [ed, chatOff]);
  // In the call as of the last commit (the call is left in the same update that turns audio off)
  const wasInCall = useRef(false);
  useEffect(() => {
    if (audioOff && wasInCall.current) showToast({ message: t(AUDIO_OFF_TEXT) });
  }, [audioOff]);
  useEffect(() => {
    wasInCall.current = state.audio.inCall;
  }, [state.audio.inCall]);
}

/** Said when the org turns audio off during a call (ours: Figma's words aren't documented) */
export const AUDIO_OFF_TEXT = "Your organization turned off audio. You left the conversation.";

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
      (r) => live && !r && showToast({ message: t("This file’s password changed. Your copy stays here but won’t get new changes until you enter it.") }),
      (e: unknown) => live && showToast({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [ed, locked]);
}

/** Someone asked this person to spotlight (live: the canvas framed in the asker's colour, the bell 8 below its top). */
function AskSpotlight({ peer }: { peer: Peer }) {
  useT();
  const ed = useEditor();
  return (
    <div className={styles.frame} style={{ "--peer": peer.color } as React.CSSProperties} data-ask-spotlight={peer.name}>
      <div className={`${styles.bell} ${styles.ask}`}>
        <span className={styles.bellMessage}>{t("{name} is asking you to spotlight", { name: peer.name })}</span>
        <button type="button" className={styles.askButton} onClick={() => presenceOf(ed)?.spotlight(true)}>
          {t("Spotlight me")}
        </button>
        <IconButton icon="24.close.small" label={t("Dismiss request to spotlight from {name}", { name: peer.name })} tooltip={false} className={styles.askClose} onClick={() => presenceOf(ed)?.dismissAsk()} />
      </div>
    </div>
  );
}

/** The audio conversation (live: 151×40 at the canvas's top right, 12 in): who is in it, the microphone, Leave. */
function AudioWidget() {
  useT();
  const ed = useEditor();
  const state = usePresence(ed);
  const me = useAccount().state?.user;
  const p = presenceOf(ed);
  const a = state.audio;
  const others = state.peers.filter((x) => x.presence?.audio);
  const pictures = usePeerPictures(others.map((o) => o.userId));
  const micLabel = a.noMic ? t("Check your microphone permissions to start chatting.") : a.muted ? t("Unmute") : t("Mute");
  return (
    <div className={styles.audio} role="region" aria-label={t("Audio conversation")} data-audio="">
      <span className={styles.audioPeople}>
        <span className={styles.audioFace} data-speaking={undefined}>
          <Avatar name={me?.name || me?.email || t("You")} src={me?.picture ?? undefined} size={24} />
        </span>
        {others.map((o) => (
          <span key={o.id} className={styles.audioFace} data-speaking={a.speaking.includes(o.id) || undefined} style={{ "--peer": o.color } as React.CSSProperties} {...tooltipProps(o.presence?.audio?.muted ? t("{name} (muted)", { name: o.name }) : o.name)}>
            <Avatar name={o.name} src={pictures.get(o.userId)} size={24} />
          </span>
        ))}
      </span>
      <IconButton icon={a.muted || a.noMic ? "24.microphone.off" : "24.microphone"} label={micLabel} onClick={() => p?.audio.setMuted(!a.muted)} disabled={a.noMic} data-audio="mic" />
      <button type="button" className={styles.leave} onClick={() => p?.audio.leave()} data-audio="leave">
        {t("Leave")}
      </button>
    </div>
  );
}

function ObservationFrame({ peer }: { peer: Peer }) {
  useT();
  const ed = useEditor();
  return (
    <div className={styles.frame} style={{ "--peer": peer.color } as React.CSSProperties} data-following={peer.name}>
      <div className={styles.bell}>
        <span className={styles.bellMessage}>{peer.presence?.spotlight ? t("{name} is spotlighting", { name: peer.name }) : t("Following {name}", { name: peer.name })}</span>
        <button type="button" className={styles.bellButton} onClick={() => presenceOf(ed)?.stopFollowing()}>
          {t("Stop")}
        </button>
      </div>
    </div>
  );
}

/** Following an agent (observation mode): the view framed in its colour, "Following <name>" with Stop. */
function AgentObservationFrame() {
  useT();
  const ed = useEditor();
  const p = agentPresenceOf(ed);
  const state = useAgentPresence(p);
  const agent = state.agents.find((a) => a.key === state.following);
  if (!agent) return null;
  return (
    <div className={styles.frame} style={{ "--peer": agent.color } as React.CSSProperties} data-following-agent={agent.name}>
      <div className={styles.bell}>
        <span className={styles.bellMessage}>{t("Following {name}", { name: agent.name })}</span>
        <button type="button" className={styles.bellButton} onClick={() => p.stopFollowing()}>
          {t("Stop")}
        </button>
      </div>
    </div>
  );
}

/** Someone started spotlighting: the bell in their colour, followed in a moment unless "Not now". */
function SpotlightOffer({ peer }: { peer: Peer }) {
  useT();
  const ed = useEditor();
  return (
    <div className={styles.offer} style={{ "--peer": peer.color } as React.CSSProperties} data-spotlight-offer={peer.name}>
      <div className={styles.bell}>
        <span className={styles.bellMessage}>{t("{name} is spotlighting", { name: peer.name })}</span>
        <button type="button" className={styles.bellButton} onClick={() => presenceOf(ed)?.declineSpotlight()}>
          {t("Not now")}
        </button>
        <button type="button" className={styles.bellButton} onClick={() => presenceOf(ed)?.follow(peer.id)}>
          {t("Follow")}
        </button>
      </div>
    </div>
  );
}

/** The view-only banner for a file outside the person's home org when it restricts external content (docs/multiplayer.md
 *  §15.6 — ours, Figma's words unverified) */
export const EXTERNAL_VIEW_ONLY_TEXT = "Your organization only allows you to view this file.";

function ViewerBanner() {
  useT();
  const ed = useEditor();
  const [closed, setClosed] = useState(false);
  const [asked, setAsked] = useState(false);
  const fileKey = (ed.source as unknown as { fileKey?: string }).fileKey;
  // Capped by the person's own org (Access to external content restricted, §15.6): view only, no asking to edit.
  const [external, setExternal] = useState(false);
  useEffect(() => {
    if (!fileKey) return;
    let live = true;
    void getStoreClient()
      .multiplayer.fileInfo(fileKey)
      .then(
        (i) => live && setExternal(i.access?.capped === "external"),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [fileKey]);
  if (closed) return null;
  if (external)
    return (
      <div className={styles.viewer} role="status" data-viewer-banner="external">
        <Icon name="24.info" className={styles.viewerIcon} />
        <span className={styles.viewerText}>{t(EXTERNAL_VIEW_ONLY_TEXT)}</span>
        <IconButton icon="24.close.small" label={t("Close")} tooltip={false} onClick={() => setClosed(true)} />
      </div>
    );
  return (
    <div className={styles.viewer} role="status" data-viewer-banner="">
      <Icon name="24.info" className={styles.viewerIcon} />
      <span className={styles.viewerText}>{t("You can only view and comment on this file.")}</span>
      <Button
        variant="primary"
        disabled={asked || !fileKey}
        {...tooltipProps(t("Any of this file's editors can give you access"))}
        onClick={() => {
          if (!fileKey) return;
          setAsked(true);
          void getStoreClient()
            .multiplayer.requestEdit(fileKey)
            .then(
              () => showToast({ message: t("Request sent. You’ll be notified when an editor answers.") }),
              (e: unknown) => {
                setAsked(false);
                showToast({ kind: "error", message: t("Couldn’t ask to edit: {error}", { error: e instanceof Error ? e.message : String(e) }) });
              },
            );
        }}
      >
        {asked ? t("Requested") : t("Ask to edit")}
      </Button>
      <IconButton icon="24.close.small" label={t("Close")} tooltip={false} onClick={() => setClosed(true)} />
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
      if (n.kind === "access-request") showToast({ message: t("{name} asked to edit this file", { name: n.name ?? t("Someone") }), action: { label: t("Review"), onAction: () => ed.ui.set({ shareOpen: true }) } });
      else if (n.kind === "access-granted") showToast({ message: t("You can now edit this file") });
      else showToast({ message: t("Your request to edit wasn’t approved") });
    });
  }, [ed]);
  useEffect(() => {
    const to = state.replacedBy;
    if (!to || shownReplaced.current === to) return;
    shownReplaced.current = to;
    showToast({
      message: t("This file changed a lot while you were away. The latest version is in your files; this copy is no longer shared."),
      duration: 0,
      action: {
        label: t("Open latest"),
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
  useT();
  const ed = useEditor();
  const state = usePresence(ed);
  const me = useAccount().state?.user;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null;
  const setOpen = (on: boolean) => !on && setAnchor(null);
  const pictures = usePeerPictures(state.peers.map((x) => x.userId));
  if (!state.shared || !state.peers.length) return null;
  const shown = state.peers.slice(0, MAX_SHOWN);
  const myName = me?.name || me?.email || t("You");
  const myPicture = me?.picture ?? undefined;
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
            aria-label={following ? t("Stop following {name}", { name: peer.name }) : t("Follow {name}", { name: peer.name })}
            {...tooltipProps(peer.name)}
            onClick={() => (following ? p?.stopFollowing() : p?.follow(peer.id))}
          >
            <span className={styles.bar} />
            <span className={styles.ring}>
              <Avatar name={peer.name} src={pictures.get(peer.userId)} size={24} />
            </span>
          </button>
        );
      })}
      <button type="button" className={styles.tools} aria-label={t("Multiplayer tools")} aria-expanded={open} data-open={open || undefined} onClick={(e) => setAnchor(open ? null : e.currentTarget)} style={{ "--peer": "var(--figma-color-bg-brand)" } as React.CSSProperties}>
        <span className={styles.face} data-me="">
          <span className={styles.bar} />
          <span className={styles.ring} data-spotlight={state.spotlighting || undefined}>
            <Avatar name={myName} src={myPicture} size={24} />
          </span>
        </span>
        <span className={styles.count}>{state.peers.length + 1}</span>
      </button>
      {open && (
        <Popover anchor={anchor} placement="bottom" width={224} label={t("Multiplayer tools")} onClose={() => setOpen(false)}>
          <div className={styles.toolsBody}>
            <div className={styles.me}>
              <Avatar name={myName} src={myPicture} size={24} />
              <span className={styles.meName}>
                {myName} <span>{t("(You)")}</span>
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
                {state.spotlighting ? t("Stop spotlight") : t("Spotlight me")}
              </Button>
              {/* Audio off for the org (Admin › Other › Audio): no conversation to start or join */}
              {(state.policy?.audio !== false || state.audio.inCall) && (
                <button
                  type="button"
                  className={styles.headphones}
                  data-on={state.audio.inCall || undefined}
                  aria-label={state.audio.inCall ? t("Leave conversation") : state.peers.some((x) => x.presence?.audio) ? t("Join conversation") : t("Start conversation")}
                  {...tooltipProps(state.audio.inCall ? t("Leave conversation") : state.peers.some((x) => x.presence?.audio) ? t("Join conversation") : t("Start conversation"))}
                  onClick={() => {
                    if (state.audio.inCall) p?.audio.leave();
                    else void p?.joinAudio();
                    setOpen(false);
                  }}
                  data-audio="start"
                >
                  <Icon name="24.headphones" />
                </button>
              )}
            </div>
            <div className={styles.toolsDivider} />
            {state.peers.map((peer) => (
              <div key={peer.id} className={styles.person} data-person={peer.name}>
                <button
                  type="button"
                  className={styles.personFollow}
                  aria-label={state.following === peer.id ? t("Stop following {name}", { name: peer.name }) : t("Click to follow {name}", { name: peer.name })}
                  onClick={() => {
                    if (state.following === peer.id) p?.stopFollowing();
                    else p?.follow(peer.id);
                    setOpen(false);
                  }}
                >
                  <span className={styles.ring} style={{ "--peer": peer.color } as React.CSSProperties}>
                    <Avatar name={peer.name} src={pictures.get(peer.userId)} size={24} />
                  </span>
                  <span className={styles.personText}>
                    <span className={styles.personName}>
                      {peer.name}
                      {peer.role === "owner" && ` ${t("(Owner)")}`}
                    </span>
                    <span className={styles.personHint}>{state.following === peer.id ? t("Click to stop following") : t("Click to follow")}</span>
                  </span>
                </button>
                <MenuButton
                  label={t("More options")}
                  className={styles.personMore}
                  entries={[{ id: "ask", label: t("Ask to spotlight") }]}
                  onSelect={() => {
                    p?.askToSpotlight(peer.id);
                    showToast({ message: t("Asked {name} to spotlight", { name: peer.name }) });
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

// ---------------------------------------------------------------------------------------------------------------------
// Agents in the facepile (docs/ai.md §2.13)
// ---------------------------------------------------------------------------------------------------------------------

/** Agents shown before "+N" takes over */
const MAX_AGENTS_SHOWN = 4;

/** An agent's avatar: its initials on its colour, with the agent badge. */
export function AgentAvatar({ agent }: { agent: Pick<AgentPeer, "name"> }) {
  return (
    <span className={styles.agentAvatar} role="img" aria-label={agent.name}>
      {initials(agent.name)}
      <span className={styles.agentBadge}>
        <Icon name="16.sparkle" size={10} />
      </span>
    </span>
  );
}

/** "Claude Code · Agent", "… · on Page 2" when it works on another page than the owner's. */
export function agentTooltip(agent: Pick<AgentPeer, "name" | "detail" | "page" | "pageName">, ownPage: string | null): string {
  const who = agent.page && agent.page !== ownPage && agent.pageName ? t("{name} · Agent · on {page}", { name: agent.name, page: agent.pageName }) : t("{name} · Agent", { name: agent.name });
  return agent.detail ? `${who} — ${agent.detail}` : who;
}

/** The agents working on this file, before the people (or the account avatar): click one to follow it. */
export function AgentFaces() {
  useT();
  const ed = useEditor();
  const p = agentPresenceOf(ed);
  const state = useAgentPresence(p);
  const page = useCurrentPage(ed.store);
  if (!state.agents.length) return null;
  const shown = state.agents.slice(0, MAX_AGENTS_SHOWN);
  const more = state.agents.slice(MAX_AGENTS_SHOWN);
  return (
    <span className={styles.agents} data-agents={state.agents.length}>
      {shown.map((agent) => {
        const following = state.following === agent.key;
        return (
          <button
            key={agent.key}
            type="button"
            className={styles.face}
            data-following={following || undefined}
            data-agent={agent.name}
            data-elsewhere={(agent.page !== null && agent.page !== page) || undefined}
            style={{ "--peer": agent.color } as React.CSSProperties}
            aria-label={following ? t("Stop following {name}", { name: agent.name }) : t("Follow {name}", { name: agent.name })}
            {...tooltipProps(agentTooltip(agent, page))}
            onClick={() => (following ? p.stopFollowing() : p.follow(agent.key))}
          >
            <span className={styles.bar} />
            <span className={styles.ring}>
              <AgentAvatar agent={agent} />
            </span>
          </button>
        );
      })}
      {more.length > 0 && (
        <span className={styles.agentMore} {...tooltipProps(more.map((a) => a.name).join(", "))}>
          +{more.length}
        </span>
      )}
    </span>
  );
}

/** Saving / offline, as an icon in the header (Figma's toolbar icons; tooltips unverified). */
export function ConnectionDot() {
  useT();
  const ed = useEditor();
  const state = usePresence(ed);
  if (!state.shared || state.connection === "live") return null;
  const label = state.connection === "connecting" ? t("Connecting…") : t("You're offline. Your changes are saved on this computer and sent when you're back online.");
  return (
    <span className={styles.offline} {...tooltipProps(label)} aria-label={label} role="img" data-connection={state.connection}>
      <Icon name="24.warning" />
    </span>
  );
}
