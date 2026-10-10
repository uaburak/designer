/**
 * Interaction details (UI3, R8 §2–§4, §8): the trigger (and its delay or key), then each action — what it does, its
 * destination (a frame, a variant for Change to, a layer for Scroll to), a link, a variable — with its animation
 * (Instant, Dissolve, Smart animate, Move in / out, Push, Slide in / out; the direction; Animate matching layers;
 * easing and duration, a custom bezier's or spring's numbers), State management, and for overlays the destination
 * frame's own overlay settings (Position, Close when clicking outside, Add background behind overlay). "Add action"
 * appends one; a Conditional holds If / Else actions of its own. Videos (help.figma.com 8878274530455): on a video
 * the triggers add "When video hits" (a time) and "When video ends"; in a frame with videos the actions add
 * "Play/pause video", "Mute/unmute video", "Set to specific time" and "Jump forward/backward in time" (their video and
 * choice), and a Navigate to a frame with a video has "Reset video state". Scroll to has its X / Y offset.
 */
import { useMemo, useRef } from "react";
import { Button, Checkbox, ColorInput, IconButton, NumericInput, Popover, SegmentedControl, Select, TextInput, type ChangeInfo } from "@/ds";
import type { Guid, NodeChange } from "@/engine/codec";
import { useCurrentPage } from "@/engine/hooks";
import { useEditor, type EditorController } from "../../controller";
import { useNodes } from "../../hooks";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import {
  ACTIONS,
  ANIMATIONS,
  DIRECTIONS,
  EASINGS,
  OVERLAY_POSITIONS,
  MEDIA_CHOICES,
  TRIGGERS,
  VIDEO_ACTIONS,
  VIDEO_TRIGGERS,
  actionKind,
  formatMediaTime,
  isVideoAction,
  parseMediaTime,
  actionOfKind,
  animates,
  animationOf,
  easingFunctionFor,
  guidJson,
  guidOf,
  isDirectional,
  isSpring,
  keyTriggerLabel,
  keyTriggerOf,
  liveInteractions,
  takesDestination,
  transitionOf,
  withTrigger,
  type ActionKind,
  type Animation,
  type Direction,
  type EasingType,
  type InteractionType,
  type MediaAction,
  type OverlayPositionType,
  type PrototypeAction,
  type PrototypeInteraction,
} from "../../model/prototype";
import { ancestorsOf, protoFields, usePageFrames, type ProtoNode } from "./PrototypePanel";
import { ExpressionField } from "./ExpressionField";
import styles from "./Prototype.module.css";

/** A layer with a visible VIDEO fill (a video, help: "videos are a type of fill"). */
export const hasVideoFill = (n: { fillPaints?: { type?: string; visible?: boolean }[] } | null | undefined): boolean =>
  !!n?.fillPaints?.some((p) => p.type === "VIDEO" && p.visible !== false);

/** The video layers of the top-level frame `source` is in (the destinations of the video actions). */
function videoLayersOf(ed: EditorController, source: Guid): { value: string; label: string }[] {
  const chain = ancestorsOf(ed, source);
  const top = chain.length ? chain[chain.length - 1].guid : source;
  return ed.engine
    .readNodes([top], { subtree: true, fields: ["name", "fillPaints"] })
    .filter((x) => hasVideoFill(x as never))
    .slice(0, 300)
    .map((x) => ({ value: x.guid, label: x.name ?? "" }));
}

/** Whether a frame holds a video (Reset video state only shows then). */
function frameHasVideo(ed: EditorController, frame: Guid): boolean {
  return ed.engine.readNodes([frame], { subtree: true, fields: ["fillPaints"] }).some((x) => hasVideoFill(x as never));
}

const DIRECTION_ICON: Record<Direction, "24.arrow.left" | "24.arrow.right" | "16.arrow.up" | "16.arrow.down"> = {
  LEFT: "24.arrow.left",
  RIGHT: "24.arrow.right",
  UP: "16.arrow.up",
  DOWN: "16.arrow.down",
};

export function InteractionDetails({
  node,
  index,
  anchor,
  onClose,
  placement,
}: {
  node: Guid;
  index: number;
  anchor: DOMRect | HTMLElement | null;
  onClose: () => void;
  /** `bottom`: under a connection's label on the canvas (live 62–63.png); else beside the panel. */
  placement?: "bottom";
}) {
  const ed = useEditor();
  const [n] = useNodes([node]) as (ProtoNode | null)[];
  const list = liveInteractions(n?.prototypeInteractions);
  const interaction = list[index];
  if (!n || !interaction) return null;
  const write = (next: PrototypeInteraction, label = "Edit interaction", info?: ChangeInfo) => {
    const all = [...list];
    all[index] = next;
    const value = [...all, ...(n.prototypeInteractions ?? []).filter((i) => i.isDeleted)];
    const run = () => void ed.engine.setProps([node], protoFields({ prototypeInteractions: value }));
    if (info) ed.edit(label, info, run);
    else ed.batch(label, run);
  };
  const actions = interaction.actions ?? [];
  const setAction = (k: number, a: PrototypeAction, label?: string, info?: ChangeInfo) => {
    const next = [...actions];
    next[k] = a;
    write({ ...interaction, actions: next }, label, info);
  };
  // Round 17 (live 62–63.png): titled "Interaction", "+" (Add action) beside the close button.
  return (
    <Popover
      anchor={anchor}
      placement={placement}
      title="Interaction"
      onClose={onClose}
      width={280}
      headerActions={
        <IconButton icon="24.plus.small" label="Add action" tooltip={false} onClick={() => write({ ...interaction, actions: [...actions, actionOfKind("NONE")] }, "Add action")} />
      }
    >
      <div className={styles.details} data-interaction-details>
        <TriggerRow interaction={interaction} video={hasVideoFill(n as never)} onChange={write} />
        {actions.map((a, k) => (
          <ActionEditor
            key={k}
            source={node}
            action={a}
            depth={0}
            onChange={(next, label, info) => setAction(k, next, label, info)}
            onRemove={actions.length > 1 ? () => write({ ...interaction, actions: actions.filter((_, j) => j !== k) }, "Remove action") : undefined}
          />
        ))}
      </div>
    </Popover>
  );
}

function TriggerRow({ interaction, video, onChange }: { interaction: PrototypeInteraction; video: boolean; onChange: (i: PrototypeInteraction, label?: string, info?: ChangeInfo) => void }) {
  const t = interaction.event?.interactionType ?? "ON_CLICK";
  const recorder = useRef<HTMLButtonElement>(null);
  const videoTrigger = t === "ON_MEDIA_HIT" || t === "ON_MEDIA_END";
  return (
    <>
      <div className={styles.row}>
        <Select
          label="Trigger"
          className={styles.grow}
          value={t === "MOUSE_IN" ? "MOUSE_ENTER" : t === "MOUSE_OUT" ? "MOUSE_LEAVE" : t}
          options={video || videoTrigger ? [...TRIGGERS, "-" as const, ...VIDEO_TRIGGERS] : TRIGGERS}
          onChange={(v) => onChange(withTrigger(interaction, v as InteractionType), "Edit trigger")}
        />
      </div>
      {t === "ON_MEDIA_HIT" && (
        <div className={styles.labelled}>
          <span className={styles.label}>Time</span>
          <TextInput
            label="Time"
            className={styles.grow}
            value={formatMediaTime(interaction.event?.mediaHitTime)}
            onCommit={(text) => {
              const s = parseMediaTime(text);
              if (s !== null) onChange({ ...interaction, event: { ...interaction.event, mediaHitTime: s } }, "Edit trigger");
            }}
          />
        </div>
      )}
      {t === "AFTER_TIMEOUT" && (
        <div className={styles.labelled}>
          <span className={styles.label}>Delay</span>
          <NumericInput
            label="Delay"
            className={styles.grow}
            value={Math.round((interaction.event?.transitionTimeout ?? 0.8) * 1000)}
            unit="ms"
            min={1}
            max={10000}
            precision={0}
            onChange={(v, info) => onChange({ ...interaction, event: { ...interaction.event, transitionTimeout: v / 1000 } }, "Edit delay", info)}
          />
        </div>
      )}
      {t === "ON_KEY_DOWN" && (
        <div className={styles.row}>
          <button
            ref={recorder}
            type="button"
            className={styles.keyRecorder}
            aria-label="Key"
            onKeyDown={(e) => {
              if (e.key === "Tab") return;
              e.preventDefault();
              e.stopPropagation();
              if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
              onChange({ ...interaction, event: { ...interaction.event, keyTrigger: { keyCodes: keyTriggerOf(e.nativeEvent), triggerDevice: "KEYBOARD" } } }, "Edit key");
            }}
          >
            {keyTriggerLabel(interaction.event?.keyTrigger?.keyCodes) || "Type a key"}
          </button>
        </div>
      )}
    </>
  );
}

/** The layers an action can go to. */
function useDestinations(source: Guid, kind: ActionKind): { value: string; label: string }[] {
  const ed = useEditor();
  const page = useCurrentPage(ed.store);
  const frames = usePageFrames(page);
  return useMemo(() => {
    if (kind === "NAVIGATE" || kind === "OVERLAY" || kind === "SWAP") return frames.filter((f) => !f.isStateGroup).map((f) => ({ value: f.guid, label: f.name }));
    if (kind === "CHANGE_TO") return variantsFor(ed, source);
    if (isVideoAction(kind)) return videoLayersOf(ed, source);
    if (kind === "SCROLL_TO") {
      const chain = ancestorsOf(ed, source);
      const top = chain.length ? chain[chain.length - 1].guid : source;
      return ed.engine
        .readNodes([top], { subtree: true, fields: ["name"] })
        .filter((x) => x.guid !== top)
        .slice(0, 300)
        .map((x) => ({ value: x.guid, label: x.name ?? "" }));
    }
    return [];
  }, [ed, frames, kind, source]);
}

/** Change to: the variants of the set the hotspot is in (a variant or a layer in one), or of the instance's main. */
function variantsFor(ed: EditorController, source: Guid): { value: string; label: string }[] {
  const chain = [ed.engine.readNode(source, { fields: ["name", "type", "parentIndex", "symbolData"] }), ...ancestorsOf(ed, source)].filter(
    (x): x is NodeChange => !!x
  );
  let set: Guid | null = null;
  for (const x of chain) {
    const typed = ed.withRealType(x) as NodeChange & { type?: string; symbolData?: { symbolID?: Guid | { sessionID: number; localID: number } } };
    if (typed.type === "SYMBOL" && x.parentIndex?.guid) {
      const parent = ed.engine.readNode(x.parentIndex.guid, { fields: ["isStateGroup"] }) as (NodeChange & { isStateGroup?: boolean }) | null;
      if (parent?.isStateGroup) {
        set = x.parentIndex.guid;
        break;
      }
    }
    if (typed.type === "INSTANCE") {
      const main = guidOf(typed.symbolData?.symbolID as never);
      const m = main ? ed.engine.readNode(main, { fields: ["parentIndex"] }) : null;
      const parent = m?.parentIndex?.guid ? (ed.engine.readNode(m.parentIndex.guid, { fields: ["isStateGroup"] }) as (NodeChange & { isStateGroup?: boolean }) | null) : null;
      if (parent?.isStateGroup) {
        set = m!.parentIndex!.guid;
        break;
      }
    }
  }
  if (!set) return [];
  const setNode = ed.engine.readNode(set, { childIds: true }) as (NodeChange & { childIds?: Guid[] }) | null;
  return ed.engine.readNodes(setNode?.childIds ?? [], { fields: ["name"] }).map((v) => ({ value: v.guid, label: v.name ?? "" }));
}

function ActionEditor({
  source,
  action,
  depth,
  onChange,
  onRemove,
}: {
  source: Guid;
  action: PrototypeAction;
  depth: number;
  onChange: (a: PrototypeAction, label?: string, info?: ChangeInfo) => void;
  onRemove?: () => void;
}) {
  const ed = useEditor();
  const kind = actionKind(action);
  const dests = useDestinations(source, kind);
  const dest = guidOf(action.transitionNodeID);
  // The video actions: "available for any interaction that ends on a video" — offered where the frame has one.
  const videos = useMemo(() => (ed.engine.destroyed ? [] : videoLayersOf(ed, source)), [ed, source]);
  const actionOptions = [
    { value: "NONE", label: "None" },
    "-" as const,
    ...ACTIONS.filter((a) => depth === 0 || a === "-" || a.value !== "CONDITIONAL"),
    ...(videos.length || isVideoAction(kind) ? ["-" as const, ...VIDEO_ACTIONS] : []),
  ];
  const destHasVideo = kind === "NAVIGATE" && !!dest && frameHasVideo(ed, dest);
  return (
    <div className={styles.actionBlock} data-action={kind}>
      <div className={styles.row}>
        <Select label="Action" className={styles.grow} value={kind} options={actionOptions} onChange={(v) => onChange(actionOfKind(v as ActionKind, action), "Edit action")} />
        {onRemove && <IconButton icon="24.minus.small" label="Remove action" tone="secondary" onClick={onRemove} />}
      </div>
      {takesDestination(kind) && (
        <div className={styles.row}>
          <Select
            label="Destination"
            className={styles.grow}
            value={dest ?? "NONE"}
            options={[{ value: "NONE", label: "None" }, ...(dests.length ? ["-" as const] : []), ...dests]}
            onChange={(v) => {
              const next = { ...action };
              if (v === "NONE") delete next.transitionNodeID;
              else next.transitionNodeID = guidJson(v);
              onChange(next, "Edit destination");
            }}
          />
        </div>
      )}
      {isVideoAction(kind) && (
        <>
          <div className={styles.row}>
            <Select
              label="Video"
              className={styles.grow}
              value={dest ?? "NONE"}
              options={[{ value: "NONE", label: "Choose video" }, ...(dests.length ? ["-" as const] : []), ...dests]}
              onChange={(v) => {
                const next = { ...action };
                if (v === "NONE") delete next.transitionNodeID;
                else next.transitionNodeID = guidJson(v);
                onChange(next, "Edit destination");
              }}
            />
          </div>
          {MEDIA_CHOICES[kind] && (
            <div className={styles.row}>
              <Select
                label={kind === "VIDEO_JUMP" ? "Direction" : "Video action"}
                className={styles.grow}
                value={action.mediaAction ?? "PLAY"}
                options={MEDIA_CHOICES[kind]!}
                onChange={(v) => onChange({ ...action, mediaAction: v as MediaAction }, "Edit action")}
              />
              {kind === "VIDEO_JUMP" && (
                <NumericInput
                  label="Seconds"
                  className={styles.duration}
                  value={action.mediaSkipByAmount ?? 0}
                  unit="s"
                  min={0}
                  precision={1}
                  onChange={(v, info) => onChange({ ...action, mediaSkipByAmount: v }, "Edit action", info)}
                />
              )}
            </div>
          )}
          {kind === "VIDEO_SET_TIME" && (
            <div className={styles.labelled}>
              <span className={styles.label}>Time</span>
              <TextInput
                label="Time"
                className={styles.grow}
                value={formatMediaTime(action.mediaSkipToTime)}
                onCommit={(text) => {
                  const s = parseMediaTime(text);
                  if (s !== null) onChange({ ...action, mediaSkipToTime: s }, "Edit action");
                }}
              />
            </div>
          )}
        </>
      )}
      {kind === "SCROLL_TO" && (
        // Scroll to's offset (extraScrollOffset): how far past the destination's top-left the frame scrolls.
        <div className={styles.labelled}>
          <span className={styles.label}>Offset</span>
          <NumericInput
            label="X offset"
            prefix="X"
            className={styles.grow}
            value={action.extraScrollOffset?.x ?? 0}
            precision={0}
            onChange={(v, info) => onChange({ ...action, extraScrollOffset: { x: v, y: action.extraScrollOffset?.y ?? 0 } }, "Edit offset", info)}
          />
          <NumericInput
            label="Y offset"
            prefix="Y"
            className={styles.grow}
            value={action.extraScrollOffset?.y ?? 0}
            precision={0}
            onChange={(v, info) => onChange({ ...action, extraScrollOffset: { x: action.extraScrollOffset?.x ?? 0, y: v } }, "Edit offset", info)}
          />
        </div>
      )}
      {(kind === "OVERLAY" || kind === "SWAP") && dest && <OverlaySettings frame={dest} />}
      {kind === "URL" && (
        <>
          <div className={styles.row}>
            <TextInput label="Link" className={styles.grow} placeholder="https://" value={action.connectionURL ?? ""} onCommit={(url) => onChange({ ...action, connectionURL: url.trim() }, "Edit link")} />
          </div>
          <div className={styles.checkRow}>
            <Checkbox label="Open in new tab" checked={action.openUrlInNewTab !== false} onChange={(c) => onChange({ ...action, openUrlInNewTab: c }, "Edit link")} />
          </div>
        </>
      )}
      {kind === "SET_VARIABLE" && <SetVariable action={action} onChange={onChange} />}
      {kind === "SET_VARIABLE_MODE" && <SetVariableMode action={action} onChange={onChange} />}
      {kind === "CONDITIONAL" && <Conditional source={source} action={action} depth={depth} onChange={onChange} />}
      {animates(kind) && <AnimationEditor action={action} kind={kind} onChange={onChange} />}
      {kind === "NAVIGATE" && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>State management</div>
          <div className={styles.checkRow}>
            <Checkbox label="Reset scroll position" checked={!!action.transitionResetScrollPosition} onChange={(c) => onChange({ ...action, transitionResetScrollPosition: c }, "Edit interaction")} />
          </div>
          <div className={styles.checkRow}>
            <Checkbox
              label="Reset component state"
              checked={!!action.transitionResetInteractiveComponents}
              onChange={(c) => onChange({ ...action, transitionResetInteractiveComponents: c }, "Edit interaction")}
            />
          </div>
          {(destHasVideo || action.transitionResetVideoPosition) && (
            <div className={styles.checkRow}>
              <Checkbox label="Reset video state" checked={!!action.transitionResetVideoPosition} onChange={(c) => onChange({ ...action, transitionResetVideoPosition: c }, "Edit interaction")} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AnimationEditor({ action, kind, onChange }: { action: PrototypeAction; kind: ActionKind; onChange: (a: PrototypeAction, label?: string, info?: ChangeInfo) => void }) {
  const { animation, direction } = animationOf(action.transitionType);
  const easing = action.easingType ?? "OUT_CUBIC";
  const spring = isSpring(easing);
  // Open overlay never smart-animates (R8 §5); Scroll to only animates or not.
  const options = kind === "OVERLAY" ? ANIMATIONS.filter((a) => a.value !== "SMART_ANIMATE") : kind === "SCROLL_TO" ? ANIMATIONS.filter((a) => a.value === "INSTANT" || a.value === "SMART_ANIMATE") : ANIMATIONS;
  const label = (a: { value: Animation; label: string }) => (kind === "SCROLL_TO" && a.value === "SMART_ANIMATE" ? { ...a, label: "Animate" } : a);
  const setAnimation = (a: Animation, d: Direction = direction) => {
    const transitionType = kind === "SCROLL_TO" && a === "SMART_ANIMATE" ? "SCROLL_ANIMATE" : transitionOf(a, d);
    onChange({ ...action, transitionType }, "Edit animation");
  };
  const shown = kind === "SCROLL_TO" && action.transitionType === "SCROLL_ANIMATE" ? "SMART_ANIMATE" : animation;
  const fn = action.easingFunction ?? easingFunctionFor(easing) ?? [];
  const setFn = (i: number, v: number, info: ChangeInfo) => {
    const next = [...fn];
    next[i] = v;
    onChange({ ...action, easingFunction: next }, "Edit easing", info);
  };
  return (
    <div className={styles.group}>
      <div className={styles.groupTitle}>Animation</div>
      <div className={styles.row}>
        <Select label="Animation" className={styles.grow} value={shown} options={options.map(label)} onChange={(v) => setAnimation(v as Animation)} />
      </div>
      {isDirectional(animation) && (
        <>
          <div className={styles.row}>
            <SegmentedControl
              label="Direction"
              fullWidth
              value={direction}
              options={DIRECTIONS.map((d) => ({ value: d.value, icon: DIRECTION_ICON[d.value], tooltip: d.label }))}
              onChange={(v) => setAnimation(animation, v as Direction)}
            />
          </div>
          <div className={styles.checkRow}>
            <Checkbox label="Animate matching layers" checked={!!action.transitionShouldSmartAnimate} onChange={(c) => onChange({ ...action, transitionShouldSmartAnimate: c }, "Edit animation")} />
          </div>
        </>
      )}
      {shown !== "INSTANT" && (
        <>
          <div className={styles.row}>
            <Select
              label="Curve"
              className={styles.grow}
              value={easing === "SPRING" ? "GENTLE_SPRING" : easing === "EASE_IN" ? "IN_CUBIC" : easing}
              options={EASINGS}
              onChange={(v) => {
                const e = v as EasingType;
                const next: PrototypeAction = { ...action, easingType: e };
                const f = easingFunctionFor(e);
                if (f) next.easingFunction = f;
                else delete next.easingFunction;
                onChange(next, "Edit easing");
              }}
            />
            {!spring && (
              <NumericInput
                label="Duration"
                className={styles.duration}
                value={Math.round((action.transitionDuration ?? 0.3) * 1000)}
                unit="ms"
                min={1}
                max={10000}
                precision={0}
                onChange={(v, info) => onChange({ ...action, transitionDuration: v / 1000 }, "Edit duration", info)}
              />
            )}
          </div>
          {easing === "CUSTOM_CUBIC" && (
            <div className={styles.quad}>
              {["X1", "Y1", "X2", "Y2"].map((p, i) => (
                <NumericInput key={p} label={p} prefix={p} value={fn[i] ?? 0} step={0.01} precision={2} onChange={(v, info) => setFn(i, v, info)} />
              ))}
            </div>
          )}
          {easing === "CUSTOM_SPRING" && (
            <div className={styles.quad}>
              {["Mass", "Stiffness", "Damping"].map((p, i) => (
                <NumericInput key={p} label={p} prefix={p[0]} value={fn[i] ?? [1, 100, 15][i]} min={i === 2 ? 0 : 0.01} step={i === 0 ? 0.1 : 1} precision={i === 0 ? 2 : 0} onChange={(v, info) => setFn(i, v, info)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Open / Swap overlay: the destination frame's own overlay settings (shared by every interaction that opens it). */
function OverlaySettings({ frame }: { frame: Guid }) {
  const ed = useEditor();
  const [n] = useNodes([frame]) as (ProtoNode | null)[];
  if (!n) return null;
  const bg = n.overlayBackgroundAppearance;
  const on = bg?.backgroundType === "SOLID_COLOR";
  const color = bg?.backgroundColor ?? { r: 0, g: 0, b: 0, a: 0.25 };
  return (
    <div className={styles.group}>
      <div className={styles.groupTitle}>Overlay</div>
      <div className={styles.labelled}>
        <span className={styles.label}>Position</span>
        <Select
          label="Overlay position"
          className={styles.grow}
          value={n.overlayPositionType ?? "CENTER"}
          options={OVERLAY_POSITIONS}
          onChange={(v) => ed.setProps([frame], protoFields({ overlayPositionType: v as OverlayPositionType }), "Overlay position")}
        />
      </div>
      <div className={styles.checkRow}>
        <Checkbox
          label="Close when clicking outside"
          checked={n.overlayBackgroundInteraction === "CLOSE_ON_CLICK_OUTSIDE"}
          onChange={(c) => ed.setProps([frame], protoFields({ overlayBackgroundInteraction: c ? "CLOSE_ON_CLICK_OUTSIDE" : null }), "Overlay settings")}
        />
      </div>
      <div className={styles.checkRow}>
        <Checkbox
          label="Add background behind overlay"
          checked={on}
          onChange={(c) =>
            ed.setProps([frame], protoFields({ overlayBackgroundAppearance: c ? { backgroundType: "SOLID_COLOR", backgroundColor: color } : null }), "Overlay settings")
          }
        />
      </div>
      {on && (
        <div className={styles.row}>
          <ColorInput
            className={styles.grow}
            label="Overlay background"
            color={colorToHex(color)}
            opacity={toPercent(color.a ?? 1)}
            onColor={(hex, info) =>
              ed.edit("Overlay background", info, () => void ed.engine.setProps([frame], protoFields({ overlayBackgroundAppearance: { backgroundType: "SOLID_COLOR", backgroundColor: hexToColor(hex, color.a ?? 0.25) } })))
            }
            onOpacity={(o, info) =>
              ed.edit("Overlay background", info, () => void ed.engine.setProps([frame], protoFields({ overlayBackgroundAppearance: { backgroundType: "SOLID_COLOR", backgroundColor: { ...color, a: o / 100 } } })))
            }
          />
        </div>
      )}
    </div>
  );
}

function variableRef(id: Guid) {
  return { guid: guidJson(id) };
}

function SetVariable({ action, onChange }: { action: PrototypeAction; onChange: (a: PrototypeAction, label?: string, info?: ChangeInfo) => void }) {
  const ed = useEditor();
  const vars = useMemo(() => (ed.engine.destroyed ? [] : ed.engine.variables()), [ed]);
  const current = guidOf(action.targetVariable?.id?.guid ?? null);
  const v = vars.find((x) => x.id === current);
  const value = action.targetVariableData?.value ?? {};
  return (
    <>
      <div className={styles.row}>
        <Select
          label="Variable"
          className={styles.grow}
          value={current ?? "NONE"}
          options={[{ value: "NONE", label: "Choose variable" }, ...(vars.length ? ["-" as const] : []), ...vars.map((x) => ({ value: x.id, label: x.name, hint: x.resolvedType.toLowerCase() }))]}
          onChange={(id) => {
            const chosen = vars.find((x) => x.id === id);
            if (!chosen) return;
            const data =
              chosen.resolvedType === "BOOLEAN" ? { value: { boolValue: true }, dataType: "BOOLEAN" }
              : chosen.resolvedType === "FLOAT" ? { value: { floatValue: 0 }, dataType: "FLOAT" }
              : chosen.resolvedType === "COLOR" ? { value: { colorValue: { r: 0, g: 0, b: 0, a: 1 } }, dataType: "COLOR" }
              : { value: { textValue: "" }, dataType: "STRING" };
            onChange({ ...action, targetVariable: { id: variableRef(id) }, targetVariableData: data }, "Set variable");
          }}
        />
      </div>
      {v && v.resolvedType === "BOOLEAN" && (
        <div className={styles.row}>
          <SegmentedControl
            label="Value"
            fullWidth
            value={value.boolValue ? "true" : "false"}
            options={[
              { value: "true", label: "True" },
              { value: "false", label: "False" },
            ]}
            onChange={(b) => onChange({ ...action, targetVariableData: { value: { boolValue: b === "true" }, dataType: "BOOLEAN" } }, "Set variable")}
          />
        </div>
      )}
      {v && v.resolvedType === "FLOAT" && (
        <div className={styles.row}>
          <NumericInput label="Value" className={styles.grow} value={value.floatValue ?? 0} onChange={(f, info) => onChange({ ...action, targetVariableData: { value: { floatValue: f }, dataType: "FLOAT" } }, "Set variable", info)} />
        </div>
      )}
      {v && v.resolvedType === "STRING" && (
        <div className={styles.row}>
          <TextInput label="Value" className={styles.grow} value={value.textValue ?? ""} onCommit={(t) => onChange({ ...action, targetVariableData: { value: { textValue: t }, dataType: "STRING" } }, "Set variable")} />
        </div>
      )}
      {v && v.resolvedType === "COLOR" && (
        <div className={styles.row}>
          <ColorInput
            label="Value"
            className={styles.grow}
            color={colorToHex(value.colorValue ?? { r: 0, g: 0, b: 0, a: 1 })}
            opacity={toPercent(value.colorValue?.a ?? 1)}
            onColor={(hex, info) => onChange({ ...action, targetVariableData: { value: { colorValue: hexToColor(hex, value.colorValue?.a ?? 1) }, dataType: "COLOR" } }, "Set variable", info)}
            onOpacity={(o, info) => onChange({ ...action, targetVariableData: { value: { colorValue: { ...(value.colorValue ?? { r: 0, g: 0, b: 0, a: 1 }), a: o / 100 } }, dataType: "COLOR" } }, "Set variable", info)}
          />
        </div>
      )}
    </>
  );
}

function SetVariableMode({ action, onChange }: { action: PrototypeAction; onChange: (a: PrototypeAction, label?: string, info?: ChangeInfo) => void }) {
  const ed = useEditor();
  const collections = useMemo(() => (ed.engine.destroyed ? [] : ed.engine.variableCollections()), [ed]);
  const current = guidOf(action.targetVariableSetID?.guid ?? null);
  const c = collections.find((x) => x.id === current);
  const mode = guidOf(action.targetVariableModeID ?? null);
  return (
    <>
      <div className={styles.row}>
        <Select
          label="Collection"
          className={styles.grow}
          value={current ?? "NONE"}
          options={[{ value: "NONE", label: "Choose collection" }, ...(collections.length ? ["-" as const] : []), ...collections.map((x) => ({ value: x.id, label: x.name }))]}
          onChange={(id) => {
            const chosen = collections.find((x) => x.id === id);
            if (!chosen) return;
            const m = chosen.defaultModeId ?? chosen.modes[0]?.modeId;
            onChange({ ...action, targetVariableSetID: variableRef(id), ...(m ? { targetVariableModeID: guidJson(m) } : {}) }, "Set variable mode");
          }}
        />
      </div>
      {c && (
        <div className={styles.row}>
          <Select
            label="Mode"
            className={styles.grow}
            value={mode ?? "NONE"}
            options={c.modes.map((m) => ({ value: m.modeId, label: m.name }))}
            onChange={(m) => onChange({ ...action, targetVariableModeID: guidJson(m) }, "Set variable mode")}
          />
        </div>
      )}
    </>
  );
}

/**
 * Conditional (help.figma.com 15253220891799): "In the If field, write a boolean expression" — typed, or built from
 * the suggested variables and operators, committed with Enter, outlined in red while invalid (model/expressions.ts) —
 * then its actions; "Complete the Else condition … Alternatively, leave the Else action blank." Branches with a
 * condition after the first (else-if blocks a file may hold) show as "Else if".
 */
function Conditional({ source, action, depth, onChange }: { source: Guid; action: PrototypeAction; depth: number; onChange: (a: PrototypeAction, label?: string, info?: ChangeInfo) => void }) {
  const ed = useEditor();
  const vars = useMemo(() => (ed.engine.destroyed ? [] : ed.engine.variables()), [ed]);
  const stored = action.conditionalActions?.length ? action.conditionalActions : [{ actions: [] }, { actions: [] }];
  // The Else block is always there (it may stay empty).
  const branches = stored[stored.length - 1].condition || stored.length === 1 ? [...stored, { actions: [] }] : stored;
  const setBranch = (b: number, next: { actions?: PrototypeAction[]; condition?: PrototypeAction["targetVariableData"] }) => {
    const list = [...branches];
    list[b] = next;
    onChange({ ...action, conditionalActions: list }, "Edit conditional");
  };
  return (
    <div className={styles.group}>
      {branches.map((b, k) => (
        <div key={k} className={styles.branch}>
          {k < branches.length - 1 ? (
            <div className={styles.labelled}>
              <span className={styles.label}>{k === 0 ? "If" : "Else if"}</span>
              <ExpressionField label="Condition" data={b.condition} vars={vars} onCommit={(data) => setBranch(k, { ...b, condition: data })} />
            </div>
          ) : (
            <div className={styles.groupTitle}>Else</div>
          )}
          {(b.actions ?? []).map((a, j) => (
            <ActionEditor
              key={j}
              source={source}
              action={a}
              depth={depth + 1}
              onChange={(next) => {
                const acts = [...(b.actions ?? [])];
                acts[j] = next;
                setBranch(k, { ...b, actions: acts });
              }}
              onRemove={() => setBranch(k, { ...b, actions: (b.actions ?? []).filter((_, i) => i !== j) })}
            />
          ))}
          <div className={styles.row}>
            <Button variant="ghost" icon="24.plus.small" onClick={() => setBranch(k, { ...b, actions: [...(b.actions ?? []), actionOfKind("NAVIGATE")] })}>
              Add action
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
