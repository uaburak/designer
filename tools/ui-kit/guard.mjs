// A write's sanity check: reads layers' bounds back and stops the run when one is out of bounds — a layout that
// compounds (a component set growing with every combine, say) must never go on unnoticed.
export const CANVAS_BOUND = 130000;

/** get_metadata's own line for a layer: {type, name, x, y, width, height}. */
export async function boundsOf(mcp, id) {
  const meta = String(await mcp.call("get_metadata", { nodeId: id, depth: 0 }));
  const m = /<(\w+) id="[^"]+" name="([^"]*)" x="([-\d.e+]+)" y="([-\d.e+]+)" width="([-\d.e+]+)" height="([-\d.e+]+)"/.exec(meta);
  if (!m) throw new Error(`guard: can't read ${id}'s bounds`);
  return { type: m[1], name: m[2], x: Number(m[3]), y: Number(m[4]), width: Number(m[5]), height: Number(m[6]) };
}

/** Throws when a layer is larger than `max` px on an axis, or (`top`: a page's own layer) past the canvas bound. */
export async function guard(mcp, id, { max = 4000, exact = null, top = false, what = "" } = {}) {
  const b = await boundsOf(mcp, id);
  const bad = (msg) => {
    throw new Error(`guard: ${what || b.name} (${id}) ${msg} — x ${b.x}, y ${b.y}, ${b.width} × ${b.height}. Stopped.`);
  };
  if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) bad("has a non-finite bound");
  if (exact && (Math.abs(b.width - exact.width) > 0.5 || Math.abs(b.height - exact.height) > 0.5)) bad(`isn't ${exact.width} × ${exact.height}`);
  if (max && (b.width > max || b.height > max)) bad(`is larger than ${max} px`);
  if (top && (Math.abs(b.x) > CANVAS_BOUND || Math.abs(b.y) > CANVAS_BOUND || Math.abs(b.x + b.width) > CANVAS_BOUND || Math.abs(b.y + b.height) > CANVAS_BOUND)) bad(`reaches past the canvas bound ±${CANVAS_BOUND}`);
  return b;
}
