// Visual search's index for the scene: frames and components of a few files, each drawn as its 224 px thumbnail
// would show it, with what the two models would see in it. The app ranks with CLIP image vectors (512) and MiniLM
// text vectors (384), computed on the computer (docs/ai.md §6); the scene stands in for them with a handful of visual
// traits (`look`) and the layer's words (`words`), ranked the store's way: exact names first, then 0.6 · image +
// 0.4 · text, nothing under 0.12.
import type { ReactNode } from "react";

export type Look = { dark: number; form: number; chart: number; list: number; cards: number; picture: number; map: number; control: number };

export interface Hit {
  id: string;
  name: string;
  file: string;
  kind: "frame" | "component";
  /** Days since it was last changed (Sort by last modified) */
  age: number;
  words: string;
  look: Look;
  thumb: () => ReactNode;
}

const L = (p: Partial<Look>): Look => ({ dark: 0, form: 0, chart: 0, list: 0, cards: 0, picture: 0, map: 0, control: 0, ...p });

// ---- the thumbnails (design content, their own colours) ----
const Phone = ({ bg = "#fff", children }: { bg?: string; children: ReactNode }) => (
  <svg viewBox="0 0 160 120" width="100%" height="100%" aria-hidden="true">
    <rect x="52" y="6" width="56" height="108" rx="6" fill={bg} stroke="#0000000f" />
    {children}
  </svg>
);
const Desk = ({ bg = "#fff", children }: { bg?: string; children: ReactNode }) => (
  <svg viewBox="0 0 160 120" width="100%" height="100%" aria-hidden="true">
    <rect x="14" y="16" width="132" height="88" rx="4" fill={bg} stroke="#0000000f" />
    {children}
  </svg>
);
const Comp = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 160 120" width="100%" height="100%" aria-hidden="true">
    {children}
  </svg>
);
const bar = (x: number, y: number, w: number, h = 4, fill = "#e6e6e6", r = 2) => <rect x={x} y={y} width={w} height={h} rx={r} fill={fill} />;

export const HITS: Hit[] = [
  {
    id: "signin",
    name: "Sign in",
    file: "Tempo — Onboarding",
    kind: "frame",
    age: 2,
    words: "sign in login log in email password form account auth welcome back",
    look: L({ form: 1, control: 0.3 }),
    thumb: () => (
      <Phone>
        {bar(60, 22, 26, 6, "#1e1e1e")}
        {bar(60, 32, 38, 3, "#c4c4c4")}
        <rect x="60" y="46" width="40" height="10" rx="3" fill="#f2f2f2" stroke="#e0e0e0" />
        <rect x="60" y="60" width="40" height="10" rx="3" fill="#f2f2f2" stroke="#e0e0e0" />
        <rect x="60" y="78" width="40" height="11" rx="3" fill="#0d99ff" />
        {bar(66, 98, 28, 3, "#c4c4c4")}
      </Phone>
    ),
  },
  {
    id: "signup",
    name: "Sign up",
    file: "Tempo — Onboarding",
    kind: "frame",
    age: 2,
    words: "sign up register create account email password name form",
    look: L({ form: 1, control: 0.35 }),
    thumb: () => (
      <Phone>
        {bar(60, 18, 30, 6, "#1e1e1e")}
        {[34, 47, 60].map((y) => (
          <rect key={y} x="60" y={y} width="40" height="10" rx="3" fill="#f2f2f2" stroke="#e0e0e0" />
        ))}
        <rect x="60" y="78" width="40" height="11" rx="3" fill="#1e1e1e" />
        {bar(64, 98, 32, 3, "#c4c4c4")}
      </Phone>
    ),
  },
  {
    id: "analytics",
    name: "Analytics — Dark",
    file: "Ledger — Web app",
    kind: "frame",
    age: 6,
    words: "analytics dashboard chart graph line stats metrics revenue dark",
    look: L({ dark: 1, chart: 1, cards: 0.3 }),
    thumb: () => (
      <Desk bg="#16181d">
        {[24, 58, 92].map((x) => (
          <rect key={x} x={x} y="24" width="30" height="16" rx="3" fill="#23262e" />
        ))}
        <rect x="24" y="46" width="112" height="50" rx="3" fill="#1d2027" />
        <path d="M28 86 L44 74 L58 80 L74 62 L90 68 L106 54 L132 60" fill="none" stroke="#7b61ff" strokeWidth="2" />
        <path d="M28 90 L44 84 L58 86 L74 76 L90 80 L106 72 L132 74" fill="none" stroke="#14ae5c" strokeWidth="1.5" opacity="0.8" />
      </Desk>
    ),
  },
  {
    id: "revenue",
    name: "Revenue",
    file: "Ledger — Web app",
    kind: "frame",
    age: 12,
    words: "revenue dashboard bar chart graph month sales light",
    look: L({ chart: 0.9, cards: 0.3 }),
    thumb: () => (
      <Desk>
        {bar(24, 24, 34, 5, "#1e1e1e")}
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <rect key={i} x={28 + i * 13} y={90 - [30, 42, 26, 50, 38, 56, 44, 60][i]} width="8" height={[30, 42, 26, 50, 38, 56, 44, 60][i]} rx="1.5" fill={i === 7 ? "#0d99ff" : "#cfe8ff"} />
        ))}
      </Desk>
    ),
  },
  {
    id: "pricing",
    name: "Pricing",
    file: "Tempo — Website",
    kind: "frame",
    age: 4,
    words: "pricing plans cards subscription free pro team monthly",
    look: L({ cards: 1, control: 0.2 }),
    thumb: () => (
      <Desk>
        {bar(58, 24, 44, 5, "#1e1e1e")}
        {[24, 62, 100].map((x, i) => (
          <g key={x}>
            <rect x={x} y="38" width="34" height="56" rx="4" fill={["#e5f4ff", "#f1e8ff", "#ffeedb"][i]} />
            {bar(x + 5, 46, 14, 4, "#1e1e1e")}
            {bar(x + 5, 56, 20, 7, "#1e1e1e")}
            <rect x={x + 5} y="80" width="24" height="7" rx="2" fill={["#0d99ff", "#9747ff", "#ffa629"][i]} />
          </g>
        ))}
      </Desk>
    ),
  },
  {
    id: "profile",
    name: "Profile",
    file: "Tempo — App",
    kind: "frame",
    age: 9,
    words: "profile user avatar account followers stats bio",
    look: L({ picture: 0.4, list: 0.4 }),
    thumb: () => (
      <Phone>
        <circle cx="80" cy="30" r="10" fill="#ffc7c2" />
        {bar(68, 46, 24, 4, "#1e1e1e")}
        {[60, 77, 94].map((x) => <g key={x}>{bar(x - 4, 58, 12, 6, "#e6e6e6")}</g>)}
        {[72, 84, 96].map((y) => <g key={y}>{bar(60, y, 40, 7, "#f2f2f2")}</g>)}
      </Phone>
    ),
  },
  {
    id: "settings",
    name: "Settings",
    file: "Tempo — App",
    kind: "frame",
    age: 20,
    words: "settings preferences toggles switches notifications list",
    look: L({ list: 1, control: 0.6 }),
    thumb: () => (
      <Phone>
        {bar(60, 18, 26, 5, "#1e1e1e")}
        {[32, 46, 60, 74, 88].map((y, i) => (
          <g key={y}>
            {bar(60, y + 2, 22, 3, "#8c8c8c")}
            <rect x="88" y={y} width="12" height="7" rx="3.5" fill={i % 2 ? "#e0e0e0" : "#14ae5c"} />
          </g>
        ))}
      </Phone>
    ),
  },
  {
    id: "checkout",
    name: "Checkout",
    file: "Verda — Shop",
    kind: "frame",
    age: 3,
    words: "checkout cart payment order summary total pay card form",
    look: L({ form: 0.6, list: 0.5, control: 0.3 }),
    thumb: () => (
      <Phone>
        {bar(60, 18, 28, 5, "#1e1e1e")}
        {[30, 44].map((y) => (
          <g key={y}>
            <rect x="60" y={y} width="10" height="10" rx="2" fill="#cfe9d6" />
            {bar(74, y + 2, 22, 3, "#8c8c8c")}
          </g>
        ))}
        <rect x="60" y="62" width="40" height="10" rx="3" fill="#f2f2f2" stroke="#e0e0e0" />
        {bar(60, 80, 40, 3, "#c4c4c4")}
        <rect x="60" y="94" width="40" height="11" rx="3" fill="#2f6f4f" />
      </Phone>
    ),
  },
  {
    id: "map",
    name: "Stores near you",
    file: "Verda — Shop",
    kind: "frame",
    age: 30,
    words: "map stores location pins nearby directions",
    look: L({ map: 1, picture: 0.4 }),
    thumb: () => (
      <Phone bg="#e9f1e4">
        <path d="M52 40 L108 30 M52 70 L108 86 M70 6 L78 114" stroke="#fff" strokeWidth="5" />
        {[[70, 44], [92, 64], [64, 84]].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="4" fill="#f24822" stroke="#fff" strokeWidth="1.5" />
        ))}
        <rect x="56" y="92" width="48" height="18" rx="4" fill="#fff" />
      </Phone>
    ),
  },
  {
    id: "onboarding",
    name: "Welcome",
    file: "Tempo — Onboarding",
    kind: "frame",
    age: 1,
    words: "welcome onboarding illustration get started intro calendar",
    look: L({ picture: 1, control: 0.2 }),
    thumb: () => (
      <Phone>
        <rect x="58" y="14" width="44" height="34" rx="4" fill="#ece8ff" />
        <rect x="64" y="22" width="32" height="18" rx="2" fill="#fff" />
        {bar(64, 22, 32, 4, "#6d5dfc", 2)}
        {bar(60, 56, 36, 5, "#1e1e1e")}
        {bar(60, 66, 40, 3, "#c4c4c4")}
        <rect x="60" y="96" width="40" height="11" rx="3" fill="#1e1e1e" />
      </Phone>
    ),
  },
  {
    id: "player",
    name: "Now playing",
    file: "Wave — Music",
    kind: "frame",
    age: 15,
    words: "music player audio now playing album dark controls",
    look: L({ dark: 1, picture: 0.8, control: 0.5 }),
    thumb: () => (
      <Phone bg="#121212">
        <rect x="58" y="16" width="44" height="44" rx="4" fill="#ff7262" />
        <circle cx="80" cy="38" r="12" fill="#ffb3a7" />
        {bar(60, 68, 30, 4, "#ffffff")}
        {bar(60, 82, 40, 2, "#3a3a3a")}
        <circle cx="80" cy="98" r="7" fill="#fff" />
      </Phone>
    ),
  },
  {
    id: "inbox",
    name: "Inbox",
    file: "Ledger — Web app",
    kind: "frame",
    age: 7,
    words: "inbox messages email list unread conversations",
    look: L({ list: 1 }),
    thumb: () => (
      <Desk>
        <rect x="14" y="16" width="34" height="88" fill="#f5f5f5" />
        {[26, 42, 58, 74, 90].map((y) => (
          <g key={y}>
            <circle cx="58" cy={y} r="4" fill="#d9d9d9" />
            {bar(66, y - 4, 50, 3, "#1e1e1e")}
            {bar(66, y + 1, 70, 3, "#c4c4c4")}
          </g>
        ))}
      </Desk>
    ),
  },
  {
    id: "button",
    name: "Button / Primary",
    file: "Tempo — Design system",
    kind: "component",
    age: 5,
    words: "button primary cta action call to action",
    look: L({ control: 1 }),
    thumb: () => (
      <Comp>
        <rect x="44" y="46" width="72" height="28" rx="7" fill="#0d99ff" />
        {bar(62, 58, 36, 4, "#ffffff")}
      </Comp>
    ),
  },
  {
    id: "toggle",
    name: "Toggle",
    file: "Tempo — Design system",
    kind: "component",
    age: 5,
    words: "toggle switch on off setting control",
    look: L({ control: 1, list: 0.3 }),
    thumb: () => (
      <Comp>
        <rect x="58" y="47" width="44" height="26" rx="13" fill="#14ae5c" />
        <circle cx="89" cy="60" r="10" fill="#fff" />
      </Comp>
    ),
  },
  {
    id: "avatar",
    name: "Avatar",
    file: "Tempo — Design system",
    kind: "component",
    age: 5,
    words: "avatar user profile photo person",
    look: L({ picture: 0.6 }),
    thumb: () => (
      <Comp>
        <circle cx="80" cy="60" r="22" fill="#ffc7c2" />
        <circle cx="80" cy="54" r="8" fill="#fff" opacity="0.8" />
        <path d="M66 74 Q80 62 94 74" fill="#fff" opacity="0.8" />
      </Comp>
    ),
  },
  {
    id: "linechart",
    name: "Chart / Line",
    file: "Ledger — Design system",
    kind: "component",
    age: 11,
    words: "chart line graph trend data",
    look: L({ chart: 1 }),
    thumb: () => (
      <Comp>
        <rect x="30" y="30" width="100" height="60" rx="4" fill="#fff" stroke="#e6e6e6" />
        <path d="M36 80 L56 66 L72 72 L92 50 L108 58 L124 42" fill="none" stroke="#0d99ff" strokeWidth="2.5" />
      </Comp>
    ),
  },
  {
    id: "password",
    name: "Input / Password",
    file: "Tempo — Design system",
    kind: "component",
    age: 5,
    words: "input field password text form secure",
    look: L({ form: 0.9, control: 0.5 }),
    thumb: () => (
      <Comp>
        <rect x="30" y="47" width="100" height="26" rx="6" fill="#fff" stroke="#d9d9d9" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <circle key={i} cx={42 + i * 9} cy="60" r="2.5" fill="#1e1e1e" />
        ))}
      </Comp>
    ),
  },
];

/** What a word looks like to the image model (CLIP's text side): the visual traits it points at */
const SEEN: Record<string, Partial<Look>> = {
  dark: { dark: 1 },
  night: { dark: 1 },
  black: { dark: 1 },
  chart: { chart: 1 },
  graph: { chart: 1 },
  analytics: { chart: 0.8 },
  dashboard: { chart: 0.7, cards: 0.3 },
  form: { form: 1 },
  login: { form: 1 },
  signin: { form: 1 },
  password: { form: 0.8 },
  list: { list: 1 },
  messages: { list: 0.8 },
  cards: { cards: 1 },
  pricing: { cards: 1 },
  plans: { cards: 0.8 },
  map: { map: 1 },
  location: { map: 0.9 },
  photo: { picture: 1 },
  picture: { picture: 1 },
  illustration: { picture: 1 },
  album: { picture: 0.8 },
  button: { control: 1 },
  switch: { control: 0.9 },
  toggle: { control: 0.9 },
};

const KEYS = Object.keys(L({})) as (keyof Look)[];
const norm = (v: number[]) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const vec = (l: Look) => norm(KEYS.map((k) => l[k]));
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export interface Ranked {
  hit: Hit;
  score: number;
  image: number;
  text: number;
  exact: boolean;
}

/** A text query: exact names first (the store's tiers), then 0.6 · image + 0.4 · text, a floor of 0.12. */
export function searchText(query: string, sort: "relevance" | "modified"): Ranked[] {
  const q = fold(query);
  if (!q) return [];
  const words = q.split(" ");
  const seen: Partial<Look> = {};
  for (const w of words) for (const [k, v] of Object.entries(SEEN[w] ?? {})) seen[k as keyof Look] = Math.max(seen[k as keyof Look] ?? 0, v as number);
  const qv = Object.keys(seen).length ? vec(L(seen)) : null;
  const out = HITS.map((hit) => {
    const name = fold(hit.name);
    const tier = name === q || fold(hit.name.split("/").pop() ?? "") === q ? 2 : words.every((w) => name.includes(w)) ? 1 : 0;
    const bag = ` ${fold(hit.words)} ${name} `;
    const text = words.filter((w) => bag.includes(` ${w}`)).length / words.length;
    const image = qv ? Math.max(0, dot(qv, vec(hit.look))) : text * 0.6;
    const score = 0.6 * image + 0.4 * text;
    return { hit, score: tier ? 1 + tier + score : score, image, text, exact: tier > 0 };
  }).filter((r) => r.exact || r.score >= 0.12);
  out.sort((a, b) => b.score - a.score);
  if (sort === "modified") {
    const top = out.slice(0, 50);
    top.sort((a, b) => a.hit.age - b.hit.age);
    return top;
  }
  return out;
}

/** Find more like: the selection's image vector against every image's (the layer itself left out). */
export function searchLike(id: string): Ranked[] {
  const from = HITS.find((h) => h.id === id);
  if (!from) return [];
  const v = vec(from.look);
  return HITS.filter((h) => h.id !== id)
    .map((hit) => {
      const image = Math.max(0, dot(v, vec(hit.look)));
      return { hit, score: image, image, text: 0, exact: false };
    })
    .filter((r) => r.score >= 0.12)
    .sort((a, b) => b.score - a.score);
}
