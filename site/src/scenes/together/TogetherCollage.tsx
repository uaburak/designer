// Working together (docs/site.md §2.1, "Working together"): invite someone, then work in the same file. The editor's
// right panel header (the account, Present, Share) and the Share dialog are the app's (editor/panels/RightPanel.tsx,
// editor/ShareDialog.tsx, editor/multiplayer/Multiplayer.tsx: their own CSS modules and ds parts, cut to what shows).
// 1. Share opens the dialog; an email is typed, "can view" opens its list and "can edit" is picked; Invite adds Deniz
//    under "Who has access".
// 2. Deniz opens the file: "· in this file" by her name, her avatar in the header's facepile, and the dialog closes.
// 3. Her cursor comes in and she rewrites the headline (her selection and caret in her colour).
import { useRef, useState } from "react";
import { Button, IconButton } from "@/ds/components/Button";
import { Avatar } from "@/ds/components/Misc";
import { Select } from "@/ds/components/Select";
import { Tabs } from "@/ds/components/Tabs";
import { Icon } from "@/ds/icons/Icon";
import share from "@/editor/ShareDialog.module.css";
import mp from "@/editor/multiplayer/Multiplayer.module.css";
import panels from "@/editor/panels/Panels.module.css";
import { Collage, CURSOR, Cursor, FieldCaret, FrameName, Piece, usePointer } from "../collage/kit";
import { FrameSections, noop, PanelColumn } from "../collage/ui";
import { BEZIER } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import { highlight, optionOf, pointOf } from "./pick";
import styles from "./together.module.css";

const ME = "Burak Koç";
const PEER = { name: "Deniz Aydın", short: "Deniz", email: "deniz@orbit.studio", color: CURSOR.purple };
const ROLES = [
  { value: "editor", label: "can edit" },
  { value: "viewer", label: "can view" },
];
const FRAME = { x: 64, y: 104, w: 600, h: 392 };
const BEFORE = "Plan your week.";
const AFTER = "Plan it together.";

export default function TogetherCollage() {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [chip, setChip] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);
  const [role, setRole] = useState("viewer");
  const [invited, setInvited] = useState(false);
  const [joined, setJoined] = useState(false);
  const [editing, setEditing] = useState(false);
  const [headline, setHeadline] = useState(BEFORE);
  const [peerTyping, setPeerTyping] = useState(false);
  const [edited, setEdited] = useState(false);
  const me = usePointer([560, 560]);
  const peer = usePointer([620, 548]);
  const shareRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);

  const at = (sel: string, root: { current: Element | null }, where?: [number, number], dx = 0, dy = 0) => pointOf(root.current?.querySelector(sel), where, dx, dy);

  const script = async (run: Run) => {
    await run.wait(900);
    // 1. Share › an email › can edit › Invite
    const shareAt = pointOf(shareRef.current?.querySelector("button"), [0.45, 0.55]);
    if (shareAt) await me.click(run, shareAt, { beat: 250 });
    setOpen(true);
    await run.wait(700);
    const input = at("input", fieldRef, [0.18, 0.55]);
    if (input) await me.click(run, input, { beat: 200 });
    setFocus(true);
    await run.wait(300);
    setTyping(true);
    await run.type(PEER.email, setText, 7);
    setTyping(false);
    await run.wait(250);
    setChip(true);
    setText("");
    await run.wait(650);
    const select = at('[data-ds="Select"] button', fieldRef, [0.5, 0.55]);
    if (select) await me.click(run, select, { beat: 250 });
    setFocus(false);
    setRoleOpen(true);
    await run.wait(450);
    const option = optionOf(fieldRef.current, "can edit");
    const optionAt = pointOf(option, [0.4, 0.55]);
    if (optionAt) await me.to(run, optionAt, { ms: 520, ease: BEZIER.standard });
    highlight(option);
    await me.click(run, undefined, { beat: 300 });
    setRole("editor");
    setRoleOpen(false);
    await run.wait(650);
    const invite = pointOf(dialogRef.current?.querySelector("[data-share='invite']"), [0.5, 0.55]);
    if (invite) await me.click(run, invite, { beat: 250 });
    setInvited(true);
    setChip(false);
    await run.wait(1100);

    // 2. Deniz opens the file
    setJoined(true);
    await run.wait(1300);
    const close = pointOf(dialogRef.current?.querySelector('[aria-label="Close"]'), [0.5, 0.5]);
    if (close) await me.click(run, close, { beat: 250 });
    setOpen(false);

    // 3. Her cursor comes in; she rewrites the headline
    await run.wait(500);
    const titleAt = pointOf(titleRef.current, [0.62, 0.62]);
    if (titleAt) await peer.to(run, titleAt, { ms: 1100 });
    await peer.click(run, undefined, { beat: 200 });
    await run.wait(60);
    await peer.click(run, undefined, { beat: 0 });
    setEditing(true);
    await run.wait(500);
    setPeerTyping(true);
    setHeadline("");
    await run.wait(200);
    await run.type(AFTER, setHeadline, 23);
    setPeerTyping(false);
    await run.wait(900);
    // Esc: the edit ends, her text stays selected
    setEdited(true);
    if (titleAt) await peer.to(run, [titleAt[0] + 70, titleAt[1] + 60], { ms: 800, ease: BEZIER.standard });
  };

  const pending = chip || text.length > 0;
  return (
    <Collage size={[1000, 600]} focus={[0.36, 0.42]} safe={680} script={script}>
      {/* The file on the canvas */}
      <FrameName x={FRAME.x} y={FRAME.y}>
        Home
      </FrameName>
      <Piece x={FRAME.x} y={FRAME.y} w={FRAME.w} h={FRAME.h} d={0} from="fade" className={styles.site}>
        <div className={styles.siteNav}>
          <span className={styles.siteLogo}>orbit</span>
          <span>Product</span>
          <span>Pricing</span>
          <span>Blog</span>
        </div>
        <div className={styles.siteHero}>
          <span ref={titleRef} className={styles.siteTitle}>
            {headline || "​"}
            {editing && !edited && <i className={styles.peerCaret} data-typing={peerTyping || undefined} style={{ ["--c" as string]: PEER.color }} />}
            {/* Deniz's selection, in her colour (another person's selection on the canvas) */}
            <span className={styles.peerSelection} data-on={editing || undefined} style={{ ["--c" as string]: PEER.color }} />
          </span>
          <span className={styles.siteSub}>Tasks, notes and plans for teams that ship.</span>
          <span className={styles.siteButton}>Get started</span>
        </div>
        <div className={styles.siteArt}>
          <i />
          <i />
          <i />
        </div>
      </Piece>

      {/* The right panel: the header (the account, or the facepile once Deniz is in), the tabs, the frame's sections */}
      <Piece surface x={730} y={28} h={544} d={80} from="right" className={styles.panel}>
        <PanelColumn>
          <div className={panels.rightHeader}>
            <span className={styles.swap}>
              <span data-out={joined || undefined} className={panels.account}>
                <Avatar name={ME} size={28} />
                <span className={panels.accountMore}>
                  <Icon name="16.chevron.down" />
                </span>
              </span>
              <span data-out={!joined || undefined} className={mp.facepile}>
                <span className={`${mp.face} ${styles.newFace}`} style={{ ["--peer" as string]: PEER.color }}>
                  <span className={mp.bar} />
                  <span className={mp.ring}>
                    <Avatar name={PEER.name} size={24} />
                  </span>
                </span>
                <span className={mp.tools} style={{ ["--peer" as string]: "var(--figma-color-bg-brand)" }}>
                  <span className={mp.face}>
                    <span className={mp.bar} />
                    <span className={mp.ring}>
                      <Avatar name={ME} size={24} />
                    </span>
                  </span>
                  <span className={mp.count}>2</span>
                </span>
              </span>
            </span>
            <span className={panels.grow} />
            <span className={panels.present}>
              <IconButton icon="24.play" label="Present" size="large" tooltip={false} />
              <span className={`${panels.chip} ${panels.presentChevron}`}>
                <Icon name="16.chevron.down" />
              </span>
            </span>
            <div ref={shareRef} style={{ display: "contents" }}>
              <Button variant="primary" size="large" className={panels.share}>
                Share
              </Button>
            </div>
          </div>
          <div className={panels.rightTabs}>
            <Tabs label="Properties" value="design" tabs={[{ value: "design", label: "Design", width: 53 }, { value: "prototype", label: "Prototype", width: 69 }]} onChange={noop} />
            <span className={panels.zoom}>
              50%
              <Icon name="16.chevron.down" />
            </span>
          </div>
          <FrameSections x={0} y={0} w={1440} h={940} radius={0} />
        </PanelColumn>
      </Piece>

      {/* Share this file */}
      <Piece ref={dialogRef} surface x={130} y={56} w={480} show={open} from="scale" origin="50% 0" z={20} className={styles.dialog}>
        <header className={share.head}>
          <span className={share.title}>Share this file</span>
          <span className={share.grow} />
          <span className={share.link}>
            <Icon name="24.link" className={share.linkIcon} />
            Copy link
          </span>
          <IconButton icon="24.close.small" label="Close" tooltip={false} />
        </header>
        <div className={`${share.body} ${styles.shareBody}`}>
          <div className={share.inviteBar}>
            <div ref={fieldRef} className={`${share.field} ${styles.field} ${styles.overField}`} data-focus={focus || undefined} style={{ ["--over" as string]: "32px" }}>
              {chip && (
                <span className={share.chip}>
                  <span>{PEER.email}</span>
                  <button type="button" aria-label="Remove">
                    <Icon name="16.close" />
                  </button>
                </span>
              )}
              <input className={share.input} placeholder={chip ? "" : "Add comma separated emails to invite"} value={text} readOnly tabIndex={-1} />
              {pending && <Select label="Permission Level" value={role} options={ROLES} onChange={noop} variant="outlined" width="hug" className={share.roleSelect} static={roleOpen} />}
              <FieldCaret host={fieldRef} text={text} show={focus} typing={typing} />
            </div>
            <Button variant="primary" size="large" className={share.invite} disabled={!pending} data-share="invite">
              Invite
            </Button>
          </div>
          <span className={share.heading}>Who has access</span>
          <ul className={share.people}>
            <li className={share.person}>
              <span className={share.personButton}>
                <span className={share.glyph}>
                  <Icon name="24.lock.small" />
                </span>
                <span className={share.who}>
                  <span className={share.name}>People invited to file</span>
                </span>
                <Icon name="16.chevron.down" className={share.chevron} />
              </span>
            </li>
            <li className={share.person}>
              <Avatar name={ME} />
              <span className={share.who}>
                <span className={share.name}>{ME}</span>
                <span className={share.secondary}> (you)</span>
              </span>
              <span className={share.role}>owner</span>
            </li>
            <li className={`${share.person} ${styles.added}`} data-out={!invited || undefined}>
              <Avatar name={PEER.name} />
              <span className={share.who}>
                <span className={share.name}>{PEER.name}</span>
                <span className={`${share.online} ${styles.online}`} data-out={!joined || undefined}>
                  {" "}
                  · in this file
                </span>
              </span>
              <Select label={`${PEER.email} role`} value="editor" options={ROLES} onChange={noop} variant="ghost" width="hug" />
            </li>
          </ul>
        </div>
      </Piece>

      <Cursor {...peer.state} color={PEER.color} name={PEER.short} show={joined && !open} z={31} />
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={32} />
    </Collage>
  );
}
