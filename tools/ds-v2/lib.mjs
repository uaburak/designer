// Shared by the ds-v2 steps (docs/design-system-v2.md): checked tool calls, collections with modes, and idempotent
// variables whose values are primitive aliases — written, then read back and compared.
import { connect } from "../ui-kit/mcp.mjs";

export async function session() {
  const mcp = await connect();
  const call = async (name, args) => {
    const r = await mcp.rpc("tools/call", { name, arguments: args });
    const text = r.content.map((c) => c.text ?? "").join("");
    if (r.isError) throw new Error(`${name}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const defs = async () => (await call("get_variable_defs", { all: true })).collections ?? [];
  return { call, defs };
}

/** The collection named `name` with exactly `modes` (created or completed; the first mode is the default). */
export async function collection({ call, defs }, name, modes) {
  let col = (await defs()).find((c) => c.name === name);
  if (!col) {
    await call("create_variable_collection", { name, modes });
    col = (await defs()).find((c) => c.name === name);
  }
  for (const m of modes) if (!col.modes.some((x) => x.name === m)) await call("edit_variable_collection", { collectionId: col.id, action: "add_mode", name: m });
  return (await defs()).find((c) => c.name === name);
}

/**
 * Writes `vars` ([{name, type, values: {mode: "primitive/name" | number | "#hex"}, scopes?}]) into the collection:
 * a value naming a variable of `sources` (collections searched by name) becomes an alias. Then reads back.
 */
export async function upsert(s, colName, modes, vars, sources = []) {
  const col = await collection(s, colName, modes);
  const all = await s.defs();
  const byName = new Map();
  for (const c of all.filter((c) => sources.includes(c.name))) for (const v of c.variables ?? []) byName.set(`${c.name}:${v.name}`, v.id);
  const resolve = (x) => {
    if (typeof x !== "string" || x.startsWith("#")) return x;
    for (const src of sources) {
      const id = byName.get(`${src}:${x}`);
      if (id) return { alias: id };
    }
    throw new Error(`${colName}: no variable "${x}" in ${sources.join(", ")}`);
  };
  const existing = new Map((col.variables ?? []).map((v) => [v.name, v]));
  for (const v of vars) {
    const values = Object.fromEntries(Object.entries(v.values).map(([m, x]) => [m, resolve(x)]));
    const had = existing.get(v.name);
    if (had) await s.call("set_variable_value", { variableId: had.id, values });
    else await s.call("create_variable", { collectionId: col.id, name: v.name, type: v.type, values, scopes: v.scopes ?? [], ...(v.hidden ? { hiddenFromPublishing: true } : {}) });
  }
  // Read back: every variable, every mode, aliasing what it should
  const after = (await s.defs()).find((c) => c.name === colName);
  // The tool reports values resolved (an alias shows as the value it lands on, in its collection's default mode), so an
  // alias is checked by landing on what its target resolves to there
  const resolved = new Map();
  for (const c of await s.defs()) if (sources.includes(c.name)) for (const v of c.variables ?? []) if (!resolved.has(v.name)) resolved.set(v.name, Object.values(v.values ?? {})[0]);
  const idName = new Map();
  const got = new Map((after.variables ?? []).map((v) => [v.name, v]));
  const bad = [];
  for (const v of vars) {
    const g = got.get(v.name);
    if (!g) {
      bad.push(`${v.name}: missing`);
      continue;
    }
    for (const [m, want] of Object.entries(v.values)) {
      const have = g.values?.[m];
      // Newer apps report what an alias points at (`aliases`); older ones only the resolved value
      const haveName = g.aliases?.[m] ?? (have && typeof have === "object" ? idName.get(have.alias ?? have.id) ?? JSON.stringify(have) : have);
      const target = typeof want === "string" && !want.startsWith("#") ? resolved.get(want) : want;
      const ok = haveName === want || String(have).toUpperCase() === String(target).toUpperCase();
      if (!ok) bad.push(`${v.name} [${m}]: want ${want}, got ${JSON.stringify(have)}${haveName !== have ? ` (${haveName})` : ""}`);
    }
  }
  const extra = [...got.keys()].filter((n) => !vars.some((v) => v.name === n));
  console.log(`${colName}: ${vars.length - new Set(bad.map((b) => b.split(/[ :]/)[0])).size}/${vars.length} verified in ${modes.join(" / ")}; extra ${extra.length}`);
  if (bad.length) console.log("MISMATCH:\n  " + bad.join("\n  "));
  if (extra.length) console.log("EXTRA:\n  " + extra.join("\n  "));
  return bad.length === 0 && extra.length === 0;
}
