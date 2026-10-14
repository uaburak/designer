// Studio (docs/studio.md §1–§2): "Verda's Root Tonic needs a post and a story". The manager reads the library, asks
// which image model to use (the app's ManagerCard), hands the frames and the pictures to several agents at once (the
// app's TaskCards: Queued, Running, Done, with their routes and credits), and the post and the story land on the
// canvas. The cards render with a scripted stand-in for the chat's service (vite.config.ts SHIMS). Verda and Root
// Tonic are fictional.
import { useMemo, useState } from "react";
import type { ProviderInfo } from "@shared/agents/types";
import type { ChatCard, TaskState } from "@shared/studio/types";
import type { AgentsService, ChatTask } from "@/editor/agents/service";
import { ManagerCard, TaskCard } from "@/editor/panels/agents/StudioCards";
import { Collage, FrameName, Piece } from "../collage/kit";
import { Bottle } from "../home/art";
import type { Run } from "../runtime/motion";
import { agents, AgentText, ChatPanel, Steps, UserMessage, type Step } from "./chat";
import styles from "./ai.module.css";

const PROVIDERS = [{ id: "claude-code", kind: "claude-code", label: "Claude Code", available: true, models: ["sonnet"] }] as ProviderInfo[];
const CLAUDE = { providerId: "claude-code", model: "claude-sonnet-5-5" };
const PRO = { providerId: "gemini-images", model: "gemini-3-pro-image-preview" };

const CHOICE = {
  kind: "choice",
  id: "card-model",
  question: "Which image model should make the pictures?",
  remember: true,
  options: [
    { id: "gemini-images|gemini-3-pro-image-preview", label: "Gemini API › Nano Banana Pro", detail: "Best text and detail" },
    { id: "gemini-images|gemini-2.5-flash-image", label: "Gemini API › Nano Banana", detail: "Quick" },
    { id: "gemini-cli|", label: "Gemini CLI" },
  ],
} as ChatCard;
const ANSWERED = { ...CHOICE, answer: { optionId: "gemini-images|gemini-3-pro-image-preview", remember: true } } as ChatCard;

const task = (id: string, kind: ChatTask["kind"], title: string, route: ChatTask["route"]): ChatTask => ({ id, chatId: "c", messageId: "m", kind, title, route, state: "queued", dependsOn: [] });
const TASKS: ChatTask[] = [
  task("t1", "agent", "Frame: Root Tonic — Post", CLAUDE),
  task("t2", "image", "Picture: Root Tonic — Post", PRO),
  task("t3", "agent", "Frame: Root Tonic — Story", CLAUDE),
  task("t4", "image", "Picture: Root Tonic — Story", PRO),
];

interface Chat {
  asked: boolean;
  steps: Step[];
  card: ChatCard | null;
  tasks: ChatTask[];
  frames: { post: number; story: number };
  done: boolean;
}

export default function StudioCollage() {
  const [chat, setChat] = useState<Chat>({ asked: false, steps: [], card: null, tasks: [], frames: { post: 0, story: 0 }, done: false });
  const set = (fn: (c: Chat) => Chat) => setChat(fn);

  const service = useMemo(
    () =>
      ({
        get: () => ({ providers: PROVIDERS }),
        stopTask: () => undefined,
        cardOpen: () => true,
        answerCard: () => undefined,
      }) as unknown as AgentsService,
    [],
  );

  const script = async (run: Run) => {
    const w = run.wait;
    const step = async (name: string, ms: number) => {
      set((c) => ({ ...c, steps: [...c.steps, { name, done: false }] }));
      await w(ms);
      set((c) => ({ ...c, steps: c.steps.map((s, i, a) => (i === a.length - 1 ? { ...s, done: true } : s)) }));
    };
    const state = (id: string, s: TaskState, extra: Partial<ChatTask> = {}) =>
      set((c) => ({ ...c, tasks: c.tasks.map((t) => (t.id === id ? { ...t, state: s, ...(s === "running" ? { startedAt: Date.now() - 4000 } : {}), ...extra } : t)) }));
    const frame = (k: "post" | "story", v: number) => set((c) => ({ ...c, frames: { ...c.frames, [k]: v } }));

    await w(600);
    set((c) => ({ ...c, asked: true }));
    await w(700);
    await step("library_find", 500);
    await step("library_read_labels", 500);
    set((c) => ({ ...c, card: CHOICE }));
    await w(1400);
    set((c) => ({ ...c, card: ANSWERED }));
    await w(600);
    set((c) => ({ ...c, tasks: TASKS }));
    await w(500);
    for (const id of ["t1", "t2", "t3", "t4"]) state(id, "running");
    await w(1400);
    state("t1", "done", { credits: 6 });
    frame("post", 1);
    await w(600);
    state("t3", "done", { credits: 5 });
    frame("story", 1);
    await w(1200);
    state("t2", "done", { credits: 16 });
    frame("post", 2);
    await w(700);
    state("t4", "done", { credits: 16 });
    frame("story", 2);
    await w(500);
    set((c) => ({ ...c, done: true }));
  };

  return (
    <Collage size={[1000, 600]} focus={[0.31, 0.5]} safe={560} script={script}>
      <Piece surface x={100} y={32} w={340} h={536} d={0} from="left" className={styles.chatPiece}>
        <ChatPanel title="Agents · Manager">
          {chat.asked && <UserMessage>Verda’s Root Tonic needs a post and a story</UserMessage>}
          {chat.steps.length > 0 && (
            <div className={agents.agent}>
              <span className={agents.agentName}>Manager</span>
              <Steps steps={chat.steps} />
              {chat.card && <ManagerCard card={chat.card} service={service} />}
              {chat.tasks.length > 0 && (
                <div className={agents.tasks}>
                  {chat.tasks.map((t) => (
                    <TaskCard key={t.id} task={t} service={service} />
                  ))}
                </div>
              )}
              {chat.done && <AgentText>The post and the story are on the canvas. Their texts match the label.</AgentText>}
            </div>
          )}
        </ChatPanel>
      </Piece>

      <FrameName x={490} y={112} show={chat.frames.post > 0}>
        Root Tonic — Post
      </FrameName>
      <PostFrame x={490} y={112} w={240} h={300} stage={chat.frames.post} />
      <FrameName x={756} y={72} show={chat.frames.story > 0}>
        Root Tonic — Story
      </FrameName>
      <PostFrame x={756} y={72} w={200} h={356} stage={chat.frames.story} story />
    </Collage>
  );
}

/** A post or a story: 0 not there, 1 the agent's frame (text and logo on a placeholder), 2 the picture in it. */
function PostFrame({ x, y, w, h, stage, story }: { x: number; y: number; w: number; h: number; stage: number; story?: boolean }) {
  return (
    <div className={styles.post} data-stage={stage} style={{ left: x, top: y, width: w, height: h }}>
      <div className={styles.postPicture} data-on={stage >= 2 || undefined}>
        <Bottle ground={story ? "#DCE8D3" : "#E6EFE0"} />
      </div>
      <span className={styles.postHead}>Roots first.</span>
      <span className={styles.postSub}>Feed the soil, and the rest follows.</span>
      <span className={styles.postLogo}>verda</span>
    </div>
  );
}
