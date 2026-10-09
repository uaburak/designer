/**
 * What a running turn is doing, in the chat's words — the thinking line of the group the turn is in (Figma AI's and
 * Claude's shimmering line): its current step ("Reading the design…", "Making an image…"), the CLI's own status while
 * it starts ("Starting Antigravity…"), else "Thinking…"; the seconds it has taken, after 5 s. And the answer cut into
 * its words and its groups of steps (segmentsOf). Pure: the chat renders it, the tests read it.
 */
import { toolLabel, type ChatMessage, type ImagePart, type MessagePart } from "./service";

/** A step while it runs, in the present tense (its finished label is service.ts's toolLabel). */
const TOOL_ACTIVE: Record<string, string> = {
  get_selection: "Looking at the selection…",
  // The agents' own file tools, on the files attached to the message (Antigravity's view_file, Claude Code's Read)
  view_file: "Looking at the attached file…",
  Read: "Looking at the attached file…",
  get_metadata: "Reading the layers…",
  get_design_context: "Reading the design…",
  get_screenshot: "Taking a screenshot…",
  get_variable_defs: "Reading variables and styles…",
  create_nodes: "Creating layers…",
  update_nodes: "Editing layers…",
  delete_nodes: "Deleting layers…",
  duplicate_nodes: "Duplicating layers…",
  reparent_nodes: "Moving layers…",
  set_auto_layout: "Setting auto layout…",
  apply_variable: "Applying a variable…",
  apply_style: "Applying a style…",
  create_responsive_variant: "Making a responsive version…",
  set_selection: "Selecting the result…",
  place_image: "Placing the image…",
  generate_image: "Making an image…",
};

export const toolActiveLabel = (name: string): string => {
  const known = TOOL_ACTIVE[name];
  if (known) return known;
  const words = name.replace(/_/g, " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}…` : "Working…";
};

export const THINKING = "Thinking…";

/** The line a running answer shows, or null when the turn is over. */
export function activityOf(m: Pick<ChatMessage, "state" | "parts">): string | null {
  if (m.state !== "running") return null;
  const parts = m.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "tool" && p.state === "running") return toolActiveLabel(p.name);
  }
  // An image made but not on the canvas yet: the agent is about to place it.
  if (parts.some((p) => p.kind === "image" && p.state === "ready")) return TOOL_ACTIVE.place_image;
  const status = parts.find((p) => p.kind === "status");
  // The CLI's start line until the agent says or does something (an image card put up for the prompt aside).
  if (status && status.kind === "status" && parts.every((p) => p.kind === "status" || p.kind === "image")) return status.text;
  // Between steps (the agent deciding what's next): the step it just finished, so the line keeps saying what the wait
  // is about ("Read the design"), until it writes words — only then, or before any step, "Thinking…".
  const last = parts[parts.length - 1];
  if (last?.kind === "tool") return toolLabel(last.name);
  return THINKING;
}

// ---- An answer as text and groups of steps -------------------------------------------------------------------------

export type ToolPart = Extract<MessagePart, { kind: "tool" }>;

/**
 * A piece of an answer as the chat shows it: the agent's words, or a group of steps in one collapsible row — a run of
 * steps between its words ("steps"), or an image being made with its steps and its card ("image").
 */
export type Segment =
  | { kind: "text"; key: string; text: string }
  | { kind: "steps"; key: string; steps: ToolPart[]; active: boolean; label: string }
  | { kind: "image"; key: string; steps: ToolPart[]; image?: ImagePart; active: boolean; label: string };

export const GENERATE_IMAGE = "Generate image";
export const PLACE_IMAGE = "Place image";

type StepsSeg = Extract<Segment, { kind: "steps" }>;
type ImageSeg = Extract<Segment, { kind: "image" }>;

/** A finished group of steps reads as its last step does inside it ("Read the design"), not "Thinking". */
export function stepsSummary(steps: readonly ToolPart[]): string {
  const last = steps[steps.length - 1];
  return last ? toolLabel(last.name) : "Thinking";
}

/**
 * The answer as the chat shows it (Claude's desktop way): its words as paragraphs, and each run of steps between them
 * as one group, collapsed. generate_image gets a group of its own ("Generate image") with its card — where the card is,
 * so the one put up as the prompt was sent doesn't move — and the place_image that puts that picture on the canvas.
 * While the turn runs, exactly one group is active (its header is the thinking line): the one with the step running
 * now, else an image made and about to be placed, else the last run of steps; after words (or before anything) a new,
 * empty one at the bottom ("Thinking…"), which the next step fills under the same key.
 */
export function segmentsOf(m: Pick<ChatMessage, "state" | "parts">): Segment[] {
  const parts = m.parts ?? [];
  const segs: Segment[] = [];
  const genTools = parts.filter((p): p is ToolPart => p.kind === "tool" && p.name === "generate_image");
  const toolOfImage = (img: ImagePart) => img.tool ?? genTools.find((t) => `image:${t.id}` === img.id)?.id;
  const byTool = new Map<string, ImageSeg>();
  /** Image groups whose picture isn't placed by a step yet, oldest first (withPlacedImage fills the oldest). */
  const toPlace: ImageSeg[] = [];
  const waitingImage = () => toPlace.find((s) => s.steps.some((t) => t.name === "generate_image" && t.state !== "error"));
  let open: StepsSeg | null = null;
  const imageSeg = (key: string): ImageSeg => {
    const s: ImageSeg = { kind: "image", key, steps: [], active: false, label: GENERATE_IMAGE };
    segs.push(s);
    open = null;
    return s;
  };
  parts.forEach((p, i) => {
    if (p.kind === "text") {
      if (!p.text.trim()) return;
      segs.push({ kind: "text", key: `text:${i}`, text: p.text });
      open = null;
    } else if (p.kind === "status") {
      // The CLI's start line: no step of its own, the group's line while it is the only thing.
      if (!open) segs.push((open = { kind: "steps", key: `steps:${i}`, steps: [], active: false, label: "" }));
    } else if (p.kind === "image") {
      const tool = toolOfImage(p);
      let seg = tool ? byTool.get(tool) : undefined;
      if (!seg) {
        // A picture placed without generate_image (an attached one): the place_image step just before it is its.
        const prev = parts[i - 1];
        const placing: ToolPart | undefined = !tool && !p.asked && prev?.kind === "tool" && prev.name === "place_image" ? prev : undefined;
        const from: StepsSeg | null = open;
        if (placing && from && from.steps[from.steps.length - 1] === placing) {
          from.steps.pop();
          if (!from.steps.length) segs.splice(segs.indexOf(from), 1);
        }
        seg = imageSeg(p.id);
        if (placing) seg.steps.push(placing);
        else if (p.asked || tool) toPlace.push(seg);
        if (tool) byTool.set(tool, seg);
      }
      seg.image = p;
    } else if (p.name === "generate_image") {
      let seg = byTool.get(p.id);
      if (!seg) {
        seg = imageSeg(`image:${p.id}`);
        byTool.set(p.id, seg);
        toPlace.push(seg);
      }
      seg.steps.unshift(p);
    } else if (p.name === "place_image" && waitingImage()) {
      const seg = waitingImage()!;
      toPlace.splice(toPlace.indexOf(seg), 1);
      seg.steps.push(p);
    } else {
      if (!open) segs.push((open = { kind: "steps", key: `steps:${i}`, steps: [], active: false, label: "" }));
      open.steps.push(p);
    }
  });
  for (const s of segs) {
    if (s.kind === "steps") s.label = stepsSummary(s.steps);
    // A picture the agent had (an attached one), only placed: "Place image".
    else if (s.kind === "image" && !s.image?.asked && !s.steps.some((t) => t.name === "generate_image")) s.label = PLACE_IMAGE;
  }
  if (m.state !== "running") return segs;
  // The one group the turn is in now.
  let running: ToolPart | undefined;
  for (let i = parts.length - 1; i >= 0 && !running; i--) {
    const p = parts[i];
    if (p.kind === "tool" && p.state === "running") running = p;
  }
  const groups = segs.filter((s): s is StepsSeg | ImageSeg => s.kind !== "text");
  let active: StepsSeg | ImageSeg | undefined = running ? groups.find((g) => g.steps.includes(running)) : groups.find((g) => g.kind === "image" && g.image?.state === "ready");
  const lastSeg = segs[segs.length - 1];
  if (!active && lastSeg?.kind === "steps") active = lastSeg;
  if (!active) segs.push((active = { kind: "steps", key: `steps:${parts.length}`, steps: [], active: false, label: "" }));
  active.active = true;
  active.label = activityOf(m) ?? THINKING;
  return segs;
}

/** The seconds a turn has taken, shown from 5 s on ("12s", "1m 05s"); empty before that. */
export function elapsedLabel(startedAt: number | undefined, now: number): string {
  if (!startedAt) return "";
  const s = Math.floor((now - startedAt) / 1000);
  if (s < 5) return "";
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The aspect (width / height) an image request asks for: `aspect_ratio` "16:9", or `width` / `height`; else square. */
export function requestedAspect(args: unknown): number {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const ratio = a.aspect_ratio ?? a.aspectRatio ?? a.AspectRatio;
  let r = 1;
  if (typeof ratio === "string") {
    const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/×]\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio);
    if (m && +m[2] > 0) r = +m[1] / +m[2];
  } else if (typeof ratio === "number" && ratio > 0) r = ratio;
  else if (typeof a.width === "number" && typeof a.height === "number" && a.width > 0 && a.height > 0) r = a.width / a.height;
  return Math.min(4, Math.max(0.25, r));
}

// ---- Does the prompt ask for a picture? ----------------------------------------------------------------------------

/** Letters and digits in either language (JS's \b knows no ç, ğ, ı, ö, ş, ü). */
const L = "\\p{L}\\p{N}";
/** English words: the stems, a common ending, then no letter. */
const en = (stems: string) => new RegExp(`(?<![${L}])(?:${stems})(?:e|es|ed|d|s|ing|ting)?(?![${L}])`, "u");
/** Turkish words: the stems with any suffix (resmi, görselini, fotoğrafını, çizer misin). */
const tr = (stems: string) => new RegExp(`(?<![${L}])(?:${stems})[${L}]*`, "u");
/** A picture by name. */
const IMAGE_NOUN = [en("image|picture|photo|photograph|photography|illustration|artwork|rendering|wallpaper|portrait|drawing"), tr("resim|resm|görsel|gorsel|foto|illüstrasyon|illustrasyon|çizim|cizim")];
/** "Draw …" asks for a picture unless it names a shape or a layer (draw a line, bir dikdörtgen çiz). */
const DRAW = [en("draw|sketch|illustrat|render"), tr("çiz(?!gi)|ciz(?!gi)")];
const SHAPE = [
  en("line|arrow|rectangle|square|circle|ellipse|triangle|polygon|star|shape|frame|box|boxe|border|divider|icon|button"),
  tr("çizgi|cizgi|dikdörtgen|dikdortgen|kare|daire|çember|elips|üçgen|yıldız|şekil|şekl|çerçeve|kutu|ikon|buton|düğme"),
  new RegExp(`(?<![${L}])ok(?:u|la|lar|ları)?(?![${L}])`, "u"),
];
/** Making one outright: "generate an image", "add a photo", "resim üret", "görsel ekle", "bu kareye resim koy". */
const MAKE = [en("generat|creat|render|illustrat|produc|design|add|put|insert|plac|fill|replac"), tr("üret|uret|oluştur|olustur|tasarla|koy|ekle|doldur|değiştir|degistir")];
/** Doing something to an image that is there: "delete the image", "make the photo bigger", "resmi sil". */
const ACT_ON = [
  en("delet|remov|hid|hide|mov|align|resiz|renam|crop|export|download|rotat|flip|bigger|smaller|larger|scal|blur|describ|what|which|where"),
  tr("kaldır|gizle|hizala|büyüt|küçült|döndür|dışa aktar|kırp|yeniden adlandır|bulanık|nerede|hangi|nedir|anlat"),
  new RegExp(`(?<![${L}])(?:sil|silin|siler|silebilir|taşı|taşır|taşıyın)(?![${L}])`, "u"),
];

const any = (res: RegExp[], s: string) => res.some((r) => r.test(s));

/**
 * Whether a chat prompt asks for a picture to be made — the chat then shows where it will land at once, before the
 * agent gets to generate_image. A guess from the words, English and Turkish: a picture named ("an image of …", "a
 * photo", "a 3D render", "bir kovboy resmi", "görsel", "fotoğraf", "illüstrasyon") or "draw" / "çiz" that names no
 * shape; not when the prompt only does something to an image that is there ("delete the image", "make the photo
 * bigger", "resmi sil") unless it also says to make or put one. A wrong guess costs a placeholder that fades out when
 * the turn ends without a picture.
 */
export function asksForImage(prompt: string): boolean {
  const s = prompt.toLowerCase().replace(/\u0307/g, ""); // "İ" lowercases to i + a combining dot
  if (any(DRAW, s) && !any(SHAPE, s)) return true;
  if (!any(IMAGE_NOUN, s)) return false;
  return any(MAKE, s) || !any(ACT_ON, s);
}
