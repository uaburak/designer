/**
 * Interaction details (UI3, R8 §2–§4, §8): the trigger (and its delay or key), then each action — what it does, its
 * destination (a frame, a variant for Change to, a layer for Scroll to), a link, a variable — with its animation
 * (Instant, Dissolve, Smart animate, Move in / out, Push, Slide in / out; the direction; Animate matching layers;
 * easing and duration, a custom bezier's or spring's graph — the Easing editor's, round 8j — and numbers), State
 * management, and for overlays the destination frame's own overlay settings (Position, Close when clicking outside,
 * Add background behind overlay). "Add action" appends one; a Conditional holds If / Else actions of its own.
 * Videos (help.figma.com 8878274530455): on a video
 * the triggers add "When video hits" (a time) and "When video ends"; in a frame with videos the actions add
 * "Play/pause video", "Mute/unmute video", "Set to specific time" and "Jump forward/backward in time" (their video and
 * choice), and a Navigate to a frame with a video has "Reset video state". Scroll to has its X / Y offset.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Checkbox, ColorInput, Icon, IconButton, NumericInput, Popover, SegmentedControl, Select, TextInput, type ChangeInfo } from "@/ds";
import type { Guid, NodeChange } from "@/engine/codec";
import { useCurrentPage } from "@/engine/hooks";
import { useEditor, type EditorController } from "../../controller";
import { useNodes } from "../../hooks";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { CurveEditor } from "../../motion/easing/CurveEditor";
import {
  ACTION_ICON,
  ANIMATIONS,
  DIRECTIONS,
  animationsFor,
  disabledTriggers,
  springEditorDuration,
  springOf,
  springSettleTime,
  springWithEditorDuration,
  EASINGS,
  OVERLAY_POSITIONS,
  MEDIA_CHOICES,
  TRIGGER_ICON,
  actionKind,
  actionMenu,
  formatMediaTime,
  isVideoAction,
  parseMediaTime,
  prototypeCurve,
  actionOfKind,
  animates,
  animationOf,
  easingFunctionFor,
  easingFunctionOfCurve,
  guidJson,
  guidOf,
  isDirectional,
  isSpring,
  keyTriggerLabel,
  keyTriggerOf,
  liveInteractions,
  mouseDelayOf,
  takesDelay,
  takesDestination,
  transitionOf,
  triggerMenu,
  withMouseDelay,
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
import { t, useT } from "@/i18n";

/** Menu options with their labels in the UI language. */
const translated = <T extends { label: string }>(options: readonly (T | "-")[]): (T | "-")[] => options.map((o) => (o === "-" ? o : { ...o, label: t(o.label) }));

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
  gap,
}: {
  node: Guid;
  index: number;
  anchor: DOMRect | HTMLElement | null;
  onClose: () => void;
  /** `bottom`: under a connection's label on the canvas (live 62–63.png); else beside the panel. */
  placement?: "bottom";
  /** `bottom`: how far under the anchor (live: 30 under a pressed point on the line, 11 under a label chip). */
  gap?: number;
}) {
  useT();
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
  // Round 17 (live 62–63.png): titled "Interaction", "+" (Add action) beside the close button. Live 2026-10-10 (the
  // owner's 85.png; draggable_modal / prototype_interaction_edit_modal measured): 242 wide, the title 24 in; labelled
  // rows (label 16 in, the field at 89, 137 wide, rows 32) in groups 8 + a line + 8 apart — Trigger | Action and its
  // destination | Animation | "State" (collapsed); opened from the canvas, a notch on top pointing at the press.
  return (
    <Popover
      anchor={anchor}
      placement={placement}
      arrow={placement === "bottom"}
      gap={gap}
      title={t("Interaction")}
      titleInset={24}
      onClose={onClose}
      width={242}
      headerActions={
        <IconButton icon="24.plus.small" label={t("Add action")} tooltip={false} onClick={() => write({ ...interaction, actions: [...actions, actionOfKind("NONE")] }, "Add action")} />
      }
    >
      <div className={styles.details} data-interaction-details>
        <TriggerRow interaction={interaction} others={list} video={hasVideoFill(n as never)} onChange={write} />
        {actions.map((a, k) => (
          <ActionEditor
            key={k}
            source={node}
            action={a}
            trigger={interaction.event?.interactionType}
            depth={0}
            onChange={(next, label, info) => setAction(k, next, label, info)}
            onRemove={actions.length > 1 ? () => write({ ...interaction, actions: actions.filter((_, j) => j !== k) }, "Remove action") : undefined}
          />
        ))}
        {actions.length === 0 && (
          <>
            <div className={styles.divider} />
            <Labelled label={t("Action")}>
              <Select
                label={t("Action")}
                variant="outlined"
                className={styles.iconField}
                prefix={ACTION_ICON.NONE}
                value="NONE"
                options={translated(actionMenu({ changeTo: variantsFor(ed, node).length > 0, conditional: true, video: false }))}
                onChange={(v) => write({ ...interaction, actions: [actionOfKind(v as ActionKind)] }, "Edit action")}
              />
            </Labelled>
          </>
        )}
      </div>
    </Popover>
  );
}

function TriggerRow({
  interaction,
  others,
  video,
  onChange,
}: {
  interaction: PrototypeInteraction;
  /** The layer's interactions (a trigger another one uses is disabled, atlas 13 §3.2) */
  others: readonly PrototypeInteraction[];
  video: boolean;
  onChange: (i: PrototypeInteraction, label?: string, info?: ChangeInfo) => void;
}) {
  useT();
  const type = interaction.event?.interactionType ?? "ON_CLICK";
  const recorder = useRef<HTMLButtonElement>(null);
  const videoTrigger = type === "ON_MEDIA_HIT" || type === "ON_MEDIA_END";
  return (
    <>
      <Labelled label={t("Trigger")}>
        <Select
          label={t("Trigger")}
          variant="outlined"
          className={styles.iconField}
          prefix={TRIGGER_ICON[type]}
          value={type === "MOUSE_IN" ? "MOUSE_ENTER" : type === "MOUSE_OUT" ? "MOUSE_LEAVE" : type}
          options={translated(triggerMenu(video || videoTrigger, disabledTriggers(interaction, others)))}
          onChange={(v) => onChange(withTrigger(interaction, v as InteractionType), "Edit trigger")}
        />
      </Labelled>
      {type === "ON_MEDIA_HIT" && (
        <Labelled label={t("Time")}>
          <TextInput
            label={t("Time")}
            variant="outlined"
            value={formatMediaTime(interaction.event?.mediaHitTime)}
            onCommit={(text) => {
              const s = parseMediaTime(text);
              if (s !== null) onChange({ ...interaction, event: { ...interaction.event, mediaHitTime: s } }, "Edit trigger");
            }}
          />
        </Labelled>
      )}
      {type === "AFTER_TIMEOUT" && (
        <Labelled label={t("Delay")}>
          <NumericInput
            label={t("Delay")}
            value={Math.round((interaction.event?.transitionTimeout || 0.8) * 1000)}
            unit="ms"
            min={1}
            max={20000}
            precision={0}
            onChange={(v, info) => onChange({ ...interaction, event: { ...interaction.event, transitionTimeout: v / 1000 } }, "Edit delay", info)}
          />
        </Labelled>
      )}
      {takesDelay(type) && (
        <Labelled label={t("Delay")}>
          <NumericInput
            label={t("Delay")}
            value={Math.round(mouseDelayOf(interaction.event) * 1000)}
            unit="ms"
            min={0}
            max={10000}
            precision={0}
            onChange={(v, info) => onChange({ ...interaction, event: withMouseDelay({ ...interaction.event }, v / 1000) }, "Edit delay", info)}
          />
        </Labelled>
      )}
      {type === "ON_KEY_DOWN" && (
        <Labelled label={t("Key")}>
          <button
            ref={recorder}
            type="button"
            className={styles.keyRecorder}
            aria-label={t("Key")}
            onKeyDown={(e) => {
              if (e.key === "Tab") return;
              e.preventDefault();
              e.stopPropagation();
              if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
              onChange({ ...interaction, event: { ...interaction.event, keyTrigger: { keyCodes: keyTriggerOf(e.nativeEvent), triggerDevice: "KEYBOARD" } } }, "Edit key");
            }}
          >
            {keyTriggerLabel(interaction.event?.keyTrigger?.keyCodes) || t("Type a key")}
          </button>
        </Labelled>
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
  trigger,
  depth,
  onChange,
  onRemove,
}: {
  source: Guid;
  action: PrototypeAction;
  /** The interaction's trigger (which animations and overlay settings apply) */
  trigger: InteractionType | undefined;
  depth: number;
  onChange: (a: PrototypeAction, label?: string, info?: ChangeInfo) => void;
  onRemove?: () => void;
}) {
  useT();
  const ed = useEditor();
  const kind = actionKind(action);
  const dests = useDestinations(source, kind);
  const dest = guidOf(action.transitionNodeID);
  // The video actions: "available for any interaction that ends on a video" — offered where the frame has one.
  const videos = useMemo(() => (ed.engine.destroyed ? [] : videoLayersOf(ed, source)), [ed, source]);
  // Live (83.png): Change to only for a variant (or a layer in one) — listed, disabled, elsewhere.
  const changeTo = kind === "CHANGE_TO" || (!ed.engine.destroyed && variantsFor(ed, source).length > 0);
  const actionOptions = actionMenu({ changeTo, conditional: depth === 0, video: videos.length > 0 || isVideoAction(kind) });
  const destHasVideo = kind === "NAVIGATE" && !!dest && frameHasVideo(ed, dest);
  return (
    <div className={styles.actionBlock} data-action={kind}>
      <div className={styles.divider} />
      <Labelled label={t("Action")} action={onRemove && <IconButton icon="24.minus.small" label={t("Remove action")} tone="secondary" onClick={onRemove} />}>
        <Select
          label={t("Action")}
          variant="outlined"
          className={styles.iconField}
          prefix={ACTION_ICON[kind]}
          value={kind}
          options={translated(actionOptions)}
          onChange={(v) => {
            if (v === "ANIMATION_PLAY" || v === "ANIMATION_PLAYHEAD") return;
            onChange(actionOfKind(v as ActionKind, action), "Edit action");
          }}
        />
      </Labelled>
      {takesDestination(kind) && (
        // Live: "Destination"; Change to's is "State" (the variant).
        <Labelled label={kind === "CHANGE_TO" ? t("State") : t("Destination")}>
          <Select
            label={t("Destination")}
            variant="outlined"
            className={styles.field}
            value={dest ?? "NONE"}
            options={[{ value: "NONE", label: t("None") }, ...(dests.length ? ["-" as const] : []), ...dests]}
            onChange={(v) => {
              const next = { ...action };
              if (v === "NONE") delete next.transitionNodeID;
              else next.transitionNodeID = guidJson(v);
              onChange(next, "Edit destination");
            }}
          />
        </Labelled>
      )}
      {isVideoAction(kind) && (
        <>
          <Labelled label={t("Video")}>
            <Select
              label={t("Video")}
              variant="outlined"
              className={styles.field}
              value={dest ?? "NONE"}
              options={[{ value: "NONE", label: t("Choose video") }, ...(dests.length ? ["-" as const] : []), ...dests]}
              onChange={(v) => {
                const next = { ...action };
                if (v === "NONE") delete next.transitionNodeID;
                else next.transitionNodeID = guidJson(v);
                onChange(next, "Edit destination");
              }}
            />
          </Labelled>
          {MEDIA_CHOICES[kind] && (
            <div className={styles.row}>
              <Select
                label={kind === "VIDEO_JUMP" ? t("Direction") : t("Video action")}
                variant="outlined"
                className={styles.grow}
                value={action.mediaAction ?? "PLAY"}
                options={translated(MEDIA_CHOICES[kind]!)}
                onChange={(v) => onChange({ ...action, mediaAction: v as MediaAction }, "Edit action")}
              />
              {kind === "VIDEO_JUMP" && (
                <NumericInput
                  label={t("Seconds")}
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
              <span className={styles.label}>{t("Time")}</span>
              <TextInput
                label={t("Time")}
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
        <div className={styles.offsets}>
          <span className={styles.fieldLabel}>{t("Offset")}</span>
          <NumericInput
            label={t("X offset")}
            prefix="X"
            className={styles.grow}
            value={action.extraScrollOffset?.x ?? 0}
            precision={0}
            onChange={(v, info) => onChange({ ...action, extraScrollOffset: { x: v, y: action.extraScrollOffset?.y ?? 0 } }, "Edit offset", info)}
          />
          <NumericInput
            label={t("Y offset")}
            prefix="Y"
            className={styles.grow}
            value={action.extraScrollOffset?.y ?? 0}
            precision={0}
            onChange={(v, info) => onChange({ ...action, extraScrollOffset: { x: action.extraScrollOffset?.x ?? 0, y: v } }, "Edit offset", info)}
          />
        </div>
      )}
      {(kind === "OVERLAY" || kind === "SWAP") && dest && <OverlaySettings frame={dest} trigger={trigger} />}
      {kind === "URL" && (
        <>
          <div className={styles.row}>
            <TextInput label={t("Link")} className={styles.grow} placeholder="https://" value={action.connectionURL ?? ""} onCommit={(url) => onChange({ ...action, connectionURL: url.trim() }, "Edit link")} />
          </div>
          <div className={styles.checkRow}>
            <Checkbox label={t("Open in new tab")} checked={action.openUrlInNewTab !== false} onChange={(c) => onChange({ ...action, openUrlInNewTab: c }, "Edit link")} />
          </div>
        </>
      )}
      {kind === "SET_VARIABLE" && <SetVariable action={action} onChange={onChange} />}
      {kind === "SET_VARIABLE_MODE" && <SetVariableMode action={action} onChange={onChange} />}
      {kind === "CONDITIONAL" && <Conditional source={source} action={action} trigger={trigger} depth={depth} onChange={onChange} />}
      {animates(kind) && <AnimationEditor action={action} kind={kind} trigger={trigger} onChange={onChange} />}
      {(kind === "NAVIGATE" || kind === "CHANGE_TO") && (
        // Live 2026-10-10: a collapsed "State" (chevron, then the title 16 in, 32 high) holding Reset scroll position
        // (Navigate to and Change to alike). Reset component state shows while it is on (live shows it no more); Reset
        // video state for a destination with a video.
        <StateSection>
          <div className={styles.checkRow}>
            <Checkbox label={t("Reset scroll position")} checked={!!action.transitionResetScrollPosition} onChange={(c) => onChange({ ...action, transitionResetScrollPosition: c }, "Edit interaction")} />
          </div>
          {action.transitionResetInteractiveComponents && (
            <div className={styles.checkRow}>
              <Checkbox label={t("Reset component state")} checked onChange={(c) => onChange({ ...action, transitionResetInteractiveComponents: c }, "Edit interaction")} />
            </div>
          )}
          {(destHasVideo || action.transitionResetVideoPosition) && (
            <div className={styles.checkRow}>
              <Checkbox label={t("Reset video state")} checked={!!action.transitionResetVideoPosition} onChange={(c) => onChange({ ...action, transitionResetVideoPosition: c }, "Edit interaction")} />
            </div>
          )}
        </StateSection>
      )}
    </div>
  );
}

/** A labelled row (live ui3LabelOneInput: the label 16 in, 65 wide at 70 %, the field 8 after it; 32 high). */
function Labelled({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={action ? styles.fieldRowAction : styles.fieldRow}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {action}
    </div>
  );
}

/** Interaction details' last group: "State", collapsed until its row is clicked (live: remembered while open). */
function StateSection({ children }: { children: ReactNode }) {
  useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={styles.divider} />
      <button type="button" className={styles.disclosure} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "16.chevron.down" : "16.chevron.right"} />
        <span>{t("State")}</span>
      </button>
      {open && children}
    </>
  );
}

// The spring editor's upper limits (Figma's): mass 100, stiffness 10000, damping 1000; each at least 0.01.
const SPRING_MAX = [100, 10000, 1000];

function AnimationEditor({
  action,
  kind,
  trigger,
  onChange,
}: {
  action: PrototypeAction;
  kind: ActionKind;
  trigger: InteractionType | undefined;
  onChange: (a: PrototypeAction, label?: string, info?: ChangeInfo) => void;
}) {
  useT();
  const { animation, direction } = animationOf(action.transitionType);
  const easing = action.easingType ?? "OUT_CUBIC";
  const spring = isSpring(easing);
  // Each action's animations (atlas 13 §5.1); Scroll to only animates or not.
  const options = kind === "SCROLL_TO" ? ANIMATIONS.filter((a) => a.value === "INSTANT" || a.value === "SMART_ANIMATE") : animationsFor(kind, trigger);
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
    // A spring's stored duration is its settle time (atlas 13 §5.4).
    onChange({ ...action, easingFunction: next, ...(spring ? { transitionDuration: springSettleTime(next) } : {}) }, "Edit easing", info);
  };
  const springFn = springOf(easing, action.easingFunction);
  const curve = prototypeCurve(easing, fn);
  return (
    <>
      <div className={styles.divider} />
      <Labelled label={t("Animation")}>
        <Select label={t("Animation")} variant="outlined" className={styles.field} value={shown} options={translated(options.map(label))} onChange={(v) => setAnimation(v as Animation)} />
      </Labelled>
      {isDirectional(animation) && (
        <>
          <div className={styles.row}>
            <SegmentedControl
              label={t("Direction")}
              fullWidth
              value={direction}
              options={DIRECTIONS.map((d) => ({ value: d.value, icon: DIRECTION_ICON[d.value], tooltip: t(d.label) }))}
              onChange={(v) => setAnimation(animation, v as Direction)}
            />
          </div>
          {kind === "NAVIGATE" && (
            // Navigate to only (atlas 13 §5.1).
            <div className={styles.checkRow}>
              <Checkbox label={t("Animate matching layers")} checked={!!action.transitionShouldSmartAnimate} onChange={(c) => onChange({ ...action, transitionShouldSmartAnimate: c }, "Edit animation")} />
            </div>
          )}
        </>
      )}
      {shown !== "INSTANT" && (
        <>
          <div className={styles.row}>
            <Select
              label={t("Curve")}
              variant="outlined"
              className={styles.grow}
              value={easing === "SPRING" ? "GENTLE_SPRING" : easing === "EASE_IN" ? "IN_CUBIC" : easing}
              options={translated(EASINGS)}
              onChange={(v) => {
                const e = v as EasingType;
                const next: PrototypeAction = { ...action, easingType: e };
                const f = easingFunctionFor(e);
                if (f) next.easingFunction = f;
                else delete next.easingFunction;
                // Figma resets the duration when the curve changes kind: 0.3 s for a bezier, a spring's settle time.
                if (isSpring(e)) next.transitionDuration = springSettleTime(springOf(e, f));
                else if (spring) next.transitionDuration = 0.3;
                onChange(next, "Edit easing");
              }}
            />
            {spring ? (
              // A spring's Duration is its editor duration 6 / (ζω₀); typing one rescales it (a custom spring) and stores
              // the new settle time.
              <NumericInput
                label={t("Duration")}
                className={styles.duration}
                value={Math.round(springEditorDuration(springFn) * 1000)}
                unit="ms"
                min={1}
                max={10000}
                precision={0}
                onChange={(v, info) => {
                  const f = springWithEditorDuration(springFn, v / 1000);
                  onChange({ ...action, easingType: "CUSTOM_SPRING", easingFunction: [...f, 0], transitionDuration: springSettleTime(f) }, "Edit duration", info);
                }}
              />
            ) : (
              <NumericInput
                label={t("Duration")}
                className={styles.duration}
                value={Math.round((action.transitionDuration || 0.3) * 1000)}
                unit="ms"
                min={1}
                max={10000}
                precision={0}
                onChange={(v, info) => onChange({ ...action, transitionDuration: v / 1000 }, "Edit duration", info)}
              />
            )}
          </div>
          {curve && (
            // The Easing editor's graph (round 8j, shared with Motion): a custom bezier's handles, a custom spring's
            // bounce; the numbers below follow it.
            <div className={styles.curve} data-prototype-curve={easing}>
              <CurveEditor easing={curve} editable onChange={(e, commit) => {
                const next = easingFunctionOfCurve(e, fn);
                onChange({ ...action, easingFunction: next, ...(spring ? { transitionDuration: springSettleTime(next) } : {}) }, "Edit easing", { final: commit, source: "drag" });
              }} />
            </div>
          )}
          {easing === "CUSTOM_CUBIC" && (
            <div className={styles.quad}>
              {["X1", "Y1", "X2", "Y2"].map((p, i) => (
                <NumericInput key={p} label={p} prefix={p} value={fn[i] ?? 0} {...(i % 2 === 0 ? { min: 0, max: 1 } : {})} step={0.01} precision={2} onChange={(v, info) => setFn(i, v, info)} />
              ))}
            </div>
          )}
          {easing === "CUSTOM_SPRING" && (
            <div className={styles.quad}>
              {["Mass", "Stiffness", "Damping"].map((p, i) => (
                <NumericInput key={p} label={t(p)} prefix={p[0]} value={fn[i] ?? [1, 100, 15][i]} min={0.01} max={SPRING_MAX[i]} step={i === 0 ? 0.1 : 1} precision={i === 0 ? 2 : 0} onChange={(v, info) => setFn(i, v, info)} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Open / Swap overlay: the destination frame's own overlay settings (shared by every interaction that opens it). */
function OverlaySettings({ frame, trigger }: { frame: Guid; trigger: InteractionType | undefined }) {
  useT();
  const ed = useEditor();
  const [n] = useNodes([frame]) as (ProtoNode | null)[];
  if (!n) return null;
  const bg = n.overlayBackgroundAppearance;
  const on = bg?.backgroundType === "SOLID_COLOR";
  const color = bg?.backgroundColor ?? { r: 0, g: 0, b: 0, a: 0.25 };
  return (
    <div className={styles.group}>
      <div className={styles.groupTitle}>{t("Overlay")}</div>
      <div className={styles.labelled}>
        <span className={styles.label}>{t("Position")}</span>
        <Select
          label={t("Overlay position")}
          className={styles.grow}
          value={n.overlayPositionType ?? "CENTER"}
          options={translated(OVERLAY_POSITIONS)}
          onChange={(v) => ed.setProps([frame], protoFields({ overlayPositionType: v as OverlayPositionType }), "Overlay position")}
        />
      </div>
      {trigger !== "ON_HOVER" && trigger !== "ON_PRESS" && (
      // Not for While hovering / While pressing: the overlay goes with the pointer (atlas 13 §6.1).
      <div className={styles.checkRow}>
        <Checkbox
          label={t("Close when clicking outside")}
          checked={n.overlayBackgroundInteraction === "CLOSE_ON_CLICK_OUTSIDE"}
          onChange={(c) => ed.setProps([frame], protoFields({ overlayBackgroundInteraction: c ? "CLOSE_ON_CLICK_OUTSIDE" : null }), "Overlay settings")}
        />
      </div>
      )}
      <div className={styles.checkRow}>
        <Checkbox
          label={t("Add background behind overlay")}
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
            label={t("Overlay background")}
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
  useT();
  const ed = useEditor();
  const vars = useMemo(() => (ed.engine.destroyed ? [] : ed.engine.variables()), [ed]);
  const current = guidOf(action.targetVariable?.id?.guid ?? null);
  const v = vars.find((x) => x.id === current);
  const value = action.targetVariableData?.value ?? {};
  return (
    <>
      <div className={styles.row}>
        <Select
          label={t("Variable")}
          className={styles.grow}
          value={current ?? "NONE"}
          options={[{ value: "NONE", label: t("Choose variable") }, ...(vars.length ? ["-" as const] : []), ...vars.map((x) => ({ value: x.id, label: x.name, hint: t(x.resolvedType.toLowerCase()) }))]}
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
            label={t("Value")}
            fullWidth
            value={value.boolValue ? "true" : "false"}
            options={[
              { value: "true", label: t("True") },
              { value: "false", label: t("False") },
            ]}
            onChange={(b) => onChange({ ...action, targetVariableData: { value: { boolValue: b === "true" }, dataType: "BOOLEAN" } }, "Set variable")}
          />
        </div>
      )}
      {v && v.resolvedType === "FLOAT" && (
        <div className={styles.row}>
          <NumericInput label={t("Value")} className={styles.grow} value={value.floatValue ?? 0} onChange={(f, info) => onChange({ ...action, targetVariableData: { value: { floatValue: f }, dataType: "FLOAT" } }, "Set variable", info)} />
        </div>
      )}
      {v && v.resolvedType === "STRING" && (
        <div className={styles.row}>
          <TextInput label={t("Value")} className={styles.grow} value={value.textValue ?? ""} onCommit={(text) => onChange({ ...action, targetVariableData: { value: { textValue: text }, dataType: "STRING" } }, "Set variable")} />
        </div>
      )}
      {v && v.resolvedType === "COLOR" && (
        <div className={styles.row}>
          <ColorInput
            label={t("Value")}
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
  useT();
  const ed = useEditor();
  const collections = useMemo(() => (ed.engine.destroyed ? [] : ed.engine.variableCollections()), [ed]);
  const current = guidOf(action.targetVariableSetID?.guid ?? null);
  const c = collections.find((x) => x.id === current);
  const mode = guidOf(action.targetVariableModeID ?? null);
  return (
    <>
      <div className={styles.row}>
        <Select
          label={t("Collection")}
          className={styles.grow}
          value={current ?? "NONE"}
          options={[{ value: "NONE", label: t("Choose collection") }, ...(collections.length ? ["-" as const] : []), ...collections.map((x) => ({ value: x.id, label: x.name }))]}
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
            label={t("Mode")}
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
function Conditional({
  source,
  action,
  trigger,
  depth,
  onChange,
}: {
  source: Guid;
  action: PrototypeAction;
  trigger: InteractionType | undefined;
  depth: number;
  onChange: (a: PrototypeAction, label?: string, info?: ChangeInfo) => void;
}) {
  useT();
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
              <span className={styles.label}>{k === 0 ? t("If") : t("Else if")}</span>
              <ExpressionField label={t("Condition")} data={b.condition} vars={vars} onCommit={(data) => setBranch(k, { ...b, condition: data })} />
            </div>
          ) : (
            <div className={styles.groupTitle}>{t("Else")}</div>
          )}
          {(b.actions ?? []).map((a, j) => (
            <ActionEditor
              key={j}
              source={source}
              action={a}
              trigger={trigger}
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
              {t("Add action")}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
