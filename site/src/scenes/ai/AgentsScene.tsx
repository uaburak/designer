// Agents and MCP (docs/ai.md §2.10–2.11; the Agents panel): the app's chat — its CSS (Agents.module.css), its model
// menu (editor/agents/models.ts over the agents' real ids and aliases), its grouping of steps (activity.ts
// segmentsOf, the thinking line) and its step labels — next to a canvas the agent builds on. A request runs the real
// tool names in order (get_selection, get_variable_defs, create_nodes, set_auto_layout, apply_variable,
// get_screenshot, set_selection) while the frame lands; "/" lists Skills; a connector's tool asks first (Allow once /
// Always allow / Deny). Each answer's changes are one undo step. The agents' words are written here (no model runs on
// the site); the shapes of the turns are the app's.
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, IconButton } from "@/ds/components/Button";
import { Select } from "@/ds/components/Select";
import { Spinner } from "@/ds/components/Spinner";
import { Icon } from "@/ds/icons/Icon";
import { tooltipProps } from "@/ds/overlay/TooltipManager";
import { cx } from "@/ds/util/cx";
import type { ProviderInfo } from "@shared/agents/types";
import { segmentsOf, toolActiveLabel } from "@/editor/agents/activity";
import { currentOf, effortMenu, MODEL_SEP, modelMenu, type ResolvedModels } from "@/editor/agents/models";
import { toolLabel, type MessagePart } from "@/editor/agents/service";
import agents from "@/editor/panels/agents/Agents.module.css";
import { SceneCanvas, SceneWindow, Selection, boxIn, type Box } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { World, useFit, useJobs, type Wait } from "./shared";
import styles from "./agents.module.css";

// ---- the agents on this computer (their ids, kinds and aliases as main lists them) ----
const PROVIDERS: ProviderInfo[] = [
  { id: "claude-code", kind: "claude-code", label: "Claude Code", available: true, models: ["opus", "sonnet", "haiku"], efforts: ["high", "low", "medium", "xhigh", "max"] },
  { id: "codex", kind: "codex", label: "Codex", available: true, models: ["default"] },
  { id: "antigravity", kind: "antigravity", label: "Antigravity (Google AI)", available: true, models: ["gemini-3.8-flash-medium", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.1-pro-high", "gemini-3.1-pro-low"] },
  { id: "cursor-agent", kind: "cursor-agent", label: "Cursor Agent", available: true, models: ["auto"] },
  { id: "ollama", kind: "openai-compatible", label: "Ollama", available: true, models: ["gpt-oss:20b", "qwen3-coder:30b"] },
  { id: "lmstudio", kind: "openai-compatible", label: "LM Studio", available: true, models: ["qwen/qwen3-coder-30b"] },
];
const RESOLVED: ResolvedModels = { "claude-code": { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" } };

const SKILLS = [
  { name: "brand-voice", description: "Write in Verda’s voice: warm, plain, short" },
  { name: "accessibility-check", description: "Check contrast, sizes and labels" },
  { name: "handoff-notes", description: "Write notes for developers on the selection" },
];

// ---- the chat ----
type Msg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; provider: string; parts: MessagePart[]; state: "running" | "done" | "stopped"; startedAt: number; changes?: { count: number; state: "applied" | "undone" }; credits?: number; consent?: boolean };

type Build = "signup" | "login" | "pricing" | "products";
interface Canvas {
  build: Build | null;
  /** 0 none · 1 frame · 2 layers (unplaced) · 3 auto layout · 4 variables · 5 done */
  phase: number;
  voice: boolean;
  flash: number;
}
const EMPTY: Canvas = { build: null, phase: 0, voice: false, flash: 0 };

const uid = () => Math.random().toString(36).slice(2, 9);

export default function AgentsScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [choice, setChoice] = useState({ providerId: "claude-code", model: "sonnet", effort: "medium" });
  const [slashActive, setSlashActive] = useState(0);
  const [canvas, setCanvas] = useState<Canvas>(EMPTY);
  const [history, setHistory] = useState<Canvas[]>([]);
  const [consent, setConsent] = useState<null | ((a: "once" | "always" | "deny") => void)>(null);
  const [always, setAlways] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const jobs = useJobs();
  const running = msgs.some((m) => m.role === "assistant" && m.state === "running");

  const provider = PROVIDERS.find((p) => p.id === choice.providerId)!;
  const { option, effort } = currentOf(provider, choice.model, choice.effort, RESOLVED);
  const efforts = effortMenu(option);

  // ---- the canvas ----
  const worldW = canvas.build === "pricing" || canvas.build === "products" ? 720 : 390;
  const worldH = canvas.build === "pricing" || canvas.build === "products" ? 470 : 760;
  const scale = useFit(areaRef, worldW, worldH, { pad: 36, max: 0.9 });
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const measure = () => setBox(canvas.phase >= 5 ? boxIn(area.querySelector("[data-built]"), area) : null);
    measure();
    const t = setTimeout(measure, 450);
    return () => clearTimeout(t);
  }, [canvas, scale]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // ---- a turn ----
  const patch = (id: string, fn: (m: Extract<Msg, { role: "assistant" }>) => Extract<Msg, { role: "assistant" }>) => setMsgs((list) => list.map((m) => (m.id === id && m.role === "assistant" ? fn(m) : m)));
  const step = async (id: string, wait: Wait, name: string, ms: number, then?: () => void) => {
    const sid = uid();
    patch(id, (m) => ({ ...m, parts: [...m.parts, { kind: "tool", id: sid, name, state: "running" }] }));
    await wait(ms);
    then?.();
    patch(id, (m) => ({ ...m, parts: m.parts.map((p) => (p.kind === "tool" && p.id === sid ? { ...p, state: "done" } : p)) }));
  };
  const say = (id: string, t: string) => patch(id, (m) => ({ ...m, parts: [...m.parts, { kind: "text", text: t }] }));

  const send = (raw = text) => {
    const t = raw.trim();
    if (!t || running) return;
    setText("");
    const id = uid();
    const who = provider.kind === "openai-compatible" ? `${provider.label} · ${option?.label ?? ""}` : provider.label;
    setMsgs((list) => [...list, { id: uid(), role: "user", text: t }, { id, role: "assistant", provider: who, parts: [], state: "running", startedAt: Date.now() }]);
    const lower = t.toLowerCase();
    void jobs.start(async (wait) => {
      await wait(700);
      if (/linear|issue|ticket/.test(lower)) {
        await step(id, wait, "get_selection", 500);
        await step(id, wait, "get_screenshot", 700);
        let answer: "once" | "always" | "deny" = "once";
        if (!always) {
          patch(id, (m) => ({ ...m, consent: true }));
          answer = await new Promise((res) => setConsent(() => res));
          setConsent(null);
          patch(id, (m) => ({ ...m, consent: false }));
          if (answer === "always") setAlways(true);
        }
        if (answer === "deny") {
          patch(id, (m) => ({ ...m, parts: [...m.parts, { kind: "tool", id: uid(), name: "linear__create_issue", state: "error", summary: "You denied this tool." }] }));
          say(id, "Okay, I didn’t file it.");
        } else {
          await step(id, wait, "linear__create_issue", 1100);
          say(id, "Filed **WEB-142 Review the sign-up copy** in Linear, with a screenshot of the frame.");
        }
        patch(id, (m) => ({ ...m, state: "done", credits: 3 }));
        return;
      }
      if (t.startsWith("/brand-voice") || /voice|rewrite|copy|headline/.test(lower)) {
        if (!canvas.build) {
          await step(id, wait, "get_selection", 500);
          say(id, "There’s nothing on the page yet. Ask me for a screen first, then I’ll write its copy in Verda’s voice.");
          patch(id, (m) => ({ ...m, state: "done", credits: 1 }));
          return;
        }
        await step(id, wait, "get_selection", 500);
        await step(id, wait, "get_metadata", 600);
        await step(id, wait, "update_nodes", 1100, () => {
          setHistory((h) => [...h, canvas]);
          setCanvas((c) => ({ ...c, voice: true }));
        });
        say(id, "Rewrote the headline and the line under it with **/brand-voice**: warm, plain and short.");
        patch(id, (m) => ({ ...m, state: "done", changes: { count: 2, state: "applied" }, credits: 2 }));
        return;
      }
      if (/what|which|\?$/.test(lower) && !/design|make|create|build/.test(lower)) {
        await step(id, wait, "get_metadata", 800);
        say(id, canvas.build ? "This page has one frame, **" + nameOf(canvas.build) + "**, in auto layout, with its fills on the Verda variables." : "This page is empty. Verda’s variables and styles are in the file, ready to use.");
        patch(id, (m) => ({ ...m, state: "done", credits: 1 }));
        return;
      }
      const build: Build = /\bpric|\bplans?\b/.test(lower) ? "pricing" : /product|grid|catalog|listing|shop page/.test(lower) ? "products" : /log ?in|sign ?in/.test(lower) ? "login" : "signup";
      setHistory((h) => [...h, canvas]);
      await step(id, wait, "get_selection", 450);
      await step(id, wait, "get_variable_defs", 650);
      await step(id, wait, "create_nodes", 1300, () => setCanvas({ build, phase: 2, voice: false, flash: 0 }));
      await step(id, wait, "set_auto_layout", 900, () => setCanvas((c) => ({ ...c, phase: 3 })));
      await step(id, wait, "apply_variable", 700, () => setCanvas((c) => ({ ...c, phase: 4 })));
      await step(id, wait, "get_screenshot", 650, () => setCanvas((c) => ({ ...c, flash: c.flash + 1 })));
      await step(id, wait, "set_selection", 300, () => setCanvas((c) => ({ ...c, phase: 5 })));
      say(id, ANSWER[build]);
      patch(id, (m) => ({ ...m, state: "done", changes: { count: COUNT[build], state: "applied" }, credits: 12 }));
    });
  };

  const stop = () => {
    jobs.cancel();
    consent?.("deny");
    setMsgs((list) => list.map((m) => (m.role === "assistant" && m.state === "running" ? { ...m, state: "stopped", parts: m.parts.filter((p) => !(p.kind === "tool" && p.state === "running")) } : m)));
  };

  const undoTurn = (id: string) => {
    const prev = history[history.length - 1];
    if (prev) {
      setCanvas(prev);
      setHistory((h) => h.slice(0, -1));
    }
    patch(id, (m) => (m.changes ? { ...m, changes: { ...m.changes, state: "undone" } } : m));
  };

  // ---- the composer: / lists skills ----
  const slash = /(^|\s)\/([a-z-]*)$/.exec(text);
  const matches = slash ? SKILLS.filter((s) => s.name.startsWith(slash[2])) : [];
  const pickSkill = (name: string) => {
    const next = text.replace(/(^|\s)\/[a-z-]*$/, (_, sp: string) => `${sp}/${name} `);
    setText(next);
    setSlashActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        return setSlashActive((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return pickSkill(matches[Math.min(slashActive, matches.length - 1)].name);
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const reset = () => {
    jobs.cancel();
    setMsgs([]);
    setText("");
    setCanvas(EMPTY);
    setHistory([]);
    setConsent(null);
    setAlways(false);
    setChoice({ providerId: "claude-code", model: "sonnet", effort: "medium" });
  };
  const api = { setText, send, answer: (a: "once" | "always" | "deny") => consent?.(a) };
  const apiRef = useRef(api);
  apiRef.current = api;
  const { cursor } = useDemo(rootRef, (r) => demo(r, apiRef), { onStart: reset });

  return (
    <SceneWindow ref={rootRef} title="Verda — Website">
      <div className={styles.body}>
        <aside className={styles.chatPanel} aria-label="Agents">
          <div className={styles.tabHeader}>
            <span className={styles.tabTitle}>Agents</span>
            <IconButton icon="24.plus.small" label="New chat" tone="secondary" onClick={reset} />
          </div>
          <div className={agents.chat}>
            <div ref={scrollRef} className={agents.scroll} data-messages="">
              {!msgs.length ? (
                <div className={agents.intro}>
                  <span className={agents.introIcon}>
                    <Icon name="24.agents" />
                  </span>
                  <p className={agents.introTitle}>What should we design?</p>
                  <p className={agents.introBody}>Agents on this computer read and edit this file. Select a frame and ask — every reply’s changes are one undo step.</p>
                  <div className={agents.suggestions}>
                    {["Design a login screen for a mobile app", "What's on this page?"].map((s) => (
                      <button key={s} type="button" className={agents.suggestion} onClick={() => send(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                msgs.map((m) =>
                  m.role === "user" ? (
                    <div key={m.id} className={agents.user} data-message="user">
                      <div className={agents.userBubble}>{m.text}</div>
                    </div>
                  ) : (
                    <AgentMessage key={m.id} m={m} onUndo={() => undoTurn(m.id)} />
                  ),
                )
              )}
              {consent && (
                <div className={agents.consent} role="alertdialog" aria-label="Linear wants to use create_issue" data-consent="">
                  <p className={agents.consentTitle}>Linear wants to use create_issue</p>
                  <pre className={agents.consentArgs}>{JSON.stringify({ team: "WEB", title: "Review the sign-up copy", description: "Screenshot of “Sign up” attached." }, null, 1)}</pre>
                  <div className={agents.actions}>
                    <Button variant="primary" onClick={() => consent("once")} data-consent-once="">
                      Allow once
                    </Button>
                    <Button variant="secondary" onClick={() => consent("always")}>
                      Always allow
                    </Button>
                    <Button variant="secondary" onClick={() => consent("deny")}>
                      Deny
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <div className={agents.composer} data-composer="">
              {canvas.phase >= 5 && (
                <div className={agents.chips}>
                  <span className={agents.chip} {...tooltipProps(canvas.build === "pricing" || canvas.build === "products" ? "1440 × 900" : "390 × 844")}>
                    <Icon name="16.frame" />
                    <span className={agents.chipName}>{nameOf(canvas.build!)}</span>
                  </span>
                </div>
              )}
              {matches.length > 0 && (
                <div className={agents.slashList} role="listbox" aria-label="Skills" data-slash-list="">
                  {matches.map((s, i) => (
                    <button key={s.name} type="button" role="option" aria-selected={i === slashActive} className={agents.slashItem} data-active={i === slashActive || undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => pickSkill(s.name)} data-skill={s.name}>
                      <span className={agents.slashName}>/{s.name}</span>
                      <span className={agents.slashDesc}>{s.description}</span>
                    </button>
                  ))}
                </div>
              )}
              <textarea ref={inputRef} className={agents.input} value={text} rows={2} placeholder={msgs.length ? "Reply…" : "Describe a design or a change"} aria-label="Message" onChange={(e) => setText(e.target.value)} onKeyDown={onKey} data-agents-input="" />
              <div className={agents.composerBar}>
                <span className={agents.plus}>
                  <button type="button" className={agents.barButton} aria-label="Add" {...tooltipProps("Add files, skills and connectors")} onClick={() => setText((t) => (t.endsWith("/") ? t : `${t}${t && !t.endsWith(" ") ? " " : ""}/`))}>
                    <Icon name="24.plus.small" />
                  </button>
                </span>
                <span className={agents.barGap} />
                <Select
                  label="Model"
                  variant="ghost"
                  width="hug"
                  value={`${provider.id}${MODEL_SEP}${option?.key ?? ""}`}
                  options={modelMenu(PROVIDERS, RESOLVED)}
                  onChange={(v) => {
                    const [pid, key] = v.split(MODEL_SEP);
                    const p = PROVIDERS.find((x) => x.id === pid)!;
                    const pick = currentOf(p, key, undefined, RESOLVED);
                    setChoice({ providerId: pid, model: pick.effort?.model && p.kind === "antigravity" ? pick.effort.model : key, effort: pick.effort?.id ?? "" });
                  }}
                  className={cx(agents.menu, agents.modelMenu)}
                  data-model-menu=""
                />
                {efforts.length > 0 && option && (
                  <Select
                    label="Effort"
                    variant="ghost"
                    width="hug"
                    value={effort?.id ?? ""}
                    options={efforts}
                    onChange={(id) => {
                      const e = option.efforts.find((x) => x.id === id);
                      if (e) setChoice((c) => ({ ...c, model: e.model, effort: id }));
                    }}
                    className={agents.menu}
                  />
                )}
                {running ? (
                  <button type="button" className={cx(agents.send, agents.stop)} aria-label="Stop" {...tooltipProps("Stop")} onClick={stop}>
                    <span className={agents.stopGlyph} />
                  </button>
                ) : (
                  <button type="button" className={agents.send} aria-label="Send" {...tooltipProps("Send", "↩")} disabled={!text.trim()} onClick={() => send()} data-agents-send="">
                    <Icon name="16.arrow.up" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </aside>
        <SceneCanvas className={styles.canvas}>
          <div ref={areaRef} className={styles.area}>
            {canvas.build ? (
              <World w={worldW} h={worldH} scale={scale}>
                <Design c={canvas} />
              </World>
            ) : (
              <div className={styles.empty}>
                <span>Verda — Website</span>
                <span className={styles.emptyNote}>Variables: Verda/Green, Verda/Cream, Verda/Ink · Text styles: Display, Body</span>
              </div>
            )}
            {box && <Selection box={box} instant label={canvas.build === "pricing" || canvas.build === "products" ? "1440 × 900" : "390 × 844"} />}
            {canvas.flash > 0 && <div key={canvas.flash} className={styles.flash} />}
          </div>
          <DemoCursor cursor={cursor} />
        </SceneCanvas>
      </div>
    </SceneWindow>
  );
}

const nameOf = (b: Build) => ({ signup: "Sign up", login: "Log in", pricing: "Pricing", products: "Shop — Plants" })[b];
const COUNT: Record<Build, number> = { signup: 9, login: 8, pricing: 16, products: 14 };
const ANSWER: Record<Build, string> = {
  signup: "I made **Sign up** (390 × 844): a picture, the headline, two fields and a button, in vertical auto layout with a 16 gap. The button uses **Verda/Green**. It’s selected; Undo takes the whole reply back.",
  login: "I made **Log in** (390 × 844) in vertical auto layout: the headline, email and password fields and the button on **Verda/Green**. It’s selected.",
  pricing: "I made **Pricing** (1440 × 900): three plan cards in horizontal auto layout, the middle one highlighted with **Verda/Green**. It’s selected.",
  products: "I made **Shop — Plants** (1440 × 900): a header and four product cards in a wrapping auto layout, prices in the Body style. It’s selected.",
};

function AgentMessage({ m, onUndo }: { m: Extract<Msg, { role: "assistant" }>; onUndo: () => void }) {
  const segs = segmentsOf(m);
  return (
    <div className={agents.agent} data-message="assistant" data-state={m.state}>
      <span className={agents.agentName}>{m.provider}</span>
      {segs.map((s) => (s.kind === "text" ? <div key={s.key} className={agents.agentText}>{renderText(s.text)}</div> : <StepGroup key={s.key} label={s.label} active={s.active} steps={s.kind === "steps" || s.kind === "image" ? s.steps : []} />))}
      {m.state === "stopped" && <div className={agents.stopped}>Stopped</div>}
      {m.changes && (
        <div className={agents.changes} data-changes={m.changes.state}>
          <span className={agents.changesLabel}>{m.changes.state === "undone" ? "Undone" : `Changed ${m.changes.count} layers`}</span>
          {m.changes.state === "applied" && (
            <Button variant="secondary" onClick={onUndo} data-turn-undo="">
              Undo
            </Button>
          )}
        </div>
      )}
      {m.credits !== undefined && m.state !== "running" && (
        <span className={agents.credits} aria-label={`${m.credits} AI credits`} {...tooltipProps(`${m.credits} AI ${m.credits === 1 ? "credit" : "credits"}`)}>
          <Icon name="16.sparkle" />
        </span>
      )}
    </div>
  );
}

/** A run of steps as one row (the app's StepGroup): open here, so the tools show; the thinking line while it runs. */
function StepGroup({ label, active, steps }: { label: string; active: boolean; steps: Extract<MessagePart, { kind: "tool" }>[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={agents.stepGroup} data-group-state={active ? "running" : "done"}>
      <button type="button" className={agents.groupHeader} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={cx(agents.groupIcon, active && agents.groupIconActive)} aria-hidden="true">
          <Icon name="24.agents" />
        </span>
        <span className={cx(agents.groupLabel, active && agents.thinkingText)}>{label}</span>
        {steps.length > 0 && (
          <span className={cx(agents.groupChevron, open && agents.groupChevronOpen)}>
            <Icon name="16.chevron.down" />
          </span>
        )}
      </button>
      {open && steps.length > 0 && (
        <div className={agents.groupSteps}>
          {steps.map((p) => (
            <div key={p.id} className={agents.tool} data-tool={p.name} data-tool-state={p.state} {...tooltipProps(p.summary)}>
              <span className={agents.toolIcon}>{p.state === "running" ? <Spinner size={16} /> : p.state === "error" ? <Icon name="16.warning" /> : <Icon name="16.check" />}</span>
              <span className={agents.toolLabel}>{p.state === "running" ? toolActiveLabel(p.name) : toolLabel(p.name)}</span>
              <code className={styles.toolName}>{p.name}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function renderText(t: string): ReactNode {
  return (
    <p className={agents.para}>
      {t.split(/(\*\*[^*]+\*\*)/).map((seg, i) => (seg.startsWith("**") ? <strong key={i}>{seg.slice(2, -2)}</strong> : <Fragment key={i}>{seg}</Fragment>))}
    </p>
  );
}

/** What the agent builds: Verda's frames, landing as the steps run (design content, its own colours). */
function Design({ c }: { c: Canvas }) {
  const b = c.build!;
  const placed = c.phase >= 3;
  const styled = c.phase >= 4;
  const green = styled ? "#2f6f4f" : "#d9d9d9";
  const scatter = (i: number) => (placed ? undefined : { transform: `translate(${[18, -24, 30, -12, 22, -30, 14, -20][i % 8]}px, ${[-14, 20, -26, 12, -8, 24, -18, 10][i % 8]}px) rotate(${[-2, 1.5, -1, 2, -1.5, 1, -2, 1.5][i % 8]}deg)`, opacity: 0.9 });
  if (b === "pricing")
    return (
      <div className={styles.desk} data-built="" data-placed={placed || undefined}>
        <div className={styles.deskTitle} style={scatter(0)}>
          Plans for every plant person
        </div>
        <div className={styles.plans}>
          {[
            ["Seedling", "$0", "Care reminders"],
            ["Grower", "$6", "Reminders, notes and a plant doctor"],
            ["Greenhouse", "$14", "Everything, for the whole family"],
          ].map(([n, p, d], i) => (
            <div key={n} className={styles.plan} style={{ ...scatter(i + 1), ...(i === 1 ? { background: styled ? "#2f6f4f" : "#e6e6e6", color: styled ? "#fff" : undefined } : {}) }}>
              <span className={styles.planName}>{n}</span>
              <span className={styles.planPrice}>{p}<small>/mo</small></span>
              <span className={styles.planNote}>{d}</span>
              <span className={styles.planButton} style={{ background: i === 1 ? "#fff" : green, color: i === 1 ? "#2f6f4f" : "#fff" }}>
                Choose
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  if (b === "products")
    return (
      <div className={styles.desk} data-built="" data-placed={placed || undefined}>
        <div className={styles.deskTitle} style={scatter(0)}>
          Plants that forgive you
        </div>
        <div className={styles.products}>
          {[
            ["Monstera", "$38", "#cfe3c4"],
            ["Snake plant", "$24", "#e7dcc6"],
            ["Pothos", "$18", "#d6e7d8"],
            ["Fiddle fig", "$46", "#e9e2cf"],
          ].map(([n, p, bg], i) => (
            <div key={n} className={styles.product} style={scatter(i + 1)}>
              <span className={styles.productArt} style={{ background: styled ? bg : "#e6e6e6" }}>
                <Leaf />
              </span>
              <span className={styles.productName}>{n}</span>
              <span className={styles.productPrice} style={{ color: styled ? "#2f6f4f" : undefined }}>
                {p}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  const login = b === "login";
  return (
    <div className={styles.phone} data-built="" data-placed={placed || undefined}>
      <div className={styles.phoneArt} style={{ ...scatter(0), background: styled ? "#dfe9d8" : "#e6e6e6" }}>
        <Leaf />
      </div>
      <div className={styles.phoneTitle} style={scatter(1)}>
        <span key={String(c.voice)} className={c.voice ? styles.rewritten : undefined}>
          {c.voice ? (login ? "Good to see you again." : "Let’s grow something.") : login ? "Welcome back" : "Grow something good"}
        </span>
      </div>
      <div className={styles.phoneText} style={scatter(2)}>
        <span key={String(c.voice)} className={c.voice ? styles.rewritten : undefined}>
          {c.voice ? "Save your plants. We’ll remind you when they’re thirsty." : "Create an account to save your plants and get care reminders."}
        </span>
      </div>
      {(login ? ["Email", "Password"] : ["Name", "Email", "Password"]).map((f, i) => (
        <div key={f} className={styles.field} style={scatter(i + 3)}>
          {f}
        </div>
      ))}
      <div className={styles.cta} style={{ ...scatter(7), background: green }}>
        {login ? "Log in" : "Create account"}
      </div>
    </div>
  );
}

function Leaf() {
  return (
    <svg viewBox="0 0 100 100" width="56%" height="56%" aria-hidden="true">
      <path d="M50 92 C 50 70, 50 50, 50 20" stroke="#2f6f4f" strokeWidth="3" fill="none" />
      <path d="M50 60 C 20 58, 14 34, 20 22 C 38 24, 50 40, 50 60 Z" fill="#4f8a5b" />
      <path d="M50 44 C 76 42, 86 22, 82 10 C 62 12, 52 26, 50 44 Z" fill="#6aa772" />
    </svg>
  );
}

// ---- the guided demo ---------------------------------------------------------------------------------------------

type Api = { setText: (t: string) => void; send: (t?: string) => void; answer: (a: "once" | "always" | "deny") => void };

async function demo(run: SceneRun, api: { current: Api }) {
  const type = async (t: string, ms = 22) => {
    for (let i = 1; i <= t.length; i++) {
      api.current.setText(t.slice(0, i));
      await run.wait(ms);
    }
  };
  await run.wait(400);
  await run.click(run.$("[data-agents-input]"));
  const ask = "Design a sign up screen for Verda’s plant shop";
  await type(ask);
  await run.wait(300);
  await run.click(run.$("[data-agents-send]"));
  api.current.send(ask);
  await run.wait(7800);
  // A skill
  await run.click(run.$("[data-agents-input]"));
  await type("/br", 120);
  await run.wait(900);
  await run.click(run.$('[data-skill="brand-voice"]'));
  const voice = "/brand-voice rewrite the headline";
  await type(voice, 30);
  await run.wait(300);
  api.current.send(voice);
  await run.wait(4400);
  // A connector, with consent
  const file = "File a Linear issue to review this copy";
  await run.click(run.$("[data-agents-input]"));
  await type(file);
  api.current.send(file);
  await run.wait(2600);
  await run.click(run.$("[data-consent-once]"));
  api.current.answer("once");
  await run.wait(2600);
  run.hide();
  await run.wait(1200);
}
