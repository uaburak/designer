/**
 * Renaming several layers at once (⌘R on a multiple selection, help "Rename layers"): "Rename to" — where `$&` is
 * the current name (or the matched text), `$n`, `$nn`… a number counting up and `$N`, `$NN`… one counting down,
 * padded to as many digits as there are letters —, optionally only the part that "Match" finds, and the number's
 * start. The numbers run from the bottom of the Layers panel up (Figma's order: the first layer made is 1).
 */

export interface RenameRule {
  /** Empty: the whole name is replaced */
  match: string;
  renameTo: string;
  /** The first number (default 1) */
  start: number;
}

const pad = (n: number, width: number) => {
  const s = String(Math.abs(n));
  return (n < 0 ? "-" : "") + (s.length >= width ? s : "0".repeat(width - s.length) + s);
};

/** The text that replaces one match (or the whole name): `$&` and the numbers filled in. */
export function expandRename(template: string, current: string, up: number, down: number): string {
  return template.replace(/\$&|\$(n+)|\$(N+)/g, (all, asc: string | undefined, desc: string | undefined) => {
    if (all === "$&") return current;
    if (asc) return pad(up, asc.length);
    return pad(down, desc!.length);
  });
}

/**
 * The new names of `names` (listed as the Layers panel shows them, top first). A name the match doesn't occur in is
 * left as it is; an empty "Rename to" with no match changes nothing.
 */
export function renameAll(names: readonly string[], rule: RenameRule): string[] {
  const count = names.length;
  return names.map((name, i) => {
    const up = rule.start + (count - 1 - i); // the bottom row is the first
    const down = rule.start + i;
    if (!rule.match) return rule.renameTo ? expandRename(rule.renameTo, name, up, down) : name;
    if (!name.includes(rule.match)) return name;
    return name.split(rule.match).join(expandRename(rule.renameTo, rule.match, up, down));
  });
}
