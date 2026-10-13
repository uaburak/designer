// Studio (docs/studio.md §2, §5, §6), watch-only: the manager takes "Verda's Root Tonic needs a post and a story",
// reads the library, asks which image model to use (the app's own ManagerCard choice card), hands frames and pictures
// to several agents at once (the app's own TaskCards: Queued / Running / Done, "Claude Code · Sonnet 5.5", "Gemini API ·
// Nano Banana Pro", credits), the post and the story land on the canvas, the review card lists what's wrong with boxes
// on the thumbnails, and "Fix selected" starts the fixes. The cards render with a scripted stand-in for the chat's
// service (vite.config.ts SHIMS); Verda and Root Tonic are fictional.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/ds/icons/Icon";
import { cx } from "@/ds/util/cx";
import type { ProviderInfo } from "@shared/agents/types";
import type { ChatCard, ReviewReport, TaskState } from "@shared/studio/types";
import { toolLabel, type AgentsService, type ChatTask } from "@/editor/agents/service";
import { ManagerCard, TaskCard } from "@/editor/panels/agents/StudioCards";
import agents from "@/editor/panels/agents/Agents.module.css";
import { SceneCanvas, SceneWindow } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { World, useFit } from "./shared";
import ag from "./agents.module.css";
import styles from "./studio.module.css";

const PROVIDERS = [{ id: "claude-code", kind: "claude-code", label: "Claude Code", available: true, models: ["sonnet"] }] as ProviderInfo[];
const CLAUDE = { providerId: "claude-code", model: "claude-sonnet-5-5" };
const PRO = { providerId: "gemini-images", model: "gemini-3-pro-image-preview" };
const MANAGER = { providerId: "claude-code", model: "claude-haiku-5-5" };

const CHOICE = {
  kind: "choice",
  disabled: ["openai-images|"],
  id: "card-model",
  question: "Which image model should make the pictures?",
  remember: true,
  options: [
    { id: "gemini-images|gemini-3-pro-image-preview", label: "Gemini API › Nano Banana Pro", detail: "Best text and detail" },
    { id: "gemini-images|gemini-2.5-flash-image", label: "Gemini API › Nano Banana", detail: "Quick" },
    { id: "gemini-cli|", label: "Gemini CLI" },
    { id: "antigravity|", label: "Antigravity" },
    { id: "openai-images|", label: "OpenAI Images", detail: "Add an OpenAI API key in Settings › AI" },
  ],
} as ChatCard;
const REPORT: ReviewReport = {
  briefId: "brief-1",
  items: [
    {
      nodeId: "post",
      name: "Root Tonic — Post v1",
      ok: false,
      problems: [
        { id: "p1", kind: "sharp-text", detail: "“Root Tonic” reads “Root Tonc”", box: { x: 420, y: 780, width: 260, height: 90 }, fix: "fix-label" },
        { id: "p2", kind: "soft-text", detail: "the ingredients came out as readable words", box: { x: 430, y: 900, width: 230, height: 120 }, fix: "blur" },
      ],
    },
    { nodeId: "story", name: "Root Tonic — Story v1", ok: true, problems: [] },
  ],
};

type Step = { name: string; done: boolean };
interface Chat {
  steps: Step[];
  text: string[];
  card: ChatCard | null;
  tasks: ChatTask[];
  review: ChatCard | null;
  steps2: Step[];
  fixes: ChatTask[];
  last: string | null;
  frames: { post: number; story: number };
  fixed: boolean;
}
const EMPTY: Chat = { steps: [], text: [], card: null, tasks: [], review: null, steps2: [], fixes: [], last: null, frames: { post: 0, story: 0 }, fixed: false };

const task = (id: string, kind: ChatTask["kind"], title: string, route: ChatTask["route"]): ChatTask => ({ id, chatId: "c", messageId: "m", kind, title, route, state: "queued", dependsOn: [] });

/** A frame's thumbnail for the review card: the post as an SVG (the label typo until it is fixed). */
function thumb(id: string, fixed: boolean): string {
  const story = id === "story";
  const h = story ? 1920 : 1350;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6efe0"/><stop offset="1" stop-color="#b9cfae"/></linearGradient></defs><rect width="1080" height="${h}" fill="url(#g)"/><rect x="400" y="${h - 900}" width="280" height="560" rx="40" fill="#2f5d45"/><rect x="460" y="${h - 980}" width="160" height="100" rx="20" fill="#1f3f2f"/><rect x="420" y="${h - 570}" width="240" height="90" rx="8" fill="#f4efe2"/><text x="540" y="${h - 512}" font-family="Inter,sans-serif" font-size="44" font-weight="700" text-anchor="middle" fill="#2f5d45">${fixed || story ? "Root Tonic" : "Root Tonc"}</text><text x="80" y="160" font-family="Inter,sans-serif" font-size="96" font-weight="700" fill="#1f2a22">Roots first.</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export default function StudioScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [chat, setChat] = useState<Chat>(EMPTY);
  const ref = useRef(chat);
  ref.current = chat;
  const set = (fn: (c: Chat) => Chat) => setChat((c) => (ref.current = fn(c)));
  const scale = useFit(areaRef, 2300, 2040, { pad: 20, min: 0.05 });
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [chat]);

  const service = useMemo(
    () =>
      ({
        get: () => ({ providers: PROVIDERS }),
        stopTask: () => undefined,
        cardOpen: () => true,
        answerCard: (id: string, answer: unknown) =>
          set((c) => (c.card?.id === id ? { ...c, card: { ...c.card, answer } as ChatCard } : c.review?.id === id ? { ...c, review: { ...c.review, answer } as ChatCard } : c)),
        thumbnail: (nodeId: string) => Promise.resolve(thumb(nodeId, ref.current.fixed)),
        frameSize: (nodeId: string) => (nodeId === "story" ? { width: 1080, height: 1920 } : { width: 1080, height: 1350 }),
      }) as unknown as AgentsService,
    [],
  );

  const { cursor } = useDemo(rootRef, (r) => demo(r, set, service), { onStart: () => set(() => EMPTY) });
  const all = [...chat.tasks, ...chat.fixes];

  return (
    <SceneWindow ref={rootRef} title="Verda — Social">
      <div className={ag.body}>
        <aside className={ag.chatPanel} aria-label="Agents">
          <div className={ag.tabHeader}>
            <span className={ag.tabTitle}>Agents</span>
          </div>
          <div className={agents.chat}>
            <div ref={scrollRef} className={cx(agents.scroll, styles.scroll)}>
              {chat.steps.length > 0 && (
                <>
                  <div className={agents.user}>
                    <div className={agents.userBubble}>Verda’s Root Tonic needs a post and a story</div>
                  </div>
                  <div className={agents.agent}>
                    <span className={agents.agentName}>Manager</span>
                    <Steps steps={chat.steps} />
                    {chat.text.map((t) => (
                      <div key={t} className={agents.agentText}>
                        <p className={agents.para}>{t}</p>
                      </div>
                    ))}
                    {chat.card && <ManagerCard card={chat.card} service={service} />}
                    {chat.tasks.length > 0 && (
                      <div className={agents.tasks}>
                        {chat.tasks.map((t) => (
                          <TaskCard key={t.id} task={t} service={service} />
                        ))}
                      </div>
                    )}
                    {chat.steps2.length > 0 && <Steps steps={chat.steps2} />}
                    {chat.review && <ManagerCard key={chat.review.id} card={chat.review} service={service} />}
                    {chat.fixes.length > 0 && (
                      <div className={agents.tasks}>
                        {chat.fixes.map((t) => (
                          <TaskCard key={t.id} task={t} service={service} />
                        ))}
                      </div>
                    )}
                    {chat.last && (
                      <div className={agents.agentText}>
                        <p className={agents.para}>{chat.last}</p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </aside>
        <SceneCanvas className={ag.canvas}>
          <div ref={areaRef} className={ag.area}>
            <World w={2300} h={2040} scale={scale}>
              <Frame id="post" x={0} h={1350} stage={chat.frames.post} fixed={chat.fixed} scale={scale} />
              <Frame id="story" x={1220} h={1920} stage={chat.frames.story} fixed scale={scale} />
            </World>
          </div>
          <span className={styles.running}>{all.filter((t) => t.state === "running").length ? `${all.filter((t) => t.state === "running").length} running` : ""}</span>
          <DemoCursor cursor={cursor} />
        </SceneCanvas>
      </div>
    </SceneWindow>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  const active = steps.some((s) => !s.done);
  const last = steps[steps.length - 1];
  return (
    <div className={agents.stepGroup}>
      <div className={agents.groupHeader}>
        <span className={cx(agents.groupIcon, active && agents.groupIconActive)}>
          <Icon name="24.agents" />
        </span>
        <span className={cx(agents.groupLabel, active && agents.thinkingText)}>{active ? "Thinking…" : toolLabel(last.name)}</span>
      </div>
      <div className={agents.groupSteps}>
        {steps.map((s, i) => (
          <div key={i} className={agents.tool}>
            <span className={agents.toolIcon}>{s.done ? <Icon name="16.check" /> : <Icon name="24.recent" />}</span>
            <span className={agents.toolLabel}>{toolLabel(s.name)}</span>
            <code className={ag.toolName}>{s.name}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A post / story frame: 0 nothing, 1 the agent's frame (text and logo on grey), 2 the picture in it. */
function Frame({ id, x, h, stage, fixed, scale }: { id: string; x: number; h: number; stage: number; fixed: boolean; scale: number }) {
  if (!stage) return null;
  const story = id === "story";
  return (
    <div className={styles.frame} style={{ left: x, top: 100, height: h }} data-stage={stage}>
      <span className={styles.label} style={{ transform: `translateY(-100%) scale(${1 / scale})` }}>
        Root Tonic — {story ? "Story" : "Post"} v1
      </span>
      <div className={styles.picture} data-on={stage >= 2 || undefined}>
        <div className={styles.bottle} style={{ top: h - 980 }}>
          <span className={styles.cap} />
          <span className={styles.body} />
          <span className={styles.tag} data-fixed={fixed || undefined}>
            {fixed ? "Root Tonic" : "Root Tonc"}
            <small>{fixed ? "▬▬ ▬▬▬ ▬▬" : "Kelp, humic acid, amino"}</small>
          </span>
        </div>
      </div>
      <div className={styles.head}>Roots first.</div>
      <div className={styles.sub}>Feed the soil, and the rest follows.</div>
      <div className={styles.logo}>verda</div>
    </div>
  );
}

// ---- the loop ----
async function demo(run: SceneRun, set: (fn: (c: Chat) => Chat) => void, service: AgentsService) {
  const w = run.wait;
  const stepIn = async (key: "steps" | "steps2", name: string, ms: number) => {
    set((c) => ({ ...c, [key]: [...c[key], { name, done: false }] }));
    await w(ms);
    set((c) => ({ ...c, [key]: c[key].map((s, i, a) => (i === a.length - 1 ? { ...s, done: true } : s)) }));
  };
  const state = (id: string, s: TaskState, extra: Partial<ChatTask> = {}) =>
    set((c) => {
      const up = (t: ChatTask) => (t.id === id ? { ...t, state: s, ...(s === "running" ? { startedAt: Date.now() - 6000 } : {}), ...extra } : t);
      return { ...c, tasks: c.tasks.map(up), fixes: c.fixes.map(up) };
    });
  await w(700);
  await stepIn("steps", "library_find", 600);
  await stepIn("steps", "library_get", 600);
  await stepIn("steps", "library_missing", 500);
  set((c) => ({ ...c, text: ["Verda and Root Tonic are in the library, with two product photos and the label texts. Which model should make the pictures?"], card: CHOICE }));
  await w(1300);
  await run.click(run.$('[data-choice="gemini-images|gemini-3-pro-image-preview"]'));
  service.answerCard("card-model", { optionId: "gemini-images|gemini-3-pro-image-preview", remember: true });
  await w(600);
  set((c) => ({
    ...c,
    tasks: [
      task("t1", "agent", "Frame: Root Tonic — Post v1", CLAUDE),
      task("t2", "image", "Picture: Root Tonic — Post v1", PRO),
      task("t3", "agent", "Frame: Root Tonic — Story v1", CLAUDE),
      task("t4", "image", "Picture: Root Tonic — Story v1", PRO),
      task("t5", "review", "Review: Root Tonic", MANAGER),
    ],
  }));
  await w(500);
  for (const id of ["t1", "t2", "t3", "t4"]) state(id, "running");
  await w(1500);
  state("t1", "done", { credits: 6 });
  set((c) => ({ ...c, frames: { ...c.frames, post: 1 } }));
  await w(700);
  state("t3", "done", { credits: 5 });
  set((c) => ({ ...c, frames: { ...c.frames, story: 1 } }));
  await w(1300);
  state("t2", "done", { credits: 16 });
  set((c) => ({ ...c, frames: { ...c.frames, post: 2 } }));
  await w(800);
  state("t4", "done", { credits: 16 });
  set((c) => ({ ...c, frames: { ...c.frames, story: 2 } }));
  state("t5", "running");
  await stepIn("steps2", "review", 1100);
  state("t5", "done", { credits: 2 });
  await stepIn("steps2", "report_review", 300);
  set((c) => ({ ...c, review: { kind: "review", id: "card-review", report: REPORT } }));
  await w(2600);
  await run.click(run.$("[data-review-fix]"));
  service.answerCard("card-review", { fix: ["p1", "p2"] });
  set((c) => ({ ...c, fixes: [task("f1", "image", "Fix label: Root Tonic — Post v1", PRO)] }));
  await w(300);
  state("f1", "running");
  await w(2200);
  state("f1", "done", { credits: 16 });
  set((c) => ({ ...c, fixed: true, last: "Fixed the label and blurred the small print on the post. A second review found nothing else: both frames are ready." }));
  run.hide();
  await w(3500);
}
