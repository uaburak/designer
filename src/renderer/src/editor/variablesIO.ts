/**
 * Variables in and out of the file (round 6; docs/research/figma/R3-variables.md "Round 6"):
 *
 * - "Export mode" / "Export modes": Figma's DTCG files (model/dtcg.ts), saved through main on the desktop (its Save
 *   dialog, or a folder for several) or downloaded in a browser.
 * - "Import mode": a DTCG file's tokens update the variables of the same name and type in that mode.
 * - Files dropped on the view: one new mode per file in the collection; tokens present in every file with one type
 *   become variables (an empty collection's first file fills its default mode).
 * - Copy / Paste across files: Copy also puts the variables on the system clipboard (text: a JSON document marked
 *   `designerVariables`, each with its type and its values by mode name); Paste in another file's window creates them
 *   (modes matched by name, else the default mode's value; aliases to variables the file lacks take their resolved
 *   values).
 */
import { showToast } from "@/ds";
import type { Guid } from "@/engine/codec";
import type { EditorController } from "./controller";
import { saveFiles } from "./exporting";
import { exportMode, modeFileName, parseTokens, tokenValue, type ImportedFile } from "./model/dtcg";
import { resolveVariable, valueIn, type Collection, type Literal, type VarType, type VarValue, type Variable } from "./model/variables";
import { addMode, createVariable, renameMode, renameVariable, setVariableValue } from "./variables";

const encoder = new TextEncoder();

const assetsOf = (ed: EditorController) => ed.variables.get();

/** The variables of a collection (an extended one shows its root's), in their order. */
function variablesOf(ed: EditorController, c: Collection): Variable[] {
  let root = c;
  for (let i = 0; root.parentCollection && i < 16; i++) root = root.parentCollection;
  const a = assetsOf(ed);
  return [...a.variables, ...a.library.variables].filter((v) => v.collection === root.id);
}

/** The DTCG files of `modes` (all of the collection's when absent): `<Mode>.tokens.json` each. */
export function modeFiles(ed: EditorController, collection: Guid, modes?: readonly Guid[]): { name: string; text: string }[] {
  const a = assetsOf(ed);
  const c = a.lookup.collection(collection);
  if (!c) return [];
  const vars = variablesOf(ed, c);
  const list = modes ?? c.modes.map((m) => m.id);
  return list.map((mode) => ({
    name: modeFileName(c.modes.find((m) => m.id === mode)?.name ?? "Mode 1"),
    text: exportMode(c, vars, mode, a.lookup, (v, m) => {
      const value = valueIn(v, m, c);
      return value.kind === "alias" ? resolveVariable(value.id, a.lookup) : value.value;
    }),
  }));
}

/** "Export mode" / "Export modes": the files saved (the desktop's Save dialog) or downloaded. */
export async function exportModes(ed: EditorController, collection: Guid, modes?: readonly Guid[]): Promise<void> {
  const files = modeFiles(ed, collection, modes);
  if (!files.length) return;
  await saveFiles(
    ed,
    files.map((f) => ({ name: f.name, bytes: encoder.encode(f.text) })),
  );
}

function parseAll(files: readonly { name: string; text: string }[]): { name: string; file: ImportedFile }[] | null {
  const out: { name: string; file: ImportedFile }[] = [];
  for (const f of files) {
    try {
      out.push({ name: f.name, file: parseTokens(f.text) });
    } catch {
      showToast({ message: `Couldn't import “${f.name}”: it isn't a design tokens JSON file`, kind: "error" });
      return null;
    }
  }
  return out;
}

const baseName = (file: string) => file.replace(/\.tokens\.json$|\.json$/i, "");

/**
 * "Import mode": the tokens of one file update the variables of the same name and type in `mode`. Returns how many
 * were updated (a toast says it).
 */
export function importIntoMode(ed: EditorController, collection: Guid, mode: Guid, file: { name: string; text: string }): number {
  const parsed = parseAll([file]);
  if (!parsed) return 0;
  const a = assetsOf(ed);
  const c = a.lookup.collection(collection);
  if (!c) return 0;
  const vars = variablesOf(ed, c);
  const byName = new Map(vars.map((v) => [v.name, v]));
  const all = [...a.variables, ...a.library.variables];
  let updated = 0;
  const { tokens } = parsed[0].file;
  ed.batch("Import mode", () => {
    for (const t of tokens) {
      const v = byName.get(t.name);
      if (!v || v.type !== t.type) continue;
      const value = tokenValue(t, byName, all, a.lookup);
      if (value && setVariableValue(ed, v.id, mode, value)) updated++;
    }
  });
  showToast({ message: `Imported ${updated} of ${tokens.length} ${tokens.length === 1 ? "variable" : "variables"}` });
  return updated;
}

/**
 * Files dropped on the view: one new mode per file (named by the file's `com.figma.modeName`, else its name); the
 * tokens in every file with one type become variables. An empty collection's first file takes its default mode.
 */
export function importModes(ed: EditorController, collection: Guid, files: readonly { name: string; text: string }[]): number {
  const parsed = parseAll(files);
  if (!parsed || !parsed.length) return 0;
  const a = assetsOf(ed);
  const c = a.lookup.collection(collection);
  if (!c || c.parent) return 0;
  // Tokens present in all files with the same type.
  const types = new Map<string, VarType>();
  for (const t of parsed[0].file.tokens) types.set(t.name, t.type);
  for (const p of parsed.slice(1)) {
    const here = new Map(p.file.tokens.map((t) => [t.name, t.type]));
    for (const [name, type] of [...types]) if (here.get(name) !== type) types.delete(name);
  }
  let created = 0;
  ed.batch("Import variables", () => {
    const empty = variablesOf(ed, c).length === 0;
    const modes: Guid[] = [];
    parsed.forEach((p, i) => {
      const name = p.file.modeName ?? baseName(p.name);
      if (i === 0 && empty) {
        renameMode(ed, c.id, c.defaultMode, name);
        modes.push(c.defaultMode);
      } else {
        const id = addMode(ed, c.id, undefined, name);
        if (id) modes.push(id);
      }
    });
    // Variables: existing ones by name (and type), else new ones in the file's order.
    const byName = new Map(variablesOf(ed, c).map((v) => [v.name, v]));
    for (const [name, type] of types) {
      if (byName.has(name)) continue;
      const id = createVariable(ed, c.id, type);
      if (!id) continue;
      renameVariable(ed, id, name);
      created++;
    }
    const fresh = assetsOf(ed);
    const now = new Map(variablesOf(ed, fresh.lookup.collection(c.id) ?? c).map((v) => [v.name, v]));
    const all = [...fresh.variables, ...fresh.library.variables];
    parsed.forEach((p, i) => {
      const mode = modes[i];
      if (!mode) return;
      for (const t of p.file.tokens) {
        const v = now.get(t.name);
        if (!v || v.type !== t.type || !types.has(t.name)) continue;
        const value = tokenValue(t, now, all, fresh.lookup);
        if (value) setVariableValue(ed, v.id, mode, value);
      }
    });
  });
  showToast({ message: `Imported ${types.size} ${types.size === 1 ? "variable" : "variables"} in ${parsed.length} ${parsed.length === 1 ? "mode" : "modes"}` });
  return created;
}

// ---- Copy / paste through the system clipboard --------------------------------------------------------------------

export const CLIPBOARD_MARK = "designerVariables";

interface ClipVariable {
  name: string;
  type: VarType;
  description: string;
  scopes: string[] | null;
  /** mode name → value (aliases resolved to literals unless the target travels too: then by its name) */
  values: Record<string, { literal: Literal } | { alias: string }>;
  defaultMode: string;
}

/** The copied variables as the clipboard's text (a JSON document another file's window understands). */
export function clipboardText(ed: EditorController, ids: readonly Guid[]): string {
  const a = assetsOf(ed);
  const names = new Map(ids.map((id) => [id, a.lookup.variable(id)?.name ?? ""]));
  const out: ClipVariable[] = [];
  for (const id of ids) {
    const v = a.lookup.variable(id);
    const c = v ? a.lookup.collection(v.collection) : undefined;
    if (!v || !c) continue;
    const values: ClipVariable["values"] = {};
    for (const m of c.modes) {
      const value = valueIn(v, m.id, c);
      if (value.kind === "alias" && names.has(value.id)) values[m.name] = { alias: names.get(value.id)! };
      else {
        const lit = value.kind === "alias" ? resolveVariable(value.id, a.lookup) : value.value;
        if (lit !== null) values[m.name] = { literal: lit };
      }
    }
    out.push({ name: v.name, type: v.type, description: v.description, scopes: v.scopes, values, defaultMode: c.modes.find((m) => m.id === c.defaultMode)?.name ?? "" });
  }
  return JSON.stringify({ [CLIPBOARD_MARK]: 1, variables: out });
}

/** The variables a clipboard text holds (null: not ours). */
export function readClipboardText(text: string): ClipVariable[] | null {
  try {
    const v = JSON.parse(text) as { [CLIPBOARD_MARK]?: number; variables?: ClipVariable[] };
    return v && v[CLIPBOARD_MARK] === 1 && Array.isArray(v.variables) ? v.variables : null;
  } catch {
    return null;
  }
}

/** Pastes clipboard variables into `collection` (group: the selected one): one undo step. */
export function pasteClipboardVariables(ed: EditorController, clip: readonly ClipVariable[], collection: Guid, group = ""): Guid[] {
  const a = assetsOf(ed);
  const c = a.lookup.collection(collection);
  if (!c || c.parent) return [];
  const made: Guid[] = [];
  const nameOf = new Map<string, Guid>();
  ed.batch("Paste variables", () => {
    const taken = new Set(variablesOf(ed, c).map((v) => v.name));
    for (const cv of clip) {
      const leaf = cv.name.split("/").pop() ?? cv.name;
      let name = group ? `${group}/${leaf}` : leaf;
      for (let i = 2; taken.has(name); i++) name = (group ? `${group}/` : "") + `${leaf} ${i}`;
      taken.add(name);
      const id = createVariable(ed, c.id, cv.type);
      if (!id) continue;
      renameVariable(ed, id, name);
      nameOf.set(cv.name, id);
      made.push(id);
    }
    clip.forEach((cv) => {
      const id = nameOf.get(cv.name);
      if (!id) return;
      for (const m of c.modes) {
        const src = cv.values[m.name] ?? cv.values[cv.defaultMode] ?? Object.values(cv.values)[0];
        if (!src) continue;
        let value: VarValue | null = null;
        if ("alias" in src) {
          const target = nameOf.get(src.alias);
          if (target) value = { kind: "alias", id: target };
        } else value = { kind: "literal", value: src.literal };
        if (value) setVariableValue(ed, id, m.id, value);
      }
    });
  });
  return made;
}
