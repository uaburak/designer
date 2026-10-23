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
import { Checkbox, ColorInput, Icon, IconButton, MenuButton, NumericInput, Popover, SegmentedControl, Select, TextInput, cx, type ChangeInfo, type IconName, type MenuEntry } from "@/ds";
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
  OVERLAY_FITS,
  MEDIA_CHOICES,
  TRIGGER_ICON,
  actionKind,
  actionLabel,
  actionMenu,
  addActionMenu,
  conditionalBranches,
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
  type OverlayFitWindow,
  type PrototypeAction,
  type PrototypeInteraction,
} from "../../model/prototype";
import { ancestorsOf, protoFields, usePageFrames, type ProtoNode } from "./PrototypePanel";
import { ExpressionPieces, useExpressionVariables } from "./ExpressionField";
import { expressionSegments, formatExpression } from "../../model/expressions";
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
  // An action added from the one-action dialog is the one the expanded dialog opens on
  const [added, setAdded] = useState(false);
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
  // More than one action, or a Conditional: Figma's expanded dialog (live 2026-10-23) — the actions listed on the left
  // (a Conditional's If / Else with theirs), the chosen one's details on the right.
  if (actions.length > 1 || actions.some((a) => actionKind(a) === "CONDITIONAL"))
    return (
      <ExpandedInteraction
        key={`${node}:${index}`}
        node={n}
        interaction={interaction}
        others={list}
        write={write}
        initial={added ? actions.length - 1 : 0}
        anchor={anchor}
        placement={placement}
        gap={gap}
        onClose={onClose}
      />
    );
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
        <MenuButton
          label={t("Add action")}
          entries={asMenu(translated(addActionMenu({ changeTo: variantsFor(ed, node).length > 0, conditional: true, video: false })))}
          className={styles.iconMenu}
          onSelect={(v) => {
            if (v === "ANIMATION_PLAY" || v === "ANIMATION_PLAYHEAD") return;
            setAdded(true);
            write({ ...interaction, actions: actions.length ? [...actions, actionOfKind(v as ActionKind)] : [actionOfKind(v as ActionKind)] }, "Add action");
          }}
        >
          <Icon name="24.plus.small" />
        </MenuButton>
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

/** Select options as a menu's entries (the add menus). */
function asMenu(options: readonly ("-" | { value: string; label: string; icon?: IconName; disabled?: boolean })[]): MenuEntry[] {
  return options.map((o) => (o === "-" ? "-" : { id: o.value, label: o.label, icon: o.icon, disabled: o.disabled }));
}

/** Where an action sits: a top-level one, or one of a Conditional's (its block, its index there). */
type ActionPath = { top: number; branch?: number; index?: number };
const samePath = (a: ActionPath, b: ActionPath) => a.top === b.top && a.branch === b.branch && a.index === b.index;

/**
 * Figma's expanded Interaction dialog (measured live 2026-10-23: prototype_interaction_edit_modal, 440 × 320): on the
 * left (198) the trigger across (8 in, 182 wide) over a line, then the actions as 24-high rows 8 apart — the action's
 * glyph from 4, its name at 28 and its destination 4 after it; a Conditional as a block (lit in the selected-secondary
 * colour while it is chosen, its "if" row in the selected colour, rounded on top): "if" and its condition (pills,
 * operators and values secondary), its actions 24 in under a corner, "else", "Add action" (16 high) for a block
 * without actions — then a line and "+" (the add menu) and "−" (Delete). On the right (241) the chosen action's
 * details, as the one-action dialog shows them.
 */
function ExpandedInteraction({
  node,
  interaction,
  others,
  write,
  initial,
  anchor,
  placement,
  gap,
  onClose,
}: {
  node: ProtoNode;
  interaction: PrototypeInteraction;
  others: readonly PrototypeInteraction[];
  write: (next: PrototypeInteraction, label?: string, info?: ChangeInfo) => void;
  /** The top-level action chosen first. */
  initial: number;
  anchor: DOMRect | HTMLElement | null;
  placement?: "bottom";
  gap?: number;
  onClose: () => void;
}) {
  useT();
  const ed = useEditor();
  const source = node.guid;
  const actions = interaction.actions ?? [];
  const [chosen, setChosen] = useState<ActionPath>({ top: initial });
  const changeTo = !ed.engine.destroyed && variantsFor(ed, source).length > 0;
  const videos = useMemo(() => (ed.engine.destroyed ? [] : videoLayersOf(ed, source)), [ed, source]);
  const vars = useMemo(() => (ed.engine.destroyed ? [] : ed.engine.variables()), [ed]);
  const exprVars = useExpressionVariables(vars);
  const at = (p: ActionPath): PrototypeAction | undefined =>
    p.branch === undefined ? actions[p.top] : conditionalBranches(actions[p.top] ?? {})[p.branch]?.actions?.[p.index ?? 0];
  const sel = at(chosen) ? chosen : { top: Math.min(chosen.top, Math.max(actions.length - 1, 0)) };
  const setActions = (next: PrototypeAction[], label: string, info?: ChangeInfo) => write({ ...interaction, actions: next }, label, info);
  const setBranch = (top: number, b: number, acts: PrototypeAction[], label: string) => {
    const branches = [...conditionalBranches(actions[top])];
    branches[b] = { ...branches[b], actions: acts };
    const next = [...actions];
    next[top] = { ...actions[top], conditionalActions: branches };
    setActions(next, label);
  };
  const setAt = (p: ActionPath, a: PrototypeAction, label = "Edit action", info?: ChangeInfo) => {
    if (p.branch === undefined) {
      const next = [...actions];
      next[p.top] = a;
      return setActions(next, label, info);
    }
    const acts = [...(conditionalBranches(actions[p.top])[p.branch].actions ?? [])];
    acts[p.index ?? 0] = a;
    setBranch(p.top, p.branch, acts, label);
  };
  const add = (kind: ActionKind) => {
    if (kind === ("ANIMATION_PLAY" as ActionKind) || kind === ("ANIMATION_PLAYHEAD" as ActionKind)) return;
    const a = actionOfKind(kind);
    if (sel.branch !== undefined) {
      // Inside a Conditional's block: after the chosen action there
      const acts = [...(conditionalBranches(actions[sel.top])[sel.branch].actions ?? [])];
      acts.splice((sel.index ?? 0) + 1, 0, a);
      setBranch(sel.top, sel.branch, acts, "Add action");
      setChosen({ top: sel.top, branch: sel.branch, index: (sel.index ?? 0) + 1 });
      return;
    }
    const next = [...actions];
    next.splice(sel.top + 1, 0, a);
    setActions(next, "Add action");
    setChosen({ top: sel.top + 1 });
  };
  const remove = () => {
    if (sel.branch !== undefined) {
      const acts = (conditionalBranches(actions[sel.top])[sel.branch].actions ?? []).filter((_, j) => j !== sel.index);
      setBranch(sel.top, sel.branch, acts, "Remove action");
      setChosen(acts.length ? { ...sel, index: Math.max(0, (sel.index ?? 0) - 1) } : { top: sel.top });
      return;
    }
    setActions(actions.filter((_, k) => k !== sel.top), "Remove action");
    setChosen({ top: Math.max(0, sel.top - 1) });
  };
  const menu = (conditional: boolean) => asMenu(translated(addActionMenu({ changeTo, conditional, video: videos.length > 0 })));
  const destName = (a: PrototypeAction) => {
    const kind = actionKind(a);
    if (kind === "SET_VARIABLE" || kind === "SET_VARIABLE_MODE") return null;
    const d = guidOf(a.transitionNodeID);
    return d ? ((ed.engine.readNode(d) as { name?: string } | null)?.name ?? null) : null;
  };
  const row = (a: PrototypeAction, p: ActionPath, nested: boolean) => {
    const kind = actionKind(a);
    const dest = destName(a);
    return (
      <button
        key={`${p.top}:${p.branch ?? ""}:${p.index ?? ""}`}
        type="button"
        className={cx(styles.listRow, nested && styles.listRowNested, samePath(sel, p) && styles.listRowOn)}
        data-action-row={kind}
        onClick={() => setChosen(p)}
      >
        {nested && <span className={styles.listCorner} aria-hidden />}
        <Icon name={ACTION_ICON[kind]} />
        <span className={styles.listName}>{t(actionLabel(kind))}</span>
        {dest && <span className={styles.listDest}>{dest}</span>}
      </button>
    );
  };
  const addRow = (top: number, b: number) => (
    <div className={styles.listAdd} key={`add:${top}:${b}`}>
      <span className={styles.listCorner} aria-hidden />
      <MenuButton
        label={t("Add action")}
        tooltip={t("Add nested action")}
        entries={menu(false)}
        className={styles.listAddButton}
        onSelect={(v) => {
          if (v === "ANIMATION_PLAY" || v === "ANIMATION_PLAYHEAD") return;
          setBranch(top, b, [actionOfKind(v as ActionKind)], "Add action");
          setChosen({ top, branch: b, index: 0 });
        }}
      >
        {t("Add action")}
      </MenuButton>
    </div>
  );
  const block = (a: PrototypeAction, k: number) => {
    const branches = conditionalBranches(a);
    const on = sel.top === k && sel.branch === undefined;
    return (
      <div key={k} className={cx(styles.listBlock, on && styles.listBlockOn)} data-conditional="">
        {branches.map((b, j) => {
          const last = j === branches.length - 1;
          const text = formatExpression(b.condition, (id) => exprVars.find((v) => v.id === id)?.name ?? null);
          return (
            <div key={j} className={styles.listBranch}>
              <button type="button" className={cx(styles.listRow, on && j === 0 && styles.listRowHead)} onClick={() => setChosen({ top: k })} data-branch={last ? "else" : "if"}>
                {j === 0 && <Icon name={ACTION_ICON.CONDITIONAL} />}
                <span className={j === 0 ? styles.listName : styles.listElse}>{j === 0 ? "if" : last ? "else" : "else if"}</span>
                {!last && text && (
                  <span className={styles.listCondition}>
                    <ExpressionPieces segments={expressionSegments(text, exprVars)} vars={exprVars} compact />
                  </span>
                )}
              </button>
              {(b.actions ?? []).map((x, i) => row(x, { top: k, branch: j, index: i }, true))}
              {!(b.actions ?? []).length && addRow(k, j)}
            </div>
          );
        })}
      </div>
    );
  };
  const current = at(sel);
  return (
    <Popover anchor={anchor} placement={placement} arrow={placement === "bottom"} gap={gap} title={t("Interaction")} titleInset={24} onClose={onClose} width={440}>
      <div className={styles.expanded} data-interaction-details="" data-expanded="">
        <div className={styles.expandedList}>
          <div className={styles.expandedTrigger}>
            <TriggerRow interaction={interaction} others={others} video={hasVideoFill(node as never)} onChange={write} compact />
          </div>
          <div className={styles.listRows}>{actions.map((a, k) => (actionKind(a) === "CONDITIONAL" ? block(a, k) : row(a, { top: k }, false)))}</div>
          <div className={styles.listBar}>
            <MenuButton label={t("Add action")} entries={menu(sel.branch === undefined)} className={styles.iconMenu} onSelect={(v) => add(v as ActionKind)}>
              <Icon name="24.plus.small" />
            </MenuButton>
            <IconButton icon="24.minus.small" label={t("Delete")} tone="secondary" disabled={!current} onClick={remove} />
          </div>
        </div>
        <div className={styles.expandedDetail}>
          {current && (
            <ActionEditor
              key={`${sel.top}:${sel.branch ?? ""}:${sel.index ?? ""}`}
              source={source}
              action={current}
              trigger={interaction.event?.interactionType}
              depth={sel.branch === undefined ? 0 : 1}
              panel
              onChange={(next, label, info) => setAt(sel, next, label, info)}
            />
          )}
        </div>
      </div>
    </Popover>
  );
}

function TriggerRow({
  interaction,
  others,
  video,
  onChange,
  compact,
}: {
  interaction: PrototypeInteraction;
  /** The layer's interactions (a trigger another one uses is disabled, atlas 13 §3.2) */
  others: readonly PrototypeInteraction[];
  video: boolean;
  onChange: (i: PrototypeInteraction, label?: string, info?: ChangeInfo) => void;
  /** The expanded dialog's: the trigger alone across the list (no label) */
  compact?: boolean;
}) {
  useT();
  const type = interaction.event?.interactionType ?? "ON_CLICK";
  const recorder = useRef<HTMLButtonElement>(null);
  if (compact)
    return (
      <Select
        label={t("Trigger")}
        variant="outlined"
        className={cx(styles.iconField, styles.grow)}
        prefix={TRIGGER_ICON[type]}
        value={type === "MOUSE_IN" ? "MOUSE_ENTER" : type === "MOUSE_OUT" ? "MOUSE_LEAVE" : type}
        options={translated(triggerMenu(video || type === "ON_MEDIA_HIT" || type === "ON_MEDIA_END", disabledTriggers(interaction, others)))}
        onChange={(v) => onChange(withTrigger(interaction, v as InteractionType), "Edit trigger")}
      />
    );
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
  panel,
}: {
  source: Guid;
  action: PrototypeAction;
  /** The interaction's trigger (which animations and overlay settings apply) */
  trigger: InteractionType | undefined;
  depth: number;
  onChange: (a: PrototypeAction, label?: string, info?: ChangeInfo) => void;
  onRemove?: () => void;
  /** The expanded dialog's right column: no line above, a Conditional's condition only (its branches are listed) */
  panel?: boolean;
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
      {!panel && <div className={styles.divider} />}
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
      {kind === "CONDITIONAL" && <ConditionRow action={action} onChange={onChange} />}
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
          {/* Live 2026-10-19 (prototype.txt): "Easing" — the curve's glyph, then its name — and "Duration" — a filled
              field with a stopwatch, "300ms" — each a labelled row of its own */}
          <Labelled label={t("Easing")}>
            <Select
              label={t("Easing")}
              variant="outlined"
              className={styles.field}
              prefix="24.proto.easing"
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
          </Labelled>
          <Labelled label={t("Duration")}>
            {spring ? (
              // A spring's Duration is its editor duration 6 / (ζω₀); typing one rescales it — a preset keeps its type,
              // the rescaled spring in easingFunction (Figma's: the owner's Slow at 200 ms is [1, 720, 60, 0]) — and
              // stores the new settle time, which the player plays.
              <NumericInput
                label={t("Duration")}
                className={styles.field}
                prefix="24.proto.duration"
                value={Math.round(springEditorDuration(springFn) * 1000)}
                unit="ms"
                min={1}
                max={10000}
                precision={0}
                onChange={(v, info) => {
                  const f = springWithEditorDuration(springFn, v / 1000);
                  onChange({ ...action, easingType: easing === "SPRING" ? "GENTLE_SPRING" : easing, easingFunction: [...f, 0], transitionDuration: springSettleTime(f) }, "Edit duration", info);
                }}
              />
            ) : (
              <NumericInput
                label={t("Duration")}
                className={styles.field}
                prefix="24.proto.duration"
                value={Math.round((action.transitionDuration || 0.3) * 1000)}
                unit="ms"
                min={1}
                max={10000}
                precision={0}
                onChange={(v, info) => onChange({ ...action, transitionDuration: v / 1000 }, "Edit duration", info)}
              />
            )}
          </Labelled>
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
          <TransitionPreview animation={shown} curve={spring ? null : fn} duration={action.transitionDuration || 0.3} />
        </>
      )}
    </>
  );
}

/**
 * The animation's preview (live 2026-10-19, prototype.txt): a 212 × 96 tile (#383838, radius 5) under Duration, a
 * 54 × 60 outlined phone holding three 42-wide bars that play the transition — its kind, curve and duration — again
 * and again.
 */
function TransitionPreview({ animation, curve, duration }: { animation: Animation; curve: readonly number[] | null; duration: number }) {
  const timing = curve && curve.length === 4 ? `cubic-bezier(${curve.join(", ")})` : "ease-out";
  return (
    <div className={styles.previewTile} aria-hidden data-transition-preview={animation}>
      <div className={styles.previewPhone} data-kind={animation} style={{ ["--preview-duration" as string]: `${duration}s`, ["--preview-timing" as string]: timing }}>
        <span className={styles.previewBar} />
        <span className={styles.previewBar} />
        <span className={styles.previewBar} />
      </div>
    </div>
  );
}

/** The preset positions a toast stack grows from (top ones downwards, bottom ones upwards). */
const STACK_POSITIONS: ReadonlySet<OverlayPositionType> = new Set(["TOP_LEFT", "TOP_CENTER", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER", "BOTTOM_RIGHT"]);

/** Open / Swap overlay: the destination frame's own overlay settings (shared by every interaction that opens it). */
function OverlaySettings({ frame, trigger }: { frame: Guid; trigger: InteractionType | undefined }) {
  useT();
  const ed = useEditor();
  const [n] = useNodes([frame]) as (ProtoNode | null)[];
  if (!n) return null;
  const bg = n.overlayBackgroundAppearance;
  const on = bg?.backgroundType === "SOLID_COLOR";
  const color = bg?.backgroundColor ?? { r: 0, g: 0, b: 0, a: 0.25 };
  const position = n.overlayPositionType ?? "CENTER";
  const stack = n.overlayStack;
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
      {/* Wecra-only (not Figma's): the overlay takes the window's height / width while presented — a drawer taller
          than the window fits it. Stored in an @ours field the .fig export never writes. */}
      <div className={styles.labelled}>
        <span className={styles.label}>{t("Fit to window")}</span>
        <Select
          label={t("Overlay fit to window")}
          className={styles.grow}
          value={n.overlayFitWindow ?? "NONE"}
          options={translated(OVERLAY_FITS)}
          onChange={(v) => ed.setProps([frame], protoFields({ overlayFitWindow: v === "NONE" ? null : (v as OverlayFitWindow) }), "Overlay settings")}
        />
      </div>
      {/* Wecra-only, with the presentation's Website behaviours: a Manual overlay goes with its hotspot as the page
          scrolls, opens on its other side at the window's edge and stays inside it (on unless turned off here). */}
      {position === "MANUAL" && (
        <div className={styles.checkRow}>
          <Checkbox
            label={t("Keep in window")}
            checked={n.overlayEdgeBehavior !== "NONE"}
            onChange={(c) => ed.setProps([frame], protoFields({ overlayEdgeBehavior: c ? null : "NONE" }), "Overlay settings")}
          />
        </div>
      )}
      {/* Wecra-only: overlays at one top or bottom position stack like toasts (the newest at the edge). */}
      {STACK_POSITIONS.has(position) && (
        <>
          <div className={styles.checkRow}>
            <Checkbox
              label={t("Stack overlays")}
              checked={!!n.overlayStack}
              onChange={(c) => ed.setProps([frame], protoFields({ overlayStack: c ? { gap: 8, max: 3 } : null }), "Overlay settings")}
            />
          </div>
          {stack && (
            <div className={styles.offsets} data-overlay-stack>
              <span className={styles.fieldLabel}>{t("Stack")}</span>
              <NumericInput
                label={t("Gap between overlays")}
                prefix={t("Gap")}
                className={styles.grow}
                value={stack.gap ?? 0}
                min={0}
                precision={0}
                onChange={(v, info) => ed.edit("Overlay settings", info, () => void ed.engine.setProps([frame], protoFields({ overlayStack: { ...stack, gap: v } })))}
              />
              <NumericInput
                label={t("Most shown at once")}
                prefix={t("Max")}
                className={styles.grow}
                value={stack.max ?? 0}
                min={0}
                max={20}
                precision={0}
                onChange={(v, info) => ed.edit("Overlay settings", info, () => void ed.engine.setProps([frame], protoFields({ overlayStack: { ...stack, max: v } })))}
              />
            </div>
          )}
        </>
      )}
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
 * A Conditional in the expanded dialog's right column (live 2026-10-23): "Condition" on its own row, the expression
 * field across under it (16 in, 8 from the end); its If / Else actions are rows of the list on the left.
 */
function ConditionRow({ action, onChange }: { action: PrototypeAction; onChange: (a: PrototypeAction, label?: string, info?: ChangeInfo) => void }) {
  useT();
  const ed = useEditor();
  const vars = useMemo(() => (ed.engine.destroyed ? [] : ed.engine.variables()), [ed]);
  const branches = conditionalBranches(action);
  return (
    <>
      <div className={styles.fieldRow}>
        <span className={styles.fieldLabel}>{t("Condition")}</span>
      </div>
      <div className={styles.conditionRow}>
        <ExpressionField
          label={t("Condition")}
          data={branches[0].condition}
          vars={vars}
          onCommit={(data) => {
            const next = [...branches];
            next[0] = { ...next[0], condition: data };
            onChange({ ...action, conditionalActions: next }, "Edit conditional");
          }}
        />
      </div>
    </>
  );
}
