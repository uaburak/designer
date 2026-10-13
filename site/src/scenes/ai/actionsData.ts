// The Actions scene's file and what its fake runs answer. The layers follow Figma's default names ("Frame 12",
// "Rectangle 4", texts named by their text); Rename layers follows the app's rules (editor/ai/rename.ts): frames,
// rectangles with an image fill and texts are renamed, plain vectors and ellipses are skipped, and repeated layers get
// one name. The answers are written here (the site has no model): what a text route answered when the app ran these
// actions for real (docs/ai.md §3 "Run for real") — the same kind of names and copy.

export type Kind = "FRAME" | "TEXT" | "RECTANGLE" | "IMAGE" | "ELLIPSE" | "VECTOR";

export interface SceneNode {
  id: string;
  kind: Kind;
  /** The default name (texts: none — they are named by their text until renamed) */
  name?: string;
  /** What Rename layers answers (none: skipped by the rules) */
  rename?: string;
  children?: SceneNode[];
}

export const TREE: SceneNode[] = [
  {
    id: "f12",
    kind: "FRAME",
    name: "Frame 12",
    rename: "Welcome",
    children: [
      { id: "r4", kind: "IMAGE", name: "Rectangle 4", rename: "Hero image" },
      { id: "t-title", kind: "TEXT", rename: "Title" },
      { id: "t-body", kind: "TEXT", rename: "Description" },
      { id: "f13", kind: "FRAME", name: "Frame 13", rename: "Button", children: [{ id: "t-cta", kind: "TEXT", rename: "Label" }] },
    ],
  },
  {
    id: "f14",
    kind: "FRAME",
    name: "Frame 14",
    rename: "Team",
    children: [
      { id: "f18", kind: "FRAME", name: "Frame 18", rename: "Back button", children: [{ id: "v1", kind: "VECTOR", name: "Vector" }] },
      { id: "t-team", kind: "TEXT", rename: "Title" },
      ...[1, 2, 3].map((n) => ({
        id: `f${14 + n}`,
        kind: "FRAME" as const,
        name: `Frame ${14 + n}`,
        rename: "Member",
        children: [
          { id: `e${n}`, kind: "ELLIPSE" as const, name: `Ellipse ${n}` },
          { id: `m${n}-name`, kind: "TEXT" as const, rename: "Name" },
          { id: `m${n}-role`, kind: "TEXT" as const, rename: "Role" },
        ],
      })),
    ],
  },
];

export const FIRST_TEXTS: Record<string, string> = {
  "t-title": "Plan your week in minutes",
  "t-body": "Tempo brings your tasks, notes and calendar together in one calm place, so nothing slips through.",
  "t-cta": "Get started",
  "t-team": "Lorem ipsum",
  "m1-name": "Name",
  "m1-role": "Lorem ipsum dolor sit",
  "m2-name": "Name",
  "m2-role": "Lorem ipsum dolor sit",
  "m3-name": "Name",
  "m3-role": "Lorem ipsum dolor sit",
};

/** Shorten's answers */
export const SHORTER: Record<string, string> = {
  "Plan your week in minutes": "Plan your week",
  "Your week, sorted in minutes": "Plan your week",
  "Tempo brings your tasks, notes and calendar together in one calm place, so nothing slips through.": "Tasks, notes and calendar in one calm place.",
  "Your tasks, notes and plans finally live together. Open Tempo and the week sorts itself out.": "Tasks, notes and calendar in one calm place.",
  "One calm place for everything you plan: tasks, notes and your calendar, side by side.": "Tasks, notes and calendar in one calm place.",
  "Tasks, notes and calendar in one calm place.": "Tasks, notes, calendar. One place.",
  "Get started": "Start",
  "Try it free": "Start",
  "Your team": "Team",
  "Lorem ipsum dolor sit": "Lorem ipsum",
  "Lorem ipsum": "Lorem",
};

/** Rewrite this…'s answers, by layer (the body alternates between two) */
export const REWRITES: Record<string, string[]> = {
  "t-title": ["Your week, sorted in minutes"],
  "t-body": [
    "Your tasks, notes and plans finally live together. Open Tempo and the week sorts itself out.",
    "One calm place for everything you plan: tasks, notes and your calendar, side by side.",
  ],
  "t-cta": ["Try it free"],
  "t-team": ["Your team"],
};

/** Replace content's answers: the header and three distinct members (a prompt can steer them) */
export const CONTENT_SETS: { match?: RegExp; header: string; people: [string, string][] }[] = [
  { header: "Your team", people: [["Maya Okafor", "Product designer"], ["Jonas Berg", "iOS engineer"], ["Leyla Demir", "Research lead"]] },
  { match: /turk|türk|istanbul|ankara/i, header: "Your team", people: [["Elif Yılmaz", "Product designer"], ["Can Aydın", "iOS engineer"], ["Deniz Kaya", "Research lead"]] },
  { match: /japan|tokyo|osaka/i, header: "Your team", people: [["Aiko Tanaka", "Product designer"], ["Ren Sato", "iOS engineer"], ["Yui Nakamura", "Research lead"]] },
];

/** Translate to…'s answers: the languages this scene has answers for, in the app's list order. */
export const LANGUAGES = ["English", "Spanish", "French", "German", "Italian", "Portuguese", "Turkish", "Japanese"] as const;
export type Language = (typeof LANGUAGES)[number];

type Row = Record<Exclude<Language, "English">, string>;
const T = (es: string, fr: string, de: string, it: string, pt: string, tr: string, ja: string): Row => ({ Spanish: es, French: fr, German: de, Italian: it, Portuguese: pt, Turkish: tr, Japanese: ja });

export const TRANSLATIONS: Record<string, Row> = {
  "Plan your week in minutes": T("Planifica tu semana en minutos", "Planifiez votre semaine en quelques minutes", "Plane deine Woche in wenigen Minuten", "Pianifica la tua settimana in pochi minuti", "Planeje sua semana em minutos", "Haftanı dakikalar içinde planla", "数分で1週間の計画を"),
  "Plan your week": T("Planifica tu semana", "Planifiez votre semaine", "Plane deine Woche", "Pianifica la tua settimana", "Planeje sua semana", "Haftanı planla", "1週間を計画しよう"),
  "Your week, sorted in minutes": T("Tu semana, organizada en minutos", "Votre semaine, organisée en quelques minutes", "Deine Woche, in Minuten sortiert", "La tua settimana, in ordine in pochi minuti", "Sua semana organizada em minutos", "Haftan, dakikalar içinde düzende", "数分で整う、あなたの1週間"),
  "Tempo brings your tasks, notes and calendar together in one calm place, so nothing slips through.": T(
    "Tempo reúne tus tareas, notas y calendario en un solo lugar tranquilo, para que nada se te escape.",
    "Tempo réunit vos tâches, vos notes et votre agenda dans un seul endroit serein, pour que rien ne vous échappe.",
    "Tempo vereint deine Aufgaben, Notizen und deinen Kalender an einem ruhigen Ort, damit dir nichts entgeht.",
    "Tempo riunisce attività, note e calendario in un unico posto tranquillo, così non ti sfugge niente.",
    "O Tempo reúne suas tarefas, notas e agenda em um só lugar tranquilo, para que nada escape.",
    "Tempo görevlerini, notlarını ve takvimini tek bir sakin yerde toplar; hiçbir şey gözden kaçmaz.",
    "Tempoはタスク、メモ、カレンダーをひとつの落ち着いた場所にまとめるので、もう何も見逃しません。",
  ),
  "Tasks, notes and calendar in one calm place.": T("Tareas, notas y calendario en un solo lugar tranquilo.", "Tâches, notes et agenda dans un seul endroit serein.", "Aufgaben, Notizen und Kalender an einem ruhigen Ort.", "Attività, note e calendario in un unico posto tranquillo.", "Tarefas, notas e agenda em um só lugar tranquilo.", "Görevler, notlar ve takvim tek bir sakin yerde.", "タスク、メモ、カレンダーをひとつの場所に。"),
  "Tasks, notes, calendar. One place.": T("Tareas, notas, calendario. Un solo lugar.", "Tâches, notes, agenda. Un seul endroit.", "Aufgaben, Notizen, Kalender. Ein Ort.", "Attività, note, calendario. Un solo posto.", "Tarefas, notas, agenda. Um só lugar.", "Görevler, notlar, takvim. Tek yer.", "タスク、メモ、カレンダー。ひとつの場所に。"),
  "Your tasks, notes and plans finally live together. Open Tempo and the week sorts itself out.": T(
    "Tus tareas, notas y planes por fin viven juntos. Abre Tempo y la semana se ordena sola.",
    "Vos tâches, notes et projets enfin réunis. Ouvrez Tempo et la semaine s’organise d’elle-même.",
    "Deine Aufgaben, Notizen und Pläne endlich an einem Ort. Öffne Tempo, und die Woche ordnet sich von selbst.",
    "Attività, note e piani finalmente insieme. Apri Tempo e la settimana si organizza da sola.",
    "Suas tarefas, notas e planos finalmente juntos. Abra o Tempo e a semana se organiza sozinha.",
    "Görevlerin, notların ve planların sonunda bir arada. Tempo’yu aç, hafta kendiliğinden düzene girsin.",
    "タスクもメモも予定も、ついにひとつに。Tempoを開けば、1週間が自然と整います。",
  ),
  "One calm place for everything you plan: tasks, notes and your calendar, side by side.": T(
    "Un lugar tranquilo para todo lo que planeas: tareas, notas y tu calendario, uno al lado del otro.",
    "Un endroit serein pour tout ce que vous prévoyez : tâches, notes et agenda, côte à côte.",
    "Ein ruhiger Ort für alles, was du planst: Aufgaben, Notizen und dein Kalender, Seite an Seite.",
    "Un posto tranquillo per tutto ciò che pianifichi: attività, note e calendario, fianco a fianco.",
    "Um lugar tranquilo para tudo o que você planeja: tarefas, notas e sua agenda, lado a lado.",
    "Planladığın her şey için tek bir sakin yer: görevler, notlar ve takvimin yan yana.",
    "計画のすべてをひとつの落ち着いた場所に。タスク、メモ、カレンダーを並べて。",
  ),
  "Get started": T("Empezar", "Commencer", "Los geht’s", "Inizia", "Começar", "Başla", "はじめる"),
  Start: T("Empezar", "Démarrer", "Start", "Avvia", "Iniciar", "Başla", "開始"),
  "Try it free": T("Pruébalo gratis", "Essayer gratuitement", "Kostenlos testen", "Provalo gratis", "Experimente grátis", "Ücretsiz dene", "無料で試す"),
  "Your team": T("Tu equipo", "Votre équipe", "Dein Team", "Il tuo team", "Sua equipe", "Ekibin", "あなたのチーム"),
  Team: T("Equipo", "Équipe", "Team", "Team", "Equipe", "Ekip", "チーム"),
  "Product designer": T("Diseñadora de producto", "Designer produit", "Produktdesignerin", "Product designer", "Designer de produto", "Ürün tasarımcısı", "プロダクトデザイナー"),
  "iOS engineer": T("Ingeniero de iOS", "Ingénieur iOS", "iOS-Entwickler", "Ingegnere iOS", "Engenheiro iOS", "iOS mühendisi", "iOSエンジニア"),
  "Research lead": T("Responsable de investigación", "Responsable de la recherche", "Leiterin Research", "Responsabile della ricerca", "Líder de pesquisa", "Araştırma lideri", "リサーチリード"),
};

/** A text as it reads in a language (names and placeholders stay as they are). */
export function inLanguage(en: string, lang: Language): string {
  if (lang === "English") return en;
  return TRANSLATIONS[en]?.[lang] ?? en;
}

export const allNodes = (nodes: SceneNode[] = TREE): SceneNode[] => nodes.flatMap((n) => [n, ...allNodes(n.children ?? [])]);
export const NODE = new Map(allNodes().map((n) => [n.id, n]));
export const PARENT = new Map(allNodes().flatMap((n) => (n.children ?? []).map((c) => [c.id, n.id] as const)));
export const TEXT_IDS = allNodes()
  .filter((n) => n.kind === "TEXT")
  .map((n) => n.id);

/** The texts under (or at) these layers */
export function textsIn(ids: readonly string[]): string[] {
  const out = new Set<string>();
  const walk = (n: SceneNode) => {
    if (n.kind === "TEXT") out.add(n.id);
    n.children?.forEach(walk);
  };
  for (const id of ids) {
    const n = NODE.get(id);
    if (n) walk(n);
  }
  return [...out];
}

/** The layers Rename layers takes under (or at) these layers, or on the page when nothing is selected */
export function renameCandidates(ids: readonly string[]): SceneNode[] {
  const roots = ids.length ? ids.map((id) => NODE.get(id)!).filter(Boolean) : TREE;
  const out: SceneNode[] = [];
  const walk = (n: SceneNode) => {
    if (n.rename) out.push(n);
    n.children?.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}
