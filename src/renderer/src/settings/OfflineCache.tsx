/**
 * Settings › Account › Offline cache (docs/cloud.md §2; ours — Figma's desktop app has no such setting): the person's
 * files live on the server and this computer keeps the ones opened, up to a bound (default 5 GB), least recently opened
 * going first. The size used, the bound and Clear cache (files stay listed and download again when opened).
 */
import { useEffect, useState } from "react";
import { Button, Select, showToast } from "@/ds";
import { CACHE_LIMIT_CHOICES, type CacheInfo, type CloudRepository } from "@shared/store/cloud";
import { Section } from "./AccountTab";
import { t, tp, useT } from "@/i18n";
import styles from "./Settings.module.css";

/** "1.2 GB", "340 MB", "12 KB" */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return t("{n} bytes", { n });
}

export function OfflineCache({ cloud }: { cloud: CloudRepository }) {
  useT();
  const [info, setInfo] = useState<CacheInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void cloud.cacheInfo().then((i) => live && setInfo(i), () => {});
    const off = cloud.watch((e) => {
      if (e.type === "cache" && live) setInfo(e.cache);
    });
    return () => {
      live = false;
      off();
    };
  }, [cloud]);
  const choices = info && !CACHE_LIMIT_CHOICES.includes(info.limitBytes) ? [...CACHE_LIMIT_CHOICES, info.limitBytes].sort((a, b) => a - b) : CACHE_LIMIT_CHOICES;
  const evictable = info ? info.files - info.pinned : 0;
  return (
    <Section heading={t("Offline cache")} data-settings-section="offline-cache">
      <p className={styles.text}>{t("Files you open are kept on this computer, so they open quickly and work offline. When the cache is full, the files you opened longest ago are removed from this computer. They stay in your drafts.")}</p>
      <div className={styles.cacheRow}>
        <Select
          label={t("Cache size")}
          variant="outlined"
          className={styles.themeSelect}
          value={info ? String(info.limitBytes) : ""}
          disabled={!info}
          options={choices.map((b) => ({ value: String(b), label: t("Up to {size}", { size: formatBytes(b) }) }))}
          onChange={(v) =>
            void cloud.setCacheLimit(Number(v)).then(setInfo, (e: unknown) => showToast({ kind: "error", message: e instanceof Error ? e.message : t("Couldn’t change the cache size") }))
          }
          data-cache-limit=""
        />
        <span className={styles.muted} data-cache-used="">
          {info ? tp(info.files, "{size} used by {n} file", "{size} used by {n} files", { size: formatBytes(info.usedBytes) }) : "…"}
        </span>
      </div>
      <Button
        variant="secondary"
        className={styles.fontsButton}
        disabled={!info || evictable <= 0}
        loading={busy}
        data-clear-cache=""
        onClick={async () => {
          setBusy(true);
          try {
            const next = await cloud.clearCache();
            setInfo(next);
            showToast({ message: next.pinned ? t("Cache cleared. Open files and files with changes not uploaded yet were kept.") : t("Cache cleared") });
          } catch (e) {
            showToast({ kind: "error", message: e instanceof Error ? e.message : t("Couldn’t clear the cache") });
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("Clear cache")}
      </Button>
    </Section>
  );
}
