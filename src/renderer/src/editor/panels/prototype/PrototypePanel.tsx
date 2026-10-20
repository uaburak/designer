/**
 * The Prototype tab (UI3; docs/research/figma/R8-prototyping.md §1):
 * - nothing selected (live 2026-10-20): Prototype settings — Device (None or a preset, Portrait / Landscape) and the
 *   background colour —, Flows (the page's flow starting points; a row's select frame, copy flow link and preview — the
 *   inline preview at the flow), the tips;
 * - a top-level frame: Flow starting point (+ / Copy flow link and −; its name, its frame — moving it to another — and
 *   its description), Interactions, Scroll behavior (Overflow);
 * - any other layer: Interactions, Scroll behavior (Position; Overflow for frames);
 * - a video (a layer with a video fill): Video (help.figma.com 8878274530455 "Video properties": "Check the box to
 *   autoplay video", "Click the Loop icon to loop video", "Click the Sound icon to turn the video's default sound
 *   setting on or off") — the schema's videoPlayback.
 * Two or more top-level frames: Interactions offers "Add interactions" with AI (AddInteractions.tsx, docs/ai.md §3).
 * An interaction row ("Click → Details", newest first) opens Interaction details (InteractionDetails.tsx). Everything is stored in
 * the schema's prototype fields (prototypeInteractions, prototypeStartingPoint, prototypeDevice,
 * prototypeBackgroundColor, scrollDirection, scrollBehavior), so it round-trips with .fig files.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, ColorInput, Icon, IconButton, MIXED, PanelSection, SegmentedControl, Select, TextInput, ToggleIconButton, cx, showToast } from "@/ds";
import type { Color, Guid, NodeChange, NodeFields } from "@/engine/codec";
import { useCurrentPage } from "@/engine/hooks";
import { keyBetween } from "../../../../../shared/schema/fractionalIndex";
import { useEditor, type EditorController } from "../../controller";
import { useDocumentVersion, useNodes, GEOMETRY_GROUPS } from "../../hooks";
import { colorToHex, hexToColor } from "../../model/color";
import {
  ACTION_ICON,
  actionLabel,
  DEVICE_MODELS,
  DEVICE_PRESETS,
  OVERFLOWS,
  deviceOf,
  presetIdentifierOf,
  SCROLL_POSITIONS,
  devicePreset,
  interactionSummary,
  liveInteractions,
  newInteraction,
  newInteractionId,
  nextFlowName,
  type PrototypeFields,
  type PrototypeInteraction,
  type ScrollBehavior,
  type ScrollDirection,
} from "../../model/prototype";
import { useSelectedNodes, type PanelNode } from "../design/shared";
import { flowLink, presentStart } from "../../present";
import { InteractionDetails, hasVideoFill } from "./InteractionDetails";
import { AddInteractionsButton } from "./AddInteractions";
import styles from "./Prototype.module.css";
import { t, useT } from "@/i18n";

export type ProtoNode = PanelNode & PrototypeFields;

/** Unmodelled fields cross as JSON with their schema names; null clears one. */
export const protoFields = (f: { [K in keyof PrototypeFields]?: PrototypeFields[K] | null }): NodeFields => f as unknown as NodeFields;

/** The presentation's default background: Figma's pages hold a transparent black, shown and played as black (live 2026-10-20). */
export const DEFAULT_PROTOTYPE_BACKGROUND: Color = { r: 0, g: 0, b: 0, a: 1 };

export interface PageFrame {
  guid: Guid;
  name: string;
  type: string;
  flow: PrototypeFields["prototypeStartingPoint"] | null;
  isStateGroup: boolean;
}

/** The page's top-level frames (name, flow starting point), re-read on committed changes. */
export function usePageFrames(page: Guid): PageFrame[] {
  const ed = useEditor();
  const version = useDocumentVersion(~GEOMETRY_GROUPS);
  return useMemo(() => {
    void version;
    if (ed.engine.destroyed) return [];
    // The page's children and, inside its sections (nested too), theirs: a frame in a section is top-level (Figma's).
    type Row = NodeChange & PrototypeFields & { isStateGroup?: boolean; resizeToFit?: boolean; type?: string; childIds?: Guid[] };
    const rows: Row[] = [];
    const walk = (parent: Guid, depth: number) => {
      const node = ed.engine.readNodes([parent], { childIds: true })[0] as (NodeChange & { childIds?: Guid[] }) | undefined;
      const ids = node?.childIds ?? [];
      if (!ids.length) return;
      const kids = ed.engine.readNodes(ids, { fields: ["name", "type", "prototypeStartingPoint", "resizeToFit", "isStateGroup", "visible"] }) as Row[];
      for (const k of kids) {
        const typed = ed.withRealType(k) as Row;
        if (typed.type === "SECTION") {
          if (depth < 32) walk(typed.guid, depth + 1);
        } else rows.push(typed);
      }
    };
    walk(page, 0);
    return rows
      .filter((n) => (n.type === "FRAME" && !n.resizeToFit) || n.type === "SYMBOL" || n.type === "INSTANCE")
      .map((n) => ({ guid: n.guid, name: n.name ?? "", type: n.type ?? "FRAME", flow: n.prototypeStartingPoint ?? null, isStateGroup: !!n.isStateGroup }));
  }, [ed, page, version]);
}

/** A node's ancestors, nearest first, up to (not including) the page. */
export function ancestorsOf(ed: EditorController, id: Guid): NodeChange[] {
  const out: NodeChange[] = [];
  let cur = ed.engine.readNodes([id], { fields: ["parentIndex"] })[0];
  for (let guard = 0; cur && guard < 256; guard++) {
    const parent = cur.parentIndex?.guid;
    if (!parent) break;
    const p = ed.engine.readNodes([parent], { fields: ["name", "type", "parentIndex", "isStateGroup", "resizeToFit"] })[0];
    if (!p) break;
    const typed = ed.withRealType(p) as NodeChange & { type?: string };
    if (typed.type === "CANVAS" || typed.type === "DOCUMENT") break;
    out.push(typed);
    cur = p;
  }
  return out;
}

export function PrototypePanel() {
  const { nodes } = useSelectedNodes();
  const ed = useEditor();
  // The interaction whose details are open (a connection just made opens its own).
  const [open, setOpen] = useState<{ node: Guid; index: number; anchor: DOMRect | HTMLElement | null; placement?: "bottom"; gap?: number } | null>(null);
  useEffect(() => {
    const offConnected = ed.engine.on("PROTOTYPE_CONNECTED", (e) => {
      const node = e.refs[0];
      if (!node) return;
      const list = liveInteractions((ed.engine.readNode(node, { fields: ["prototypeInteractions"] }) as ProtoNode | null)?.prototypeInteractions);
      const panel = document.querySelector<HTMLElement>("[data-panel='right'] [aria-label='Interactions']");
      setOpen({ node, index: Math.max(0, list.length - 1), anchor: panel });
    });
    // Round 17: a connection's line or label clicked on the canvas opens its details under the label (62–63.png);
    // index −1: the open one was removed (dragged off).
    const offSelected = ed.engine.on("PROTOTYPE_CONNECTION_SELECTED", (e) => {
      if (!e.node || e.index < 0) {
        setOpen((o) => (o && (!e.node || o.node === e.node) ? null : o));
        return;
      }
      const canvas = document.getElementById("engine-canvas");
      const r = canvas?.getBoundingClientRect();
      const anchor = r ? new DOMRect(r.left + e.label.x, r.top + e.label.y, e.label.width, e.label.height) : null;
      setOpen({ node: e.node, index: e.index, anchor, placement: "bottom", gap: e.label.height > 0 ? 11 : 30 });
    });
    return () => {
      offConnected();
      offSelected();
    };
  }, [ed]);
  // The open interaction's connection is the canvas's selected one (drawn in the selection colour).
  const openNode = open?.node ?? null;
  const openIndex = open?.index ?? -1;
  useEffect(() => {
    ed.engine.setPrototypeSelection(openNode ? { node: openNode, index: openIndex } : null);
  }, [ed, openNode, openIndex]);
  useEffect(() => () => ed.engine.setPrototypeSelection(null), [ed]);
  const key = nodes.map((n) => n.guid).join(",");
  const [openKey, setOpenKey] = useState(key);
  if (openKey !== key) {
    setOpenKey(key);
    if (open && !nodes.some((n) => n.guid === open.node)) setOpen(null);
  }
  return (
    <>
      {nodes.length === 0 ? <NothingSelected /> : <Selected nodes={nodes as ProtoNode[]} onOpen={(node, index, anchor) => setOpen({ node, index, anchor })} openIndex={open} />}
      {open && <InteractionDetails node={open.node} index={open.index} anchor={open.anchor} placement={open.placement} gap={open.gap} onClose={() => setOpen(null)} />}
    </>
  );
}

// ── Nothing selected: Device, Background, Flows ──────────────────────────────

function NothingSelected() {
  useT();
  const ed = useEditor();
  const page = useCurrentPage(ed.store);
  const [pageNode] = useNodes([page]) as (ProtoNode | null)[];
  const device = pageNode?.prototypeDevice;
  const preset = device?.type === "PRESET" ? devicePreset(device.presetIdentifier) : null;
  const deviceValue = !device || !device.type || device.type === "NONE" ? "NONE" : device.type === "PRESET" && preset ? preset[0] : device.type === "PRESENTATION" ? "PRESENTATION" : "CUSTOM";
  // "No device" (help.figma.com 360040318013: "set to No device or Presentation").
  const options = [
    { value: "NONE", label: t("No device") },
    "-" as const,
    ...DEVICE_PRESETS.flatMap((g, i) => [...(i ? ["-" as const] : []), ...g.items.map(([id, label, w, h]) => ({ value: id, label, hint: `${w}×${h}` }))]),
    "-" as const,
    { value: "PRESENTATION", label: t("Presentation") },
    ...(deviceValue === "CUSTOM" ? [{ value: "CUSTOM", label: t("Custom size") }] : []),
  ];
  const setDevice = (v: string) => {
    if (v === "NONE") return void ed.setProps([page], protoFields({ prototypeDevice: null }), "Prototype device");
    if (v === "PRESENTATION") return void ed.setProps([page], protoFields({ prototypeDevice: { type: "PRESENTATION" } }), "Prototype device");
    const p = devicePreset(v);
    if (!p) return;
    ed.setProps([page], protoFields({ prototypeDevice: { type: "PRESET", presetIdentifier: p[0], size: { x: p[2], y: p[3] }, rotation: device?.rotation ?? "NONE" } }), "Prototype device");
  };
  // Model: the preset's colours (help: "Depending on the device you selected, you can specify a certain model").
  const current = device?.type === "PRESET" ? deviceOf(device.presetIdentifier) : null;
  const models = current ? (DEVICE_MODELS[current.preset[0]] ?? []) : [];
  const setModel = (m: string) => {
    if (!current || !device) return;
    ed.setProps([page], protoFields({ prototypeDevice: { ...device, presetIdentifier: presetIdentifierOf(current.preset[0], m) } }), "Prototype device");
  };
  // A transparent background (Figma's default) is shown — and played — as black.
  const stored = pageNode?.prototypeBackgroundColor;
  const background = stored && (stored.a ?? 1) > 0 ? stored : DEFAULT_PROTOTYPE_BACKGROUND;
  const frames = usePageFrames(page);
  const flows = frames.filter((f) => f.flow).sort((a, b) => ((a.flow?.position ?? "") < (b.flow?.position ?? "") ? -1 : 1));
  // Live 2026-10-20 (prototype-preview.txt): one "Prototype settings" section — Device, then the background colour
  // (hex only) —, then Flows, then the tips.
  return (
    <>
      <PanelSection title={t("Prototype settings")}>
        <div className={styles.row}>
          <Select label={t("Device")} value={deviceValue} options={options} onChange={setDevice} className={styles.grow} />
        </div>
        {device?.type === "PRESET" && (
          <div className={styles.row}>
            <SegmentedControl
              label={t("Orientation")}
              fullWidth
              value={device.rotation === "CCW_90" ? "LANDSCAPE" : "PORTRAIT"}
              options={[
                { value: "PORTRAIT", label: t("Portrait") },
                { value: "LANDSCAPE", label: t("Landscape") },
              ]}
              onChange={(v) => ed.setProps([page], protoFields({ prototypeDevice: { ...device, rotation: v === "LANDSCAPE" ? "CCW_90" : "NONE" } }), "Prototype device")}
            />
          </div>
        )}
        {current && models.length > 1 && (
          <div className={styles.row}>
            <Select label={t("Model")} value={current.model} options={models.map(([value, label]) => ({ value, label: t(label) }))} onChange={setModel} className={styles.grow} />
          </div>
        )}
        <div className={styles.row}>
          <ColorInput
            className={styles.grow}
            label={t("Background color")}
            color={colorToHex(background)}
            opacity={100}
            onColor={(hex, info) => ed.edit("Prototype background", info, () => void ed.engine.setProps([page], protoFields({ prototypeBackgroundColor: hexToColor(hex, 1) })))}
          />
        </div>
      </PanelSection>
      {/* Live: a row per flow — its name, and on hover "select frame", "copy flow link" and "preview" (the inline
          preview at the flow). */}
      <PanelSection title={t("Flows")} empty={flows.length === 0}>
        {flows.map((f) => {
          const name = f.flow?.name || t("Flow");
          return (
            <div key={f.guid} className={styles.flowRow} data-flow={f.guid}>
              <span className={styles.flowName}>{name}</span>
              <span className={styles.flowActions}>
                <IconButton icon="24.proto.target" label={t("{name}, select frame", { name })} onClick={() => selectFrame(ed, f.guid)} />
                <IconButton icon="24.proto.link" label={t("{name}, copy flow link", { name })} onClick={() => copyFlowLink(ed, f.guid)} />
                <IconButton icon="24.proto.preview" label={t("{name}, preview", { name })} onClick={() => openPreview(ed, f.guid)} />
              </span>
            </div>
          );
        })}
      </PanelSection>
      <PrototypeTips />
    </>
  );
}

/** A flow's frame selected and zoomed to. */
function selectFrame(ed: EditorController, frame: Guid): void {
  ed.engine.setSelection([frame]);
  ed.engine.command("ZOOM_TO_SELECTION");
}

/** "Copy flow link": the presentation's address starting at the flow. */
function copyFlowLink(ed: EditorController, frame: Guid): void {
  const link = flowLink(ed, frame);
  void navigator.clipboard?.writeText(link).then(
    () => showToast({ message: t("Link copied to clipboard") }),
    () => showToast({ message: t("The link couldn't be copied"), kind: "error" }),
  );
}

/** A flow's "preview": the inline preview at its starting frame. */
function openPreview(ed: EditorController, frame: Guid): void {
  ed.ui.set({ preview: { page: ed.store.page, node: frame } });
}

// ── A selection ──────────────────────────────────────────────────────────────

function Selected({
  nodes,
  onOpen,
  openIndex,
}: {
  nodes: ProtoNode[];
  onOpen: (node: Guid, index: number, anchor: HTMLElement | null) => void;
  openIndex: { node: Guid; index: number } | null;
}) {
  useT();
  const ed = useEditor();
  const page = useCurrentPage(ed.store);
  const one = nodes.length === 1 ? nodes[0] : null;
  // Top-level: on the page, or in a section on it (Figma's; the player's screens).
  const topLevel = one ? one.parentIndex?.guid === page || presentStart(ed, one.guid) === one.guid : false;
  const frames = usePageFrames(page);
  const isFrame = (n: ProtoNode) => (n.type === "FRAME" && n.resizeToFit !== true) || n.type === "SYMBOL" || n.type === "INSTANCE";
  return (
    <>
      {one && topLevel && isFrame(one) && <FlowSection frame={one} frames={frames} />}
      <InteractionsSection nodes={nodes} frames={frames} onOpen={onOpen} openIndex={openIndex} screens={nodes.length > 1 && nodes.every((n) => n.parentIndex?.guid === page && isFrame(n))} />
      {nodes.every((n) => hasVideoFill(n as never)) && <VideoSection nodes={nodes} />}
      <ScrollSection nodes={nodes} topLevel={topLevel} isFrame={nodes.every(isFrame)} />
      {/* Live 2026-10-19 (prototype.txt): "Show prototype settings" — the page's Device, Background and Flows, shown
          with nothing selected — then Figma's tips. (Figma's "Send to Figma Make" row has no counterpart here.) */}
      <div className={styles.settingsRow}>
        <Button variant="secondary" fullWidth onClick={() => ed.engine.setSelection([])} data-show-prototype-settings="">
          {t("Show prototype settings")}
        </Button>
      </div>
      <PrototypeTips />
    </>
  );
}

const TIPS_KEY = "designer.prototypeTips";
const TIPS = [
  { id: "remove", title: "Removing a connection", icon: "24.proto.tip.remove", text: "To delete a connection, click and drag on either end." },
  {
    id: "run",
    title: "Running your prototype",
    icon: "16.proto.tip.play",
    text: "Use the play button in the toolbar to play your prototype. If there are no connections, the play button can be used to play a presentation of your frames.",
  },
] as const;

/** The tips' Close: kept per machine (localStorage, like the preferences) */
function closedTips(): string[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(TIPS_KEY) : null;
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function PrototypeTips() {
  useT();
  const [closed, setClosed] = useState<string[]>(closedTips);
  const close = (id: string) => {
    const next = [...closed, id];
    setClosed(next);
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(TIPS_KEY, JSON.stringify(next));
    } catch {
      // Private mode or a full store: closed for this session.
    }
  };
  return (
    <>
      {TIPS.filter((tip) => !closed.includes(tip.id)).map((tip) => (
        <section key={tip.id} className={styles.tip} aria-label={t(tip.title)} data-prototype-tip={tip.id}>
          <div className={styles.tipHeader}>
            <span>{t(tip.title)}</span>
            <IconButton icon="24.close.small" label={t("Close")} tone="secondary" onClick={() => close(tip.id)} />
          </div>
          <div className={styles.tipBody}>
            <span className={styles.tipGlyph}>
              <Icon name={tip.icon} />
            </span>
            <p className={styles.tipText}>{t(tip.text)}</p>
          </div>
        </section>
      ))}
    </>
  );
}

function FlowSection({ frame, frames }: { frame: ProtoNode; frames: PageFrame[] }) {
  useT();
  const ed = useEditor();
  const flow = frame.prototypeStartingPoint;
  const [describing, setDescribing] = useState(!!flow?.description);
  const add = () => {
    const flows = frames.filter((f) => f.flow);
    const last = flows.reduce((m, f) => ((f.flow?.position ?? "") > m ? (f.flow?.position ?? "") : m), "");
    ed.setProps([frame.guid], protoFields({ prototypeStartingPoint: { name: nextFlowName(flows.map((f) => f.flow?.name ?? "")), position: keyBetween(last, null, "LOW") } }), "Add starting point");
  };
  // The starting point moved to another top-level frame (live: the frame list beside the name), keeping its flow.
  const move = (to: Guid) => {
    if (!flow || to === frame.guid) return;
    ed.batch("Edit flow starting point", () => {
      ed.engine.setProps([frame.guid], protoFields({ prototypeStartingPoint: null }));
      ed.engine.setProps([to], protoFields({ prototypeStartingPoint: flow }));
    });
    ed.engine.setSelection([to]);
  };
  const targets = frames.filter((f) => !f.isStateGroup && (f.guid === frame.guid || !f.flow)).reverse();
  // Live 2026-10-20 (prototype-preview.txt): the header's Copy flow link and − ; a row of the flow's name (88), its
  // frame (88) and Edit flow description, which shows the description's field under it.
  return (
    <PanelSection
      title={t("Flow starting point")}
      empty={!flow}
      actions={
        flow ? (
          <>
            <IconButton icon="24.proto.link" label={t("Copy flow link")} onClick={() => copyFlowLink(ed, frame.guid)} />
            <IconButton icon="24.minus.small" label={t("Remove flow starting point")} onClick={() => ed.setProps([frame.guid], protoFields({ prototypeStartingPoint: null }), "Remove starting point")} />
          </>
        ) : (
          <IconButton icon="24.plus.small" label={t("Add starting point")} tone="secondary" onClick={add} />
        )
      }
    >
      {flow && (
        <>
          <div className={styles.row}>
            <TextInput
              className={styles.field}
              label={t("Edit flow title")}
              value={flow.name ?? ""}
              onCommit={(name) => ed.setProps([frame.guid], protoFields({ prototypeStartingPoint: { ...flow, name: name.trim() || flow.name } }), "Rename flow")}
            />
            <Select className={styles.field} label={t("Flow starting point")} value={frame.guid} options={targets.map((f) => ({ value: f.guid, label: f.name || t("Frame") }))} onChange={move} />
            <ToggleIconButton icon="24.proto.description" label={t("Edit flow description")} pressed={describing} onPressedChange={setDescribing} />
          </div>
          {describing && (
            <div className={styles.row}>
              <TextInput
                className={styles.grow}
                label={t("Description")}
                placeholder={t("Add description")}
                autoFocus={!flow.description}
                value={flow.description ?? ""}
                onCommit={(description) => ed.setProps([frame.guid], protoFields({ prototypeStartingPoint: { ...flow, description } }), "Edit flow description")}
              />
            </div>
          )}
        </>
      )}
    </PanelSection>
  );
}

function InteractionsSection({
  nodes,
  frames,
  onOpen,
  openIndex,
  screens,
}: {
  nodes: ProtoNode[];
  frames: PageFrame[];
  onOpen: (node: Guid, index: number, anchor: HTMLElement | null) => void;
  openIndex: { node: Guid; index: number } | null;
  /** Two or more top-level frames: "Add interactions" (AI) connects them */
  screens?: boolean;
}) {
  useT();
  const ed = useEditor();
  const one = nodes.length === 1 ? nodes[0] : null;
  const list = one ? liveInteractions(one.prototypeInteractions) : [];
  const mixed = !one && new Set(nodes.map((n) => JSON.stringify(liveInteractions(n.prototypeInteractions)))).size > 1;
  const names = new Map(frames.map((f) => [f.guid, f.name]));
  const nameOf = (id: Guid) => names.get(id) ?? (ed.engine.readNode(id, { fields: ["name"] })?.name ?? null);
  const write = (node: ProtoNode, next: PrototypeInteraction[], label: string) => {
    const all = node.prototypeInteractions ?? [];
    // Figma's deleted entries (tombstones) stay as they were.
    const kept = all.filter((i) => i.isDeleted);
    const value = [...next, ...kept];
    ed.setProps([node.guid], protoFields({ prototypeInteractions: value.length ? value : null }), label);
  };
  const add = (e: React.MouseEvent<HTMLElement>) => {
    const anchor = (e.currentTarget.closest("section") as HTMLElement | null) ?? null;
    ed.batch("Add interaction", () => {
      for (const n of nodes) {
        const next = [...liveInteractions(n.prototypeInteractions), newInteraction(newInteractionId(ed.source.sessionID ?? 1))];
        ed.engine.setProps([n.guid], protoFields({ prototypeInteractions: [...next, ...(n.prototypeInteractions ?? []).filter((i) => i.isDeleted)] }));
      }
    });
    if (one) onOpen(one.guid, list.length, anchor);
  };
  return (
    <PanelSection title={t("Interactions")} empty={list.length === 0 && !mixed && !screens} actions={<IconButton icon="24.plus.small" label={t("Add interaction")} tone="secondary" onClick={add} />}>
      {screens && <AddInteractionsButton />}
      {mixed && <div className={styles.note}>{t("Click + to replace mixed interactions")}</div>}
      {one &&
        // Live (2026-10-10): the newest interaction on top; each row "Hover → 1" — the short trigger, the first
        // action's glyph, where it goes — in a 184 × 26 outlined button; "−" while the row is hovered; the open one's
        // row filled.
        list
          .map((i, index) => ({ i, index }))
          .reverse()
          .map(({ i, index }) => {
            const s = interactionSummary(i, nameOf);
            const isOpen = openIndex?.node === one.guid && openIndex.index === index;
            return (
              <div key={index} className={cx(styles.interaction, isOpen && styles.interactionOpen)} data-interaction={index}>
                <button type="button" className={styles.interactionButton} aria-haspopup="dialog" aria-expanded={isOpen} onClick={(e) => onOpen(one.guid, index, e.currentTarget)}>
                  <span className={styles.trigger}>{t(s.trigger)}</span>
                  <Icon name={ACTION_ICON[s.kind]} className={styles.actionIcon} />
                  <span className={styles.target}>{s.action === actionLabel(s.kind) || s.action === "None" ? t(s.action) : s.action}</span>
                </button>
                <IconButton
                  icon="24.minus.small"
                  label={t("Remove interaction")}
                  tone="secondary"
                  className={styles.remove}
                  onClick={() => write(one, list.filter((_, k) => k !== index), "Remove interaction")}
                />
              </div>
            );
          })}
    </PanelSection>
  );
}

/** Prototype › Video: what the video does when its frame is shown (Autoplay, Loop, the sound). */
function VideoSection({ nodes }: { nodes: ProtoNode[] }) {
  useT();
  const ed = useEditor();
  const all = (f: (n: ProtoNode) => boolean): boolean | typeof MIXED => {
    const v = new Set(nodes.map(f));
    return v.size === 1 ? nodes.map(f)[0] : MIXED;
  };
  const autoplay = all((n) => !!n.videoPlayback?.autoplay);
  const loop = all((n) => !!n.videoPlayback?.mediaLoop);
  const muted = all((n) => !!n.videoPlayback?.muted);
  const set = (patch: Partial<NonNullable<ProtoNode["videoPlayback"]>>, label: string) =>
    ed.batch(label, () => {
      for (const n of nodes) ed.engine.setProps([n.guid], protoFields({ videoPlayback: { ...(n.videoPlayback ?? {}), ...patch } }));
    });
  return (
    <PanelSection title={t("Video")}>
      <div className={styles.videoRow} data-video-settings>
        <Checkbox label={t("Autoplay")} checked={autoplay} onChange={(c) => set({ autoplay: c }, "Video autoplay")} className={styles.grow} />
        <ToggleIconButton icon="24.loop" label={t("Loop")} pressed={loop} onPressedChange={(on) => set({ mediaLoop: on }, "Video loop")} />
        <ToggleIconButton
          icon={muted === true ? "24.sound.off" : "24.sound"}
          label={muted === true ? t("Sound off") : t("Sound on")}
          pressed={muted === MIXED ? MIXED : !muted}
          onPressedChange={(on) => set({ muted: !on }, "Video sound")}
        />
      </div>
    </PanelSection>
  );
}

function ScrollSection({ nodes, topLevel, isFrame }: { nodes: ProtoNode[]; topLevel: boolean; isFrame: boolean }) {
  useT();
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const same = <T,>(f: (n: ProtoNode) => T): T | "mixed" => {
    const vals = new Set(nodes.map((n) => JSON.stringify(f(n) ?? null)));
    return vals.size === 1 ? f(nodes[0]) : "mixed";
  };
  const overflow = same((n) => n.scrollDirection ?? "NONE");
  const position = same((n) => n.scrollBehavior ?? "SCROLLS");
  return (
    <PanelSection title={t("Scroll behavior")}>
      {!topLevel && (
        <div className={styles.labelled}>
          <span className={styles.label}>{t("Position")}</span>
          <Select
            label={t("Position")}
            className={styles.grow}
            value={position === "mixed" ? MIXED : (position as string)}
            options={SCROLL_POSITIONS.map((o) => ({ ...o, label: t(o.label) }))}
            onChange={(v) => ed.setProps(refs, protoFields({ scrollBehavior: v === "SCROLLS" ? null : (v as ScrollBehavior) }), "Scroll position")}
          />
        </div>
      )}
      {isFrame && (
        <div className={styles.labelled}>
          <span className={styles.label}>{t("Overflow")}</span>
          <Select
            label={t("Overflow")}
            className={styles.grow}
            value={overflow === "mixed" ? MIXED : (overflow as string)}
            options={OVERFLOWS.map((o) => ({ ...o, label: t(o.label) }))}
            onChange={(v) => ed.setProps(refs, protoFields({ scrollDirection: v === "NONE" ? null : (v as ScrollDirection) }), "Overflow")}
          />
        </div>
      )}
    </PanelSection>
  );
}
