/**
 * Vector edit mode and on-canvas gradient handles, as the editor sees them
 * (E4 / E5, docs/engine-build.md "E4 + E5 API": the engine owns both — the
 * network, the handles, the gestures, the keys). The editor's part: the
 * toolbar switches to the vector-edit tools while it is on, the Design panel
 * shows the selected points (mirroring), Esc or "Done" leaves; the colour
 * picker enters the gradient handles while it shows a gradient and follows
 * the stop picked on the canvas. A build without these names reads as "not
 * available" (the controls stay disabled), never as an error.
 *
 * Engine names: `startVectorEdit(ref)`, `endVectorEdit()`, `vectorEdit`,
 * `setVectorEditTool("MOVE" | "PEN" | "BEND")`, event `VECTOR_EDIT`, command
 * `VECTOR_SET_MIRRORING {mirroring}`; `startPaintEdit(ref, {paints, index})`,
 * `endPaintEdit()`, `setPaintEditStop(i)`, event `PAINT_EDIT`.
 */
import type { Guid } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import { Status } from "@/engine/abi";
import { engineCommandEnabled, engineMethod, hasCommand, runEngineCommand } from "./engineCompat";
import { Store } from "./uiStore";

/** The vector-edit toolbar's tools (Figma UI3, left to right). */
export type VectorTool = "MOVE" | "LASSO" | "PEN" | "BEND" | "PAINT_BUCKET";
export const VECTOR_TOOLS: VectorTool[] = ["MOVE", "LASSO", "PEN", "BEND", "PAINT_BUCKET"];
/** The ones the engine takes (`setVectorEditTool`). */
const ENGINE_VECTOR_TOOLS: ReadonlySet<VectorTool> = new Set(["MOVE", "PEN", "BEND"]);

export type Mirroring = "NONE" | "ANGLE" | "ANGLE_AND_LENGTH";

export interface VectorEditState {
  active: boolean;
  ref: Guid | null;
  tool: VectorTool;
  selectedVertices: number[];
  selectedSegments: number[];
  vertexCount: number;
  segmentCount: number;
  /** The selected vertices' handle mirroring; "MIXED"; null with none selected */
  mirroring: Mirroring | "MIXED" | null;
}

export const NO_VECTOR_EDIT: VectorEditState = { active: false, ref: null, tool: "MOVE", selectedVertices: [], selectedSegments: [], vertexCount: 0, segmentCount: 0, mirroring: null };

type Raw = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const nums = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
const MIRRORING = new Set(["NONE", "ANGLE", "ANGLE_AND_LENGTH", "MIXED"]);

/** A VECTOR_EDIT event (or `engine.vectorEdit`) → the state the toolbar and panel show. */
export function readVectorEdit(raw: Raw | null | undefined): VectorEditState {
  if (!raw || raw.active !== true) return NO_VECTOR_EDIT;
  const tool = String(raw.tool ?? "MOVE") as VectorTool;
  const mirroring = MIRRORING.has(String(raw.mirroring)) ? (raw.mirroring as VectorEditState["mirroring"]) : null;
  return {
    active: true,
    ref: typeof raw.ref === "string" ? raw.ref : null,
    tool: VECTOR_TOOLS.includes(tool) ? tool : "MOVE",
    selectedVertices: nums(raw.selectedVertices),
    selectedSegments: nums(raw.selectedSegments),
    vertexCount: num(raw.vertexCount),
    segmentCount: num(raw.segmentCount),
    mirroring,
  };
}

/** One editor's view of the engine's vector edit mode. */
export class VectorEditor {
  readonly state: Store<VectorEditState>;
  private readonly off: () => void;

  constructor(private readonly engine: Engine) {
    this.state = new Store<VectorEditState>(readVectorEdit((engine as unknown as { vectorEdit?: Raw | null }).vectorEdit));
    this.off = engine.onAny((e) => {
      const ev = e as unknown as Raw;
      if (ev.type === "VECTOR_EDIT") this.state.set(readVectorEdit(ev));
    });
  }

  dispose(): void {
    this.off();
  }

  /** Can this build enter vector edit mode? */
  get available(): boolean {
    return !!engineMethod(this.engine, "startVectorEdit");
  }

  /** Does the engine have this vector-edit tool? (Lasso and Paint bucket: not yet) */
  hasTool(tool: VectorTool): boolean {
    return this.available && ENGINE_VECTOR_TOOLS.has(tool) && !!engineMethod(this.engine, "setVectorEditTool");
  }

  /** "Edit object" (Enter or a double-click on a vector does it on the canvas). */
  start(ref: Guid): boolean {
    const f = engineMethod<(ref: Guid) => number>(this.engine, "startVectorEdit");
    return !!f && f(ref) === Status.OK;
  }

  /** "Done" / Esc. */
  end(): void {
    engineMethod<() => void>(this.engine, "endVectorEdit")?.();
  }

  setTool(tool: VectorTool): void {
    if (this.hasTool(tool)) engineMethod<(tool: string) => number>(this.engine, "setVectorEditTool")?.(tool);
  }

  /** The selected vertices' mirroring (one undo step). */
  get canSetMirroring(): boolean {
    return hasCommand("VECTOR_SET_MIRRORING") && this.state.get().selectedVertices.length > 0;
  }

  setMirroring(mirroring: Mirroring): number {
    return runEngineCommand(this.engine, "VECTOR_SET_MIRRORING", { mirroring });
  }

  /** ⌫ in the panel's sense: "Delete and heal" (the engine's own keys do it on the canvas). */
  get canDeleteAndHeal(): boolean {
    return engineCommandEnabled(this.engine, "VECTOR_DELETE_AND_HEAL");
  }
}

/** The picker's paint list as the engine names it. */
const PAINTS = { fillPaints: "FILL", strokePaints: "STROKE" } as const;

/**
 * On-canvas gradient handles for one paint (E5 `startPaintEdit`): returns the controls, or null when the build
 * has none or the paint isn't a gradient the engine edits.
 */
export function startGradientEdit(engine: Engine, ref: Guid, field: "fillPaints" | "strokePaints", index: number): { setStop: (stop: number) => void; end: () => void } | null {
  const start = engineMethod<(ref: Guid, options: { paints: "FILL" | "STROKE"; index: number }) => number>(engine, "startPaintEdit");
  if (!start || start(ref, { paints: PAINTS[field], index }) !== Status.OK) return null;
  return {
    setStop: (stop) => {
      if (!engine.destroyed) engineMethod<(i: number) => void>(engine, "setPaintEditStop")?.(stop);
    },
    end: () => {
      if (!engine.destroyed) engineMethod<() => void>(engine, "endPaintEdit")?.();
    },
  };
}
