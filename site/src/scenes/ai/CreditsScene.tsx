// Credits and privacy (docs/ai.md §2.9, §7), watch-only: Settings › AI as the app draws it (AiTab.module.css,
// Settings.module.css; the ds Select, Switch and TextInput) beside the AI balance's usage history. The loop records runs
// with the credits the app's own creditsFor gives them, switches the text route to a local model and the image route
// to a key in the keychain (saying where each one runs), and reaches the monthly limit with "Stop when credits run
// out" on: the app's own sentence.
import { useRef, useState } from "react";
import { Select } from "@/ds/components/Select";
import { Switch } from "@/ds/components/Switch";
import { TextInput } from "@/ds/components/TextInput";
import { AI_ACTION_LABEL, formatCredits } from "@shared/ai/labels";
import { creditsFor, type AiAction } from "@shared/ai/types";
import tab from "@/settings/AiTab.module.css";
import base from "@/settings/Settings.module.css";
import { SceneWindow } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import styles from "./credits.module.css";

const ALLOWANCE = 4250;
const START = 4200;

interface Entry {
  id: number;
  at: string;
  action: AiAction;
  model: string;
  credits: number;
}
const RUNS: Omit<Entry, "id" | "at" | "credits">[] = [
  { action: "make-image", model: "gemini-3-pro-image-preview" },
  { action: "remove-background", model: "isnet" },
  { action: "rename-layers", model: "claude-sonnet-5-5" },
  { action: "add-interactions", model: "claude-sonnet-5-5" },
  { action: "vectorize", model: "tracer" },
  { action: "agent", model: "gpt-oss:20b" },
  { action: "edit-image", model: "gemini-3-pro-image-preview" },
];
const creditsOf = (r: (typeof RUNS)[number]) =>
  creditsFor(r.action, r.action === "make-image" || r.action === "edit-image" ? { model: r.model } : r.action === "remove-background" ? { megapixels: 0.4 } : r.action === "vectorize" ? { colors: 8 } : { input: 9000, output: 1800 });

const TEXT_WHERE: Record<string, string> = {
  auto: "The first connected agent: here, the claude CLI on this computer, signed in with your plan.",
  "claude-code": "The claude CLI on this computer, signed in with your plan.",
  ollama: "A model running in Ollama on this computer. Nothing leaves it.",
};
const IMAGE_WHERE: Record<string, string> = {
  antigravity: "Antigravity with your Google AI plan. No key needed.",
  "gemini-images": "The Gemini API with your key, read from your system keychain.",
};
const MODELS = [
  ["ISNet", "Remove background, Isolate", "88 MB", true],
  ["Swin2SR x4", "Boost resolution", "55 MB", true],
  ["LaMa", "Erase", "93 MB", false],
  ["CLIP ViT-B/32", "Visual search", "156 MB", true],
  ["all-MiniLM-L6-v2", "Visual search", "24 MB", true],
] as const;

export default function CreditsScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [used, setUsed] = useState(START);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState("auto");
  const [image, setImage] = useState("antigravity");
  const [stop, setStop] = useState(true);
  const [blocked, setBlocked] = useState(false);

  const reset = () => {
    setUsed(START);
    setEntries([]);
    setText("auto");
    setImage("antigravity");
    setStop(true);
    setBlocked(false);
  };
  const { cursor } = useDemo(rootRef, (r) => demo(r, { setUsed, setEntries, setText, setImage, setStop, setBlocked }), { onStart: reset });
  const remaining = Math.max(0, ALLOWANCE - used);
  const share = Math.min(1, used / ALLOWANCE);

  return (
    <SceneWindow ref={rootRef} title="Settings">
      <div className={styles.body}>
        <section className={styles.settings} aria-label="Settings › AI">
          <div className={styles.crumb}>Settings › AI</div>
          <div className={base.section}>
            <div className={styles.heading}>AI balance</div>
            <div className={tab.meter}>
              <p className={tab.meterText}>{`${formatCredits(used)} of ${formatCredits(ALLOWANCE)} credits used this month`}</p>
              <div className={tab.bar}>
                <div className={tab.fill} data-full={remaining <= 0 || undefined} style={{ width: `${share * 100}%` }} />
              </div>
              <p className={tab.caption}>{`${formatCredits(remaining)} credits remaining · Resets November 1`}</p>
            </div>
            <div className={tab.row}>
              <span className={tab.rowText}>
                <span>Monthly credits</span>
                <span className={tab.caption}>Credits you can use each month.</span>
              </span>
              <TextInput className={tab.credits} label="Monthly credits" value="4,250" onCommit={() => undefined} />
            </div>
            <div className={tab.row}>
              <span className={tab.rowText}>
                <span>Stop when credits run out</span>
                <span className={tab.caption}>AI features stop until your credits reset. Turned off, you're only warned.</span>
              </span>
              <Switch size="large" label="Stop when credits run out" checked={stop} onChange={setStop} />
            </div>
            {blocked && <p className={styles.alert} role="alert">You’ve used all 4,250 AI credits for this month. They reset on November 1.</p>}
          </div>
          <hr className={base.divider} />
          <div className={base.section}>
            <div className={styles.heading}>Providers</div>
            <div className={tab.row}>
              <span className={tab.rowText}>
                <span>Text</span>
                <span key={text} className={`${tab.caption} ${styles.where}`}>{TEXT_WHERE[text]}</span>
              </span>
              <Select
                label="Text provider"
                value={text}
                width={150}
                options={[{ value: "auto", label: "Automatic" }, "-", { value: "claude-code", label: "Claude Code" }, { value: "codex", label: "Codex" }, { value: "ollama", label: "Ollama" }, { value: "lmstudio", label: "LM Studio" }]}
                onChange={setText}
              />
            </div>
            <div className={tab.row}>
              <span className={tab.rowText}>
                <span>Images</span>
                <span key={image} className={`${tab.caption} ${styles.where}`}>{IMAGE_WHERE[image]}</span>
              </span>
              <Select
                label="Image provider"
                value={image}
                width={150}
                options={[{ value: "antigravity", label: "Antigravity" }, { value: "gemini-images", label: "Gemini API" }, { value: "openai-images", label: "OpenAI Images", hint: "Needs a key" }]}
                onChange={setImage}
              />
            </div>
            <div className={tab.row}>
              <span className={tab.rowText}>
                <span>Gemini API key</span>
                <span className={tab.caption}>Saved in your keychain</span>
              </span>
            </div>
          </div>
          <hr className={base.divider} />
          <div className={base.section}>
            <div className={styles.heading}>Local models</div>
            <ul className={tab.models}>
              {MODELS.map(([label, use, size, ready]) => (
                <li key={label} className={tab.model}>
                  <span className={tab.rowText}>
                    <span>{label}</span>
                    <span className={tab.caption}>{`${use} · ${size}`}</span>
                  </span>
                  <span className={tab.caption}>{ready ? "Downloaded" : "Not downloaded"}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <section className={styles.ledger} aria-label="AI balance">
          <div className={styles.heading}>Usage history</div>
          <table className={tab.history}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Feature</th>
                <th>Model</th>
                <th className={tab.num}>Credits</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} data-ok="" className={styles.row}>
                  <td>{e.at}</td>
                  <td>{AI_ACTION_LABEL[e.action]}</td>
                  <td className={tab.muted}>{e.model}</td>
                  <td className={tab.num}>{formatCredits(e.credits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!entries.length && <p className={tab.caption}>No AI used yet today.</p>}
          <p className={styles.promise}>Your prompts, files and pictures go only to the providers above. Wecra has no AI server of its own.</p>
        </section>
      </div>
      <DemoCursor cursor={cursor} />
    </SceneWindow>
  );
}

type Set = {
  setUsed: (f: (n: number) => number) => void;
  setEntries: (f: (e: Entry[]) => Entry[]) => void;
  setText: (v: string) => void;
  setImage: (v: string) => void;
  setStop: (v: boolean) => void;
  setBlocked: (v: boolean) => void;
};

async function demo(run: SceneRun, s: Set) {
  let used = START;
  let n = 0;
  const record = async (i: number) => {
    const r = RUNS[i];
    const c = creditsOf(r);
    used += c;
    s.setUsed(() => used);
    s.setEntries((e) => [{ ...r, id: ++n, at: `Oct 14, ${["9:12", "9:40", "10:05", "10:31", "11:02", "11:26", "11:58", "12:20"][n % 8]}`, credits: c }, ...e].slice(0, 9));
    await run.wait(900);
  };
  await run.wait(800);
  await record(0);
  await record(1);
  await record(2);
  s.setText("ollama");
  await run.wait(1600);
  await record(5);
  s.setImage("gemini-images");
  await run.wait(1600);
  await record(6);
  await record(4);
  await record(3);
  s.setBlocked(used >= ALLOWANCE);
  await run.wait(2600);
  s.setStop(false);
  s.setBlocked(false);
  await run.wait(2400);
}
