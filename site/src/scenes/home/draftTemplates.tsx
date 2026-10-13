// First Draft's screens for the scene: a template picked from the prompt's words, laid out as an app screen or a
// website (the kit Auto picks, as the app's autoKit does), each block a named layer. Design content: its colours are
// the draft's own (CSS variables the Make changes controls set).
import type { CSSProperties, ReactNode } from "react";
import styles from "./firstdraft.module.css";

export interface Template {
  id: string;
  name: string;
  title: string;
  subtitle: string;
  cta: string;
  chips: string[];
  items: { label: string; meta: string }[];
  hero: "ring" | "image" | "art" | "stats" | "form";
  /** The suggested accent (the first Make changes preset it matches) */
  accent: string;
}

const T: Template[] = [
  {
    id: "habit",
    name: "Habit tracker",
    title: "Good morning, Sam",
    subtitle: "3 of 5 habits done today",
    cta: "New habit",
    chips: ["M", "T", "W", "T", "F", "S", "S"],
    items: [
      { label: "Drink water", meta: "6 of 8 glasses" },
      { label: "Read 20 pages", meta: "Done at 8:10" },
      { label: "Walk 8,000 steps", meta: "5,240 so far" },
    ],
    hero: "ring",
    accent: "#14804A",
  },
  {
    id: "travel",
    name: "Trips",
    title: "Where to next?",
    subtitle: "Stays picked for you",
    cta: "Book a stay",
    chips: ["Beach", "City", "Mountains"],
    items: [
      { label: "Lisbon, Portugal", meta: "3 nights · $420" },
      { label: "Kyoto, Japan", meta: "5 nights · $910" },
      { label: "Tromsø, Norway", meta: "4 nights · $760" },
    ],
    hero: "image",
    accent: "#0D99FF",
  },
  {
    id: "music",
    name: "Now playing",
    title: "Midnight Drive",
    subtitle: "Neon Coast · Afterglow",
    cta: "Play",
    chips: ["Lyrics", "Queue", "Share"],
    items: [
      { label: "Slow Lights", meta: "Neon Coast · 3:41" },
      { label: "Paper Moon", meta: "Lina Vale · 4:02" },
      { label: "Harbour", meta: "The Tides · 3:15" },
    ],
    hero: "art",
    accent: "#D6336C",
  },
  {
    id: "signup",
    name: "Sign up",
    title: "Create your account",
    subtitle: "Ten calm minutes a day",
    cta: "Sign up",
    chips: [],
    items: [
      { label: "Name", meta: "Sam Rivera" },
      { label: "Email", meta: "sam@example.com" },
      { label: "Password", meta: "••••••••" },
    ],
    hero: "form",
    accent: "#4F46E5",
  },
  {
    id: "dashboard",
    name: "Dashboard",
    title: "Overview",
    subtitle: "This week",
    cta: "View report",
    chips: ["Week", "Month", "Year"],
    items: [
      { label: "New order #1042", meta: "2 min ago" },
      { label: "Refund approved", meta: "1 h ago" },
      { label: "Payout sent", meta: "Yesterday" },
    ],
    hero: "stats",
    accent: "#E5532D",
  },
];

const WORDS: [RegExp, string][] = [
  [/\b(fitness|habit|workout|health|gym|run|steps)\b/i, "habit"],
  [/\b(travel|trip|hotel|flight|booking|vacation|stay)\b/i, "travel"],
  [/\b(music|song|player|playlist|podcast|album)\b/i, "music"],
  [/\b(sign ?up|log ?in|login|register|account|onboarding|meditation)\b/i, "signup"],
];

export function templateFor(prompt: string): Template {
  for (const [re, id] of WORDS) if (re.test(prompt)) return T.find((t) => t.id === id)!;
  return T.find((t) => t.id === "dashboard")!;
}

export interface Block {
  id: string;
  name: string;
  icon: "16.frame" | "16.text" | "16.image" | "16.rectangle" | "16.instance";
  render: () => ReactNode;
}

function Img({ kind, style }: { kind: Template["hero"]; style?: CSSProperties }) {
  return <span className={styles.img} data-kind={kind} style={style} />;
}

/** The blocks of an app screen, top to bottom (each a layer of the frame). */
export function appBlocks(t: Template): Block[] {
  const blocks: Block[] = [
    { id: "status", name: "Status bar", icon: "16.frame", render: () => <div className={styles.status}><span>9:41</span><span className={styles.battery} /></div> },
    {
      id: "header",
      name: "Header",
      icon: "16.frame",
      render: () => (
        <div className={styles.header}>
          <div>
            <div className={styles.title}>{t.title}</div>
            <div className={styles.subtitle}>{t.subtitle}</div>
          </div>
          {t.hero !== "form" && <span className={styles.avatar} />}
        </div>
      ),
    },
  ];
  if (t.hero === "form") {
    blocks.push({ id: "logo", name: "Logo", icon: "16.rectangle", render: () => <div className={styles.logo} /> });
    blocks.push({
      id: "fields",
      name: "Fields",
      icon: "16.frame",
      render: () => (
        <div className={styles.fields}>
          {t.items.map((i) => (
            <label key={i.label} className={styles.field}>
              <span>{i.label}</span>
              <span className={styles.input}>{i.meta}</span>
            </label>
          ))}
        </div>
      ),
    });
    blocks.push({ id: "button", name: "Button", icon: "16.instance", render: () => <div className={styles.button}>{t.cta}</div> });
    blocks.push({ id: "link", name: "Log in link", icon: "16.text", render: () => <div className={styles.link}>Already have an account? <b>Log in</b></div> });
    return blocks;
  }
  blocks.push({
    id: "hero",
    name: t.hero === "ring" ? "Progress" : t.hero === "image" ? "Featured" : t.hero === "art" ? "Album art" : "Stats",
    icon: t.hero === "stats" || t.hero === "ring" ? "16.frame" : "16.image",
    render: () =>
      t.hero === "ring" ? (
        <div className={styles.card} data-row="">
          <span className={styles.ring} style={{ ["--pct" as string]: "60%" }}>
            <b>60%</b>
          </span>
          <div>
            <div className={styles.cardTitle}>Today</div>
            <div className={styles.meta}>Keep the streak: 12 days</div>
          </div>
        </div>
      ) : t.hero === "image" ? (
        <div className={styles.card} data-flush="">
          <Img kind="image" />
          <div className={styles.cardBody}>
            <div className={styles.cardTitle}>{t.items[0].label}</div>
            <div className={styles.meta}>{t.items[0].meta}</div>
          </div>
        </div>
      ) : t.hero === "art" ? (
        <div className={styles.player}>
          <Img kind="art" style={{ aspectRatio: "1 / 1" }} />
          <div className={styles.progress}>
            <span style={{ width: "38%" }} />
          </div>
          <div className={styles.controls}>
            <span />
            <span data-main="" />
            <span />
          </div>
        </div>
      ) : (
        <div className={styles.stats}>
          <div className={styles.card}>
            <div className={styles.meta}>Revenue</div>
            <div className={styles.big}>$12.4k</div>
          </div>
          <div className={styles.card}>
            <div className={styles.meta}>Orders</div>
            <div className={styles.big}>318</div>
          </div>
          <div className={styles.card} data-wide="">
            <div className={styles.bars}>
              {[40, 64, 52, 80, 70, 92, 60].map((h, i) => (
                <span key={i} style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
        </div>
      ),
  });
  if (t.chips.length)
    blocks.push({
      id: "chips",
      name: t.hero === "ring" ? "Week" : "Filters",
      icon: "16.frame",
      render: () => (
        <div className={styles.chips} data-days={t.hero === "ring" || undefined}>
          {t.chips.map((c, i) => (
            <span key={i} className={styles.chip} data-on={i === (t.hero === "ring" ? 3 : 0) || undefined}>
              {c}
            </span>
          ))}
        </div>
      ),
    });
  blocks.push({
    id: "list",
    name: t.hero === "art" ? "Up next" : t.hero === "stats" ? "Activity" : t.hero === "ring" ? "Habits" : "Stays",
    icon: "16.frame",
    render: () => (
      <div className={styles.list}>
        {t.items.slice(t.hero === "image" ? 1 : 0, t.hero === "art" ? 2 : 3).map((i, k) => (
          <div key={i.label} className={styles.item}>
            {t.hero === "ring" ? <span className={styles.check} data-on={k === 1 || undefined} /> : <span className={styles.thumb} />}
            <div className={styles.itemText}>
              <div className={styles.itemLabel}>{i.label}</div>
              <div className={styles.meta}>{i.meta}</div>
            </div>
          </div>
        ))}
      </div>
    ),
  });
  blocks.push({ id: "button", name: "Button", icon: "16.instance", render: () => <div className={styles.button}>{t.cta}</div> });
  blocks.push({
    id: "tabbar",
    name: "Tab bar",
    icon: "16.frame",
    render: () => (
      <div className={styles.tabbar}>
        <span data-on="" />
        <span />
        <span />
        <span />
      </div>
    ),
  });
  return blocks;
}

/** A website: navigation, the hero with its picture, three cards. */
export function webBlocks(t: Template): Block[] {
  return [
    {
      id: "nav",
      name: "Navigation",
      icon: "16.frame",
      render: () => (
        <div className={styles.nav}>
          <span className={styles.logoSmall} />
          <span className={styles.navLinks}>
            <span>Product</span>
            <span>Pricing</span>
            <span>About</span>
          </span>
          <span className={styles.button} data-small="">
            {t.cta}
          </span>
        </div>
      ),
    },
    {
      id: "hero",
      name: "Hero",
      icon: "16.frame",
      render: () => (
        <div className={styles.webHero}>
          <div>
            <div className={styles.webTitle}>{t.title}</div>
            <div className={styles.subtitle}>{t.subtitle}</div>
            <span className={styles.button} data-small="" data-inline="">
              {t.cta}
            </span>
          </div>
          <Img kind={t.hero === "art" ? "art" : "image"} />
        </div>
      ),
    },
    {
      id: "cards",
      name: "Cards",
      icon: "16.frame",
      render: () => (
        <div className={styles.webCards}>
          {t.items.map((i) => (
            <div key={i.label} className={styles.card}>
              <span className={styles.thumb} />
              <div className={styles.itemLabel}>{i.label}</div>
              <div className={styles.meta}>{i.meta}</div>
            </div>
          ))}
        </div>
      ),
    },
  ];
}
