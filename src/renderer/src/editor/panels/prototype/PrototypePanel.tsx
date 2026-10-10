/**
 * The Prototype tab (UI3; docs/research/figma/R8-prototyping.md §1):
 * - nothing selected: Device (None or a preset, Portrait / Landscape), Background (the presentation's colour), Flows
 *   (the page's flow starting points; a row selects its frame, ▶ presents it);
 * - a top-level frame: Flow starting point (+ / its name and description / −), Interactions, Scroll behavior
 *   (Overflow);
 * - any other layer: Interactions, Scroll behavior (Position; Overflow for frames);
 * - a video (a layer with a video fill): Video (help.figma.com 8878274530455 "Video properties": "Check the box to
 *   autoplay video", "Click the Loop icon to loop video", "Click the Sound icon to turn the video's default sound
 *   setting on or off") — the schema's videoPlayback.
 * An interaction row ("On click · Details") opens Interaction details (InteractionDetails.tsx). Everything is stored in
 * the schema's prototype fields (prototypeInteractions, prototypeStartingPoint, prototypeDevice,
 * prototypeBackgroundColor, scrollDirection, scrollBehavior), so it round-trips with .fig files.
 */
import { useEffect, useMemo, useState } from "react";
import { Checkbox, ColorInput, Icon, IconButton, MIXED, PanelSection, SegmentedControl, Select, TextInput, ToggleIconButton, cx } from "@/ds";
import type { Color, Guid, NodeChange, NodeFields } from "@/engine/codec";
import { useCurrentPage } from "@/engine/hooks";
import { keyBetween } from "../../../../../shared/schema/fractionalIndex";
import { useEditor, type EditorController } from "../../controller";
import { useDocumentVersion, useNodes, GEOMETRY_GROUPS } from "../../hooks";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import {
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
import { present } from "../../present";
import { InteractionDetails, hasVideoFill } from "./InteractionDetails";
import styles from "./Prototype.module.css";

export type ProtoNode = PanelNode & PrototypeFields;

/** Unmodelled fields cross as JSON with their schema names; null clears one. */
export const protoFields = (f: { [K in keyof PrototypeFields]?: PrototypeFields[K] | null }): NodeFields => f as unknown as NodeFields;

/** The presentation's default background (Figma's dark grey). */
export const DEFAULT_PROTOTYPE_BACKGROUND: Color = { r: 0x1e / 255, g: 0x1e / 255, b: 0x1e / 255, a: 1 };

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
    const pageNode = ed.engine.readNodes([page], { childIds: true })[0] as (NodeChange & { childIds?: Guid[] }) | undefined;
    const ids = pageNode?.childIds ?? [];
    if (!ids.length) return [];
    const rows = ed.engine.readNodes(ids, { fields: ["name", "type", "prototypeStartingPoint", "resizeToFit", "isStateGroup", "visible"] }) as (NodeChange &
      PrototypeFields & { isStateGroup?: boolean; resizeToFit?: boolean })[];
    return rows
      .map((n) => ed.withRealType(n) as typeof n & { type?: string })
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
  const [open, setOpen] = useState<{ node: Guid; index: number; anchor: DOMRect | HTMLElement | null; placement?: "bottom" } | null>(null);
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
      setOpen({ node: e.node, index: e.index, anchor, placement: "bottom" });
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
      {open && <InteractionDetails node={open.node} index={open.index} anchor={open.anchor} placement={open.placement} onClose={() => setOpen(null)} />}
    </>
  );
}

// ── Nothing selected: Device, Background, Flows ──────────────────────────────

function NothingSelected() {
  const ed = useEditor();
  const page = useCurrentPage(ed.store);
  const [pageNode] = useNodes([page]) as (ProtoNode | null)[];
  const device = pageNode?.prototypeDevice;
  const preset = device?.type === "PRESET" ? devicePreset(device.presetIdentifier) : null;
  const deviceValue = !device || !device.type || device.type === "NONE" ? "NONE" : device.type === "PRESET" && preset ? preset[0] : device.type === "PRESENTATION" ? "PRESENTATION" : "CUSTOM";
  // "No device" (help.figma.com 360040318013: "set to No device or Presentation").
  const options = [
    { value: "NONE", label: "No device" },
    "-" as const,
    ...DEVICE_PRESETS.flatMap((g, i) => [...(i ? ["-" as const] : []), ...g.items.map(([id, label, w, h]) => ({ value: id, label, hint: `${w}×${h}` }))]),
    "-" as const,
    { value: "PRESENTATION", label: "Presentation" },
    ...(deviceValue === "CUSTOM" ? [{ value: "CUSTOM", label: "Custom size" }] : []),
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
  const background = pageNode?.prototypeBackgroundColor ?? DEFAULT_PROTOTYPE_BACKGROUND;
  const frames = usePageFrames(page);
  const flows = frames.filter((f) => f.flow).sort((a, b) => ((a.flow?.position ?? "") < (b.flow?.position ?? "") ? -1 : 1));
  return (
    <>
      <PanelSection title="Device">
        <div className={styles.row}>
          <Select label="Device" value={deviceValue} options={options} onChange={setDevice} className={styles.grow} />
        </div>
        {device?.type === "PRESET" && (
          <div className={styles.row}>
            <SegmentedControl
              label="Orientation"
              fullWidth
              value={device.rotation === "CCW_90" ? "LANDSCAPE" : "PORTRAIT"}
              options={[
                { value: "PORTRAIT", label: "Portrait" },
                { value: "LANDSCAPE", label: "Landscape" },
              ]}
              onChange={(v) => ed.setProps([page], protoFields({ prototypeDevice: { ...device, rotation: v === "LANDSCAPE" ? "CCW_90" : "NONE" } }), "Prototype device")}
            />
          </div>
        )}
        {current && models.length > 1 && (
          <div className={styles.row}>
            <Select label="Model" value={current.model} options={models.map(([value, label]) => ({ value, label }))} onChange={setModel} className={styles.grow} />
          </div>
        )}
      </PanelSection>
      <PanelSection title="Background">
        <div className={styles.row}>
          <ColorInput
            className={styles.grow}
            label="Prototype background"
            color={colorToHex(background)}
            opacity={toPercent(background.a ?? 1)}
            onColor={(hex, info) => ed.edit("Prototype background", info, () => void ed.engine.setProps([page], protoFields({ prototypeBackgroundColor: hexToColor(hex, background.a ?? 1) })))}
            onOpacity={(o, info) => ed.edit("Prototype background", info, () => void ed.engine.setProps([page], protoFields({ prototypeBackgroundColor: { ...background, a: o / 100 } })))}
          />
        </div>
      </PanelSection>
      <PanelSection title="Flows" empty={flows.length === 0}>
        {flows.map((f) => (
          <div key={f.guid} className={styles.flowRow} data-flow={f.guid}>
            <button
              type="button"
              className={styles.flowName}
              onClick={() => {
                ed.engine.setSelection([f.guid]);
                ed.engine.command("ZOOM_TO_SELECTION");
              }}
            >
              <Icon name="16.play" />
              <span>{f.flow?.name || "Flow"}</span>
            </button>
            <IconButton icon="24.play.small" label="Present flow" tone="secondary" onClick={() => present(ed, { node: f.guid })} />
          </div>
        ))}
      </PanelSection>
    </>
  );
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
  const ed = useEditor();
  const page = useCurrentPage(ed.store);
  const one = nodes.length === 1 ? nodes[0] : null;
  const topLevel = one ? one.parentIndex?.guid === page : false;
  const frames = usePageFrames(page);
  const isFrame = (n: ProtoNode) => (n.type === "FRAME" && n.resizeToFit !== true) || n.type === "SYMBOL" || n.type === "INSTANCE";
  return (
    <>
      {one && topLevel && isFrame(one) && <FlowSection frame={one} frames={frames} />}
      <InteractionsSection nodes={nodes} frames={frames} onOpen={onOpen} openIndex={openIndex} />
      {nodes.every((n) => hasVideoFill(n as never)) && <VideoSection nodes={nodes} />}
      <ScrollSection nodes={nodes} topLevel={topLevel} isFrame={nodes.every(isFrame)} />
    </>
  );
}

function FlowSection({ frame, frames }: { frame: ProtoNode; frames: PageFrame[] }) {
  const ed = useEditor();
  const flow = frame.prototypeStartingPoint;
  const add = () => {
    const flows = frames.filter((f) => f.flow);
    const last = flows.reduce((m, f) => ((f.flow?.position ?? "") > m ? (f.flow?.position ?? "") : m), "");
    ed.setProps([frame.guid], protoFields({ prototypeStartingPoint: { name: nextFlowName(flows.map((f) => f.flow?.name ?? "")), position: keyBetween(last, null, "LOW") } }), "Add starting point");
  };
  return (
    <PanelSection
      title="Flow starting point"
      empty={!flow}
      actions={flow ? undefined : <IconButton icon="24.plus.small" label="Add starting point" tone="secondary" onClick={add} />}
    >
      {flow && (
        <>
          <div className={styles.row}>
            <TextInput
              className={styles.grow}
              label="Flow name"
              prefix="16.play"
              value={flow.name ?? ""}
              onCommit={(name) => ed.setProps([frame.guid], protoFields({ prototypeStartingPoint: { ...flow, name: name.trim() || flow.name } }), "Rename flow")}
            />
            <IconButton icon="24.minus.small" label="Remove starting point" tone="secondary" onClick={() => ed.setProps([frame.guid], protoFields({ prototypeStartingPoint: null }), "Remove starting point")} />
          </div>
          <div className={styles.row}>
            <TextInput
              className={styles.grow}
              label="Description"
              placeholder="Add description"
              value={flow.description ?? ""}
              onCommit={(description) => ed.setProps([frame.guid], protoFields({ prototypeStartingPoint: { ...flow, description } }), "Edit flow description")}
            />
          </div>
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
}: {
  nodes: ProtoNode[];
  frames: PageFrame[];
  onOpen: (node: Guid, index: number, anchor: HTMLElement | null) => void;
  openIndex: { node: Guid; index: number } | null;
}) {
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
    <PanelSection title="Interactions" empty={list.length === 0 && !mixed} actions={<IconButton icon="24.plus.small" label="Add interaction" tone="secondary" onClick={add} />}>
      {mixed && <div className={styles.note}>Click + to replace mixed interactions</div>}
      {one &&
        list.map((i, index) => {
          const s = interactionSummary(i, nameOf);
          const isOpen = openIndex?.node === one.guid && openIndex.index === index;
          return (
            <div key={index} className={cx(styles.interaction, isOpen && styles.interactionOpen)} data-interaction={index}>
              <button type="button" className={styles.interactionButton} onClick={(e) => onOpen(one.guid, index, e.currentTarget)}>
                <Icon name={triggerIcon(i)} />
                <span className={styles.trigger}>{s.trigger}</span>
                <span className={styles.action}>{s.action}</span>
              </button>
              <IconButton
                icon="24.minus.small"
                label="Remove interaction"
                tone="secondary"
                onClick={() => write(one, list.filter((_, k) => k !== index), "Remove interaction")}
              />
            </div>
          );
        })}
    </PanelSection>
  );
}

function triggerIcon(i: PrototypeInteraction) {
  switch (i.event?.interactionType) {
    case "ON_HOVER":
    case "MOUSE_ENTER":
    case "MOUSE_LEAVE":
    case "MOUSE_IN":
    case "MOUSE_OUT":
      return "24.interaction.hover.small" as const;
    case "DRAG":
      return "24.interaction.drag.small" as const;
    case "AFTER_TIMEOUT":
      return "24.recent" as const;
    default:
      return "24.interaction.click.small" as const;
  }
}

/** Prototype › Video: what the video does when its frame is shown (Autoplay, Loop, the sound). */
function VideoSection({ nodes }: { nodes: ProtoNode[] }) {
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
    <PanelSection title="Video">
      <div className={styles.videoRow} data-video-settings>
        <Checkbox label="Autoplay" checked={autoplay} onChange={(c) => set({ autoplay: c }, "Video autoplay")} className={styles.grow} />
        <ToggleIconButton icon="24.loop" label="Loop" pressed={loop} onPressedChange={(on) => set({ mediaLoop: on }, "Video loop")} />
        <ToggleIconButton
          icon={muted === true ? "24.sound.off" : "24.sound"}
          label={muted === true ? "Sound off" : "Sound on"}
          pressed={muted === MIXED ? MIXED : !muted}
          onPressedChange={(on) => set({ muted: !on }, "Video sound")}
        />
      </div>
    </PanelSection>
  );
}

function ScrollSection({ nodes, topLevel, isFrame }: { nodes: ProtoNode[]; topLevel: boolean; isFrame: boolean }) {
  const ed = useEditor();
  const refs = nodes.map((n) => n.guid);
  const same = <T,>(f: (n: ProtoNode) => T): T | "mixed" => {
    const vals = new Set(nodes.map((n) => JSON.stringify(f(n) ?? null)));
    return vals.size === 1 ? f(nodes[0]) : "mixed";
  };
  const overflow = same((n) => n.scrollDirection ?? "NONE");
  const position = same((n) => n.scrollBehavior ?? "SCROLLS");
  return (
    <PanelSection title="Scroll behavior">
      {!topLevel && (
        <div className={styles.labelled}>
          <span className={styles.label}>Position</span>
          <Select
            label="Position"
            className={styles.grow}
            value={position === "mixed" ? MIXED : (position as string)}
            options={SCROLL_POSITIONS}
            onChange={(v) => ed.setProps(refs, protoFields({ scrollBehavior: v === "SCROLLS" ? null : (v as ScrollBehavior) }), "Scroll position")}
          />
        </div>
      )}
      {isFrame && (
        <div className={styles.labelled}>
          <span className={styles.label}>Overflow</span>
          <Select
            label="Overflow"
            className={styles.grow}
            value={overflow === "mixed" ? MIXED : (overflow as string)}
            options={OVERFLOWS}
            onChange={(v) => ed.setProps(refs, protoFields({ scrollDirection: v === "NONE" ? null : (v as ScrollDirection) }), "Overflow")}
          />
        </div>
      )}
    </PanelSection>
  );
}
