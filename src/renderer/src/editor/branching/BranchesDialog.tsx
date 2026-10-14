/**
 * The "Branches" modal (R21 [manage]): tabs Active, Archived (merged and archived) and Yours; a row per branch (name,
 * author and age, its badge), "Open" on hover, and its menu — Copy link, Rename (in place: Enter or a click outside
 * commits), Archive, or Restore in Archived (merged branches can't be restored).
 */
import { useEffect, useState } from "react";
import { Button, Dialog, EmptyState, Icon, MenuButton, ScrollArea, Spinner, Tabs, TextInput, showToast, type MenuEntry } from "@/ds";
import { t, useT } from "@/i18n";
import type { BranchRecord } from "../../../../shared/merge/branches";
import { useEditor } from "../controller";
import type { BranchingBackend } from "./access";
import { branchBadge, branchMeta } from "./model";
import { BranchBadge, errorText } from "./parts";
import { branching, openBranchWindow, refreshBranch } from "./state";
import styles from "./Branching.module.css";

type Tab = "active" | "archived" | "yours";

export function BranchesDialog({ backend, tab: initial }: { backend: BranchingBackend; tab: Tab }) {
  useT();
  const ed = useEditor();
  const state = branching(ed);
  const mainFileKey = state.record?.mainFileKey ?? state.fileKey;
  const [tab, setTab] = useState<Tab>(initial);
  const [rows, setRows] = useState<BranchRecord[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!mainFileKey) return;
    let live = true;
    void backend.branches.list(mainFileKey, tab).then(
      (r) => live && setRows([...r].sort((a, b) => b.createdAt - a.createdAt)),
      (e) => {
        if (!live) return;
        setRows([]);
        showToast({ kind: "error", message: t("Couldn’t list the branches: {error}", { error: errorText(e) }) });
      }
    );
    const off = backend.branches.watch((e) => e.type !== "branch.main-changed" && e.branch.mainFileKey === mainFileKey && setVersion((v) => v + 1));
    return () => {
      live = false;
      off();
    };
  }, [backend, mainFileKey, tab, version]);
  const close = () => {
    openBranchWindow(ed, null);
    ed.focusCanvas();
  };
  const act = async (failed: (error: string) => string, run: () => Promise<unknown>, done?: string) => {
    try {
      await run();
      if (done) showToast({ message: done });
      setVersion((v) => v + 1);
      void refreshBranch(ed);
    } catch (e) {
      showToast({ kind: "error", message: failed(errorText(e)) });
    }
  };
  const menu = (b: BranchRecord): MenuEntry[] => [
    { id: "copy-link", label: t("Copy link"), disabled: !b.branchKey },
    { id: "rename", label: t("Rename"), disabled: b.status === "merged" },
    b.status === "active" ? { id: "archive", label: t("Archive") } : { id: "restore", label: t("Restore"), disabled: b.status === "merged" },
  ];
  const onMenu = (b: BranchRecord, id: string) => {
    if (id === "rename") setRenaming(b.branchFileKey);
    else if (id === "archive") void act((error) => t("Couldn’t archive the branch: {error}", { error }), () => backend.branches.archive(b.branchFileKey), t("Branch archived"));
    else if (id === "restore") void act((error) => t("Couldn’t restore the branch: {error}", { error }), () => backend.branches.restore(b.branchFileKey), t("Branch restored"));
    else if (id === "copy-link")
      void act((error) => t("Couldn’t copy the link: {error}", { error }), async () => {
        const link = await backend.link(b);
        if (!link) throw new Error(t("this branch has no link"));
        await navigator.clipboard?.writeText(link);
      }, t("Link copied"));
  };
  return (
    <Dialog title={t("Branches")} size="medium" open onClose={close}>
      <div className={styles.branches} data-branches="">
        <Tabs
          label={t("Branches")}
          value={tab}
          tabs={[
            { value: "active", label: t("Active") },
            { value: "archived", label: t("Archived") },
            { value: "yours", label: t("Yours") },
          ]}
          onChange={(v) => setTab(v as Tab)}
        />
        <ScrollArea className={styles.branchList}>
          {rows === null ? (
            <Spinner size={16} />
          ) : !rows.length ? (
            <EmptyState title={tab === "active" ? t("No active branches") : tab === "archived" ? t("No archived branches") : t("You haven’t created any branches")} />
          ) : (
            rows.map((b) => (
              <div key={b.branchFileKey} className={styles.branchRow} data-branch={b.branchFileKey} aria-current={b.branchFileKey === state.fileKey || undefined}>
                <span className={styles.grow}>
                  {renaming === b.branchFileKey ? (
                    <TextInput
                      label={t("Branch name")}
                      value={b.name}
                      autoFocus
                      onCommit={(name) => {
                        const n = name.trim();
                        if (n && n !== b.name) void act((error) => t("Couldn’t rename the branch: {error}", { error }), () => backend.branches.rename(b.branchFileKey, n));
                      }}
                      onExit={() => setRenaming(null)}
                    />
                  ) : (
                    <>
                      <span className={styles.rowName}>{b.name}</span>
                      <span className={styles.hint}>{branchMeta(b)}</span>
                    </>
                  )}
                </span>
                <BranchBadge kind={branchBadge(b)} />
                <Button
                  variant="secondary"
                 
                  className={styles.open}
                  onClick={() => {
                    close();
                    void backend.openFile(b.branchFileKey);
                  }}
                  data-open-branch=""
                >
                  {t("Open")}
                </Button>
                <MenuButton label={t("Branch actions")} entries={() => menu(b)} onSelect={(id) => onMenu(b, id)} align="end">
                  <Icon name="24.more" />
                </MenuButton>
              </div>
            ))
          )}
        </ScrollArea>
      </div>
    </Dialog>
  );
}
