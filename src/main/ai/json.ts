/**
 * A one-shot answer's JSON (docs/ai.md §2.2): the last JSON object in the model's text, checked against the action's
 * schema. The checker covers what the actions' schemas use (src/shared/ai/schemas.ts): type, properties, required,
 * additionalProperties, items, enum, const, anyOf / oneOf, string and array lengths, number bounds. Pure: tested in Node.
 */

/** The last complete top-level JSON object in `text` (code fences, prose around it and earlier objects are skipped). */
export function lastJsonObject(text: string): { value: unknown } | null {
  const spans: [number, number][] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (depth > 0 && inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (depth > 0 && c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) spans.push([start, i + 1]);
    }
  }
  for (let k = spans.length - 1; k >= 0; k--) {
    try {
      return { value: JSON.parse(text.slice(spans[k][0], spans[k][1])) };
    } catch {
      /* not JSON: an earlier one */
    }
  }
  return null;
}

type Schema = Record<string, unknown>;

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
const fits = (actual: string, want: string) => actual === want || (want === "number" && actual === "integer");

/** Where `value` doesn't match `schema` ("$.names[2].id: expected string"); empty when it does. At most `max` errors. */
export function schemaErrors(schema: Schema, value: unknown, path = "$", max = 20): string[] {
  const out: string[] = [];
  check(schema, value, path, out, max);
  return out.slice(0, max);
}

function check(s: Schema, v: unknown, path: string, out: string[], max: number): void {
  if (out.length >= max || !s || typeof s !== "object") return;
  const t = typeOf(v);
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((w) => fits(t, w))) {
      out.push(`${path}: expected ${types.join(" or ")}, got ${t}`);
      return;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) out.push(`${path}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(v)) out.push(`${path}: must be ${JSON.stringify(s.const)}`);
  for (const key of ["anyOf", "oneOf"] as const) {
    const alts = s[key];
    if (Array.isArray(alts) && alts.length && !alts.some((a) => schemaErrors(a as Schema, v, path, 1).length === 0)) out.push(`${path}: matches none of the allowed shapes`);
  }
  if (t === "string") {
    const str = v as string;
    if (typeof s.minLength === "number" && str.length < s.minLength) out.push(`${path}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === "number" && str.length > s.maxLength) out.push(`${path}: longer than ${s.maxLength}`);
  }
  if (t === "number" || t === "integer") {
    const n = v as number;
    if (typeof s.minimum === "number" && n < s.minimum) out.push(`${path}: below ${s.minimum}`);
    if (typeof s.maximum === "number" && n > s.maximum) out.push(`${path}: above ${s.maximum}`);
  }
  if (t === "array") {
    const arr = v as unknown[];
    if (typeof s.minItems === "number" && arr.length < s.minItems) out.push(`${path}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && arr.length > s.maxItems) out.push(`${path}: more than ${s.maxItems} items`);
    if (s.items && typeof s.items === "object" && !Array.isArray(s.items)) arr.forEach((item, i) => check(s.items as Schema, item, `${path}[${i}]`, out, max));
  }
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of Array.isArray(s.required) ? (s.required as string[]) : []) if (!(r in obj)) out.push(`${path}: missing "${r}"`);
    for (const [k, val] of Object.entries(obj)) {
      if (props[k]) check(props[k], val, `${path}.${k}`, out, max);
      else if (s.additionalProperties === false) out.push(`${path}: unexpected "${k}"`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") check(s.additionalProperties as Schema, val, `${path}.${k}`, out, max);
    }
  }
}

/** The answer as the action's JSON: the CLI's structured output, else the last object in the text — with its problems. */
export function readAnswer(text: string, schema: Schema | undefined, structured?: unknown): { json?: unknown; errors: string[] } {
  const found = structured !== undefined ? { value: structured } : lastJsonObject(text);
  if (!schema) return { json: found?.value, errors: [] };
  if (!found) return { errors: ["the answer has no JSON object"] };
  return { json: found.value, errors: schemaErrors(schema, found.value) };
}
