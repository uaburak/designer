/**
 * Settings › AI (docs/ai.md §7; ours — Figma's AI has no settings of its own, it runs on Figma's servers): AI on or
 * off; the AI balance (the month's credits against "Monthly credits", which the owner can raise, and "Stop when
 * credits run out", on by default — §10.3); the text and image providers and per-feature overrides; the optional
 * OpenAI / Gemini image keys (kept in the keychain by main, `ai:set-image-key`); the local models with their sizes and
 * download state (`ai:models`; downloads are 6b's); and "Index files for visual search". Every change is saved at
 * once through main (`ai:set-settings`), as Figma's settings are.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { Button, Select, Switch, TextInput, showToast, type SelectEntry } from "@/ds";
import type { ProviderInfo } from "@shared/agents/types";
import { AI_ACTION_LABEL, AI_IMAGE_ACTIONS, AI_TEXT_ACTIONS, formatCredits } from "@shared/ai/labels";
import type { AiAction, AiModelId, AiModelInfo, AiModelState, AiRoute, AiSettings, ImageRouteInfo } from "@shared/ai/types";
import { BalanceMeter, loadAiBalance, openAiBalance, type BalanceView } from "./AiBalance";
import { agentSetupBridge, aiSetupBridge } from "./bridge";
import base from "./Settings.module.css";
import styles from "./AiTab.module.css";
import { intlLocale, t, useT } from "@/i18n";

/** The image providers (docs/ai.md §2.5; Antigravity the default — §10.1) until main's `ai:image-routes` answers (docs/studio.md §2.4: their models and whether each can run come from there) */
const IMAGE_PROVIDERS: { id: string; label: string; key?: "openai" | "gemini" }[] = [
  { id: "antigravity", label: "Antigravity" },
  { id: "gemini-cli", label: "Gemini CLI" },
  { id: "openai-images", label: "OpenAI Images", key: "openai" },
  { id: "gemini-images", label: "Gemini API", key: "gemini" },
];
const AUTO = "";
const SAME = "";

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const mb = (bytes: number) => `${(bytes / 1_000_000).toLocaleString(intlLocale(), { maximumFractionDigits: 1 })} MB`;

export function AiTab(): JSX.Element {
  useT();
  const ai = useMemo(() => aiSetupBridge(), []);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [balance, setBalance] = useState<BalanceView | null>(null);
  const [models, setModels] = useState<{ info: AiModelInfo[]; state: AiModelState[] } | null | "unavailable">(null);

  useEffect(() => {
    let live = true;
    if (ai)
      ai.settings().then(
        (s) => live && setSettings(s),
        () => {},
      );
    agentSetupBridge()
      ?.providers()
      .then(
        (p) => live && setProviders(p),
        () => {},
      );
    if (ai)
      ai.models().then(
        (m) => live && setModels(m),
        () => live && setModels("unavailable"),
      );
    const off = ai?.onModelState((s) => setModels((m) => (m && m !== "unavailable" ? { ...m, state: [...m.state.filter((x) => x.id !== s.id), s] } : m)));
    return () => {
      live = false;
      off?.();
    };
  }, [ai]);

  // The image routes follow the keys (a Gemini key makes the Gemini API available)
  const [imageRoutes, setImageRoutes] = useState<ImageRouteInfo[] | null>(null);
  const keys = settings ? `${settings.imageKeys.openai}${settings.imageKeys.gemini}` : "";
  useEffect(() => {
    let live = true;
    ai?.imageRoutes?.().then(
      (r) => live && setImageRoutes(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [ai, keys]);

  // The balance follows the monthly credits
  const monthly = settings?.monthlyCredits;
  useEffect(() => {
    let live = true;
    loadAiBalance(monthly).then(
      (v) => live && setBalance(v),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [monthly]);

  if (!ai)
    return (
      <div className={base.page}>
        <p className={`${base.text} ${base.muted}`}>{t("AI runs in the desktop app.")}</p>
      </div>
    );
  if (!settings) return <div className={base.page} />;

  const save = (patch: Partial<Omit<AiSettings, "imageKeys">>) => {
    setSettings({ ...settings, ...patch });
    ai.setSettings(patch).then(setSettings, (e: unknown) => {
      showToast({ kind: "error", message: message(e, t("Couldn’t save your AI settings")) });
      void ai.settings().then(setSettings, () => {});
    });
  };
  const off = !settings.enabled;

  // ---- routes ----
  const textProviders = providers;
  const textOptions: SelectEntry[] = [{ value: AUTO, label: t("Automatic") }, "-", ...textProviders.map((p) => ({ value: p.id, label: p.label, hint: p.available ? undefined : t("Not available"), disabled: !p.available && settings.text?.providerId !== p.id }))];
  const textProvider = textProviders.find((p) => p.id === settings.text?.providerId);
  const modelOptions: SelectEntry[] = textProvider ? [{ value: AUTO, label: t("Default") }, ...textProvider.models.map((m) => ({ value: m, label: textProvider.modelLabels?.[m] ?? m }))] : [];
  const imageOptions: SelectEntry[] = imageRoutes
    ? imageRoutes.map((r) => ({ value: r.providerId, label: r.label, hint: r.available ? undefined : /key/i.test(r.reason ?? "") ? t("Needs a key") : t("Not available") }))
    : IMAGE_PROVIDERS.map((p) => ({ value: p.id, label: p.label, hint: p.key && !settings.imageKeys[p.key] ? t("Needs a key") : undefined }));
  const imageRoute = imageRoutes?.find((r) => r.providerId === (settings.image?.providerId ?? "antigravity"));
  const imageModelOptions: SelectEntry[] = imageRoute?.models.length ? [{ value: AUTO, label: t("Default") }, ...imageRoute.models.map((m) => ({ value: m.id, label: m.label, hint: m.detail }))] : [];
  const route = (providerId: string, model?: string): AiRoute | null => (providerId ? { providerId, ...(model ? { model } : {}) } : null);
  const actionRoute = (a: AiAction, providerId: string) => {
    const actions = { ...settings.actions };
    if (providerId) actions[a] = { providerId };
    else delete actions[a];
    save({ actions });
  };

  return (
    <div className={base.page} data-settings-ai="">
      <section className={base.section} aria-labelledby="ai-features">
        <h3 id="ai-features" className={base.heading}>{t("AI features")}</h3>
        <div className={styles.row}>
          <span className={styles.rowText}>
            <span>{t("Use AI features")}</span>
            <span className={styles.caption}>{t("Actions, image tools, visual search and agents. Turned off, nothing is sent to an AI provider.")}</span>
          </span>
          <Switch size="large" label={t("Use AI features")} checked={settings.enabled} onChange={(on) => save({ enabled: on })} data-ai-setting="enabled" />
        </div>
      </section>

      <hr className={base.divider} />
      <section className={base.section} aria-labelledby="ai-balance">
        <h3 id="ai-balance" className={base.heading}>{t("AI balance")}</h3>
        {balance && <BalanceMeter view={balance} />}
        <button type="button" className={`${base.link} ${styles.gap}`} onClick={openAiBalance} data-ai-open-balance="">
          {t("See usage")}
        </button>
        <div className={styles.row}>
          <span className={styles.rowText}>
            <span>{t("Monthly credits")}</span>
            <span className={styles.caption}>{t("Credits you can use each month. Figma's Full seat comes with {credits}.", { credits: formatCredits(4250) })}</span>
          </span>
          <TextInput
            className={styles.credits}
            label={t("Monthly credits")}
            value={String(settings.monthlyCredits)}
            onCommit={(v) => {
              const n = Math.round(Number(v.replace(/[,\s]/g, "")));
              if (Number.isFinite(n) && n >= 0 && n <= 10_000_000) save({ monthlyCredits: n });
              else showToast({ kind: "error", message: t("Enter a number of credits from 0 to 10,000,000.") });
            }}
            data-ai-setting="monthlyCredits"
          />
        </div>
        <div className={styles.row}>
          <span className={styles.rowText}>
            <span>{t("Stop when credits run out")}</span>
            <span className={styles.caption}>{t("AI features stop until your credits reset. Turned off, you're only warned.")}</span>
          </span>
          <Switch size="large" label={t("Stop when credits run out")} checked={settings.stopAtLimit} onChange={(on) => save({ stopAtLimit: on })} data-ai-setting="stopAtLimit" />
        </div>
      </section>

      <hr className={base.divider} />
      <section className={base.section} aria-labelledby="ai-providers">
        <h3 id="ai-providers" className={base.heading}>{t("Providers")}</h3>
        <div className={styles.row}>
          <span className={styles.rowText}>
            <span>{t("Text")}</span>
            <span className={styles.caption}>{t("Rename layers, writing, Add interactions and First Draft. Automatic uses the first connected agent.")}</span>
          </span>
          <span className={styles.controls}>
            <Select label={t("Text provider")} value={settings.text?.providerId ?? AUTO} options={textOptions} disabled={off} onChange={(v) => save({ text: route(v) })} width={160} data-ai-setting="text" />
            {textProvider && modelOptions.length > 1 && <Select label={t("Text model")} value={settings.text?.model ?? AUTO} options={modelOptions} disabled={off} onChange={(v) => save({ text: route(textProvider.id, v) })} width={140} data-ai-setting="textModel" />}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.rowText}>
            <span>{t("Images")}</span>
            <span className={styles.caption}>{t("Make an image, Edit image with prompt and Expand.")}</span>
          </span>
          <span className={styles.controls}>
            <Select label={t("Image provider")} value={settings.image?.providerId ?? "antigravity"} options={imageOptions} disabled={off} onChange={(v) => save({ image: v === "antigravity" ? null : route(v) })} width={160} data-ai-setting="image" />
            {imageRoute && imageModelOptions.length > 1 && <Select label={t("Image model")} value={settings.image?.model ?? AUTO} options={imageModelOptions} disabled={off} onChange={(v) => save({ image: route(imageRoute.providerId, v) })} width={160} data-ai-setting="imageModel" />}
          </span>
        </div>
        <details className={styles.overrides}>
          <summary>{t("Provider for each feature")}</summary>
          {[...AI_TEXT_ACTIONS, ...AI_IMAGE_ACTIONS].map((a) => {
            const image = AI_IMAGE_ACTIONS.includes(a);
            const options: SelectEntry[] = [{ value: SAME, label: image ? t("Same as Images") : t("Same as Text") }, "-", ...(image ? imageOptions : textOptions.slice(2))];
            return (
              <div key={a} className={styles.override} data-ai-action={a}>
                <span>{t(AI_ACTION_LABEL[a])}</span>
                <Select label={t("{feature} provider", { feature: t(AI_ACTION_LABEL[a]) })} value={settings.actions[a]?.providerId ?? SAME} options={options} disabled={off} onChange={(v) => actionRoute(a, v)} width={160} />
              </div>
            );
          })}
        </details>
      </section>

      <hr className={base.divider} />
      <section className={base.section} aria-labelledby="ai-keys">
        <h3 id="ai-keys" className={base.heading}>{t("Image API keys")}</h3>
        <p className={`${base.text} ${base.muted}`}>{t("Optional. Antigravity makes and edits images with your Google AI plan; a key lets OpenAI or Gemini do it instead.")}</p>
        <ImageKey provider="openai" label={t("OpenAI API key")} has={settings.imageKeys.openai} onSaved={setSettings} />
        <ImageKey provider="gemini" label={t("Gemini API key")} has={settings.imageKeys.gemini} onSaved={setSettings} />
      </section>

      <hr className={base.divider} />
      <section className={base.section} aria-labelledby="ai-models">
        <h3 id="ai-models" className={base.heading}>{t("Local models")}</h3>
        <p className={`${base.text} ${base.muted}`}>{t("Remove background, Boost resolution, Erase, Isolate and visual search run on this computer. Each model downloads the first time it's needed.")}</p>
        {models === null ? null : models === "unavailable" ? (
          <p className={`${styles.caption} ${styles.gap}`} data-ai-models="unavailable">{t("Local models aren't available in this version yet.")}</p>
        ) : (
          <ul className={styles.models} data-ai-models="">
            {models.info.map((m) => (
              <ModelRow key={m.id} info={m} state={models.state.find((s) => s.id === m.id)} />
            ))}
          </ul>
        )}
        <div className={styles.row}>
          <span className={styles.rowText}>
            <span>{t("Index files for visual search")}</span>
            <span className={styles.caption}>{t("Frames and components of the files you open are indexed on this computer.")}</span>
          </span>
          <Switch size="large" label={t("Index files for visual search")} checked={settings.indexForSearch} disabled={off} onChange={(on) => save({ indexForSearch: on })} data-ai-setting="indexForSearch" />
        </div>
      </section>
    </div>
  );
}

function ImageKey({ provider, label, has, onSaved }: { provider: "openai" | "gemini"; label: string; has: boolean; onSaved: (s: AiSettings) => void }) {
  useT();
  const [draft, setDraft] = useState("");
  const ai = aiSetupBridge()!;
  const set = (key: string | null) =>
    ai.setImageKey(provider, key).then(
      (s) => {
        onSaved(s);
        setDraft("");
        showToast({ message: key ? t("Key saved") : t("Key removed") });
      },
      (e: unknown) => showToast({ kind: "error", message: message(e, t("Couldn’t save the key")) }),
    );
  return (
    <div className={styles.row} data-ai-key={provider}>
      <span className={styles.rowText}>
        <span>{label}</span>
        <span className={styles.caption}>{has ? t("Saved in your keychain") : t("Not set")}</span>
      </span>
      <span className={styles.controls}>
        {has ? (
          <Button variant="secondary" onClick={() => void set(null)}>
            {t("Remove key")}
          </Button>
        ) : (
          <>
            <TextInput className={styles.key} label={label} secret value={draft} placeholder={t("Paste a key")} onChange={setDraft} />
            <Button variant="secondary" disabled={!draft.trim()} onClick={() => void set(draft.trim())}>
              {t("Save")}
            </Button>
          </>
        )}
      </span>
    </div>
  );
}

function ModelRow({ info, state }: { info: AiModelInfo; state?: AiModelState }) {
  useT();
  const ai = aiSetupBridge()!;
  const s = state?.state ?? "absent";
  const run = (fn: (id: AiModelId) => Promise<AiModelState>, failed: string) => void fn(info.id).catch((e: unknown) => showToast({ kind: "error", message: message(e, failed) }));
  const status =
    s === "ready" ? t("Downloaded") : s === "downloading" ? t("Downloading… {percent}%", { percent: state?.received && info.bytes ? Math.floor((state.received / info.bytes) * 100) : 0 }) : s === "error" ? (state?.error ?? t("Download failed")) : t("Not downloaded");
  return (
    <li className={styles.model} data-ai-model={info.id} data-state={s}>
      <span className={styles.rowText}>
        <span>{info.label}</span>
        <span className={styles.caption}>{`${info.use} · ${mb(info.bytes)} · ${info.license}`}</span>
      </span>
      <span className={s === "error" ? styles.error : styles.caption}>{status}</span>
      {s === "ready" ? (
        <Button variant="secondary" onClick={() => run((id) => ai.modelRemove(id), t("Couldn’t remove the model"))}>
          {t("Remove")}
        </Button>
      ) : (
        <Button variant="secondary" disabled={s === "downloading"} onClick={() => run((id) => ai.modelDownload(id), t("Couldn’t download the model"))}>
          {t("Download")}
        </Button>
      )}
    </li>
  );
}
