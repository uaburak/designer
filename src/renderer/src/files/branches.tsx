/**
 * Branches in Home (help.figma.com "View and manage branches", docs/data.md §15.9): the count of a main file's active
 * branches on its tile, the tile's dropdown (Main file, its branches, Create branch…, See all branches), and the
 * Branches modal — Active, Archived (archived and merged) and Yours; Open on hover; Copy link, Rename, Archive, Restore
 * (a merged branch can't be restored). The same in the local space (FileBrowser) and an organization's (OrgMain).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, ContextMenu, Dialog, EmptyState, Icon, MenuButton, ScrollArea, Spinner, Tabs, TextInput, type MenuEntry, type ToastOptions } from "@/ds";
import type { BranchesRepository, BranchRecord } from "@shared/merge/branches";
import type { WorkspaceRepository } from "@shared/store/repositories";
import type { FileKey, FileListItem } from "@shared/store/types";
import { branchBadge, branchMeta } from "../editor/branching/model";
import { BranchBadge } from "../editor/branching/parts";
import { branchOf, branchSwitchMenu } from "./branchesModel";
import { NameDialog } from "./orgDialogs";
import styles from "./Files.module.css";

export type BranchTab = "active" | "archived" | "yours";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Active branches per main file, for the tiles. Re-read when the listed files change and when a branch is made,
 * renamed, archived, restored or merged (the repository's watch).
 */
export function useBranchCounts(repo: BranchesRepository | undefined, fileKeys: readonly FileKey[]): Record<FileKey, number> {
  const [counts, setCounts] = useState<Record<FileKey, number>>({});
  const [version, setVersion] = useState(0);
  const key = fileKeys.join(",");
  useEffect(() => {
    if (!repo) return;
    return repo.watch((e) => e.type !== "branch.main-changed" && setVersion((v) => v + 1));
  }, [repo]);
  useEffect(() => {
    if (!repo || !key) return;
    let live = true;
    const keys = key.split(",");
    void (async () => {
      const out: Record<FileKey, number> = {};
      // A few at a time: a shared main's list is a server call.
      for (let i = 0; i < keys.length && live; i += 6) {
        const part = await Promise.all(keys.slice(i, i + 6).map((k) => repo.list(k, "active").then((r) => [k, r.length] as const, () => [k, 0] as const)));
        for (const [k, n] of part) out[k] = n;
      }
      if (live) setCounts(out);
    })();
    return () => {
      live = false;
    };
  }, [repo, key, version]);
  return counts;
}

/** The main files' names of the branches listed (Recents and Starred list branches: "‹file› / ‹branch›"). */
export function useMainNames(repo: Pick<WorkspaceRepository, "getFile">, files: readonly FileListItem[]): Record<FileKey, string> {
  const [names, setNames] = useState<Record<FileKey, string>>({});
  const listed = useMemo(() => Object.fromEntries(files.map((f) => [f.fileKey, f.name])), [files]);
  const wanted = useMemo(() => [...new Set(files.flatMap((f) => (f.branch ? [f.branch.mainFileKey] : [])))].sort().join(","), [files]);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void Promise.all(wanted.split(",").map((k) => (listed[k] ? Promise.resolve([k, listed[k]] as const) : repo.getFile(k).then((f) => [k, f.name] as const, () => [k, ""] as const)))).then((pairs) => {
      if (live) setNames(Object.fromEntries(pairs.filter(([, n]) => n)));
    });
    return () => {
      live = false;
    };
  }, [repo, wanted, listed]);
  return names;
}

/** A main file as the switcher knows it: its local copy (when it has one) or its room (an org file not opened yet) */
export interface MainRef {
  name: string;
  fileKey: FileKey | null;
  /** An org file's room key: its local copy is made from it the first time */
  key?: string | null;
  /** Whether "Create branch…" is offered (can view main and copy; Full seat in an org) */
  canCreate?: boolean;
}

export interface BranchSwitcherDeps {
  branches: BranchesRepository | undefined;
  /** Opens a local copy in its tab */
  openFile: (fileKey: FileKey, title: string, newTab?: boolean) => void;
  /** An org (room) file's local copy, made from its room the first time */
  openShared?: (key: string) => Promise<{ fileKey: FileKey }>;
  toast: (o: ToastOptions) => void;
}

type SwitcherDialog = { kind: "create"; main: MainRef } | { kind: "all"; main: MainRef; mainFileKey: FileKey } | null;

/**
 * The tile's branch dropdown and the dialogs it leads to. `open(e, main)` shows the dropdown under the clicked count;
 * `element` renders the menu and dialogs.
 */
export function useBranchSwitcher(deps: BranchSwitcherDeps): { open: (e: React.MouseEvent<HTMLElement>, main: MainRef) => void; element: React.ReactNode } {
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; entries: MenuEntry[]; run: (id: string) => void } | null>(null);
  const [dialog, setDialog] = useState<SwitcherDialog>(null);
  const depsRef = useRef(deps);
  useLayoutEffect(() => {
    depsRef.current = deps;
  });

  const localKey = useCallback(async (main: MainRef): Promise<FileKey> => {
    if (main.fileKey) return main.fileKey;
    const d = depsRef.current;
    if (!main.key || !d.openShared) throw new Error("This file isn’t on this computer");
    return (await d.openShared(main.key)).fileKey;
  }, []);

  /** Opens a branch: its local copy, else (a shared branch made elsewhere) its room's, taken in as a branch first. */
  const openBranch = useCallback(
    async (b: BranchRecord, mainFileKey: FileKey, newTab = false) => {
      const d = depsRef.current;
      try {
        let fileKey = b.branchFileKey;
        if (!fileKey) {
          if (!b.branchKey || !d.openShared) throw new Error("This branch isn’t on this computer");
          fileKey = (await d.openShared(b.branchKey)).fileKey;
          // The branches' list takes the new copy in as a branch (its record and base) before it opens.
          await d.branches?.list(mainFileKey, b.status === "active" ? "active" : "archived").catch(() => []);
        }
        d.openFile(fileKey, b.name, newTab);
      } catch (e) {
        d.toast({ kind: "error", message: `Couldn’t open “${b.name}”: ${errorText(e)}` });
      }
    },
    [],
  );

  const open = useCallback(
    (e: React.MouseEvent<HTMLElement>, main: MainRef) => {
      e.preventDefault();
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      const at = { x: r.left, y: r.bottom + 4 };
      const d = depsRef.current;
      if (!d.branches) return;
      void (async () => {
        try {
          const mainFileKey = await localKey(main);
          const rows = await d.branches!.list(mainFileKey, "active");
          setMenu({
            at,
            entries: branchSwitchMenu(rows, { canCreate: main.canCreate !== false }),
            run: (id) => {
              if (id === "main") d.openFile(mainFileKey, main.name);
              else if (id === "create") setDialog({ kind: "create", main: { ...main, fileKey: mainFileKey } });
              else if (id === "see-all") setDialog({ kind: "all", main, mainFileKey });
              else {
                const b = branchOf(rows, id);
                if (b) void openBranch(b, mainFileKey);
              }
            },
          });
        } catch (err) {
          d.toast({ kind: "error", message: `Couldn’t list the branches: ${errorText(err)}` });
        }
      })();
    },
    [localKey, openBranch],
  );

  const create = async (main: MainRef, name: string) => {
    const d = depsRef.current;
    setDialog(null);
    try {
      const made = await d.branches!.create(main.fileKey!, name);
      d.openFile(made.branchFileKey, made.name);
    } catch (e) {
      d.toast({ kind: "error", message: `Couldn’t create the branch: ${errorText(e)}` });
    }
  };

  const element = (
    <>
      {menu && <ContextMenu at={menu.at} entries={menu.entries} onSelect={menu.run} onClose={() => setMenu(null)} />}
      {dialog?.kind === "create" && <NameDialog title="Create branch" label="Branch name" confirm="Create" onClose={() => setDialog(null)} onDone={(name) => void create(dialog.main, name)} />}
      {dialog?.kind === "all" && deps.branches && (
        <HomeBranchesDialog
          branches={deps.branches}
          mainFileKey={dialog.mainFileKey}
          mainName={dialog.main.name}
          onOpen={(b) => {
            setDialog(null);
            void openBranch(b, dialog.mainFileKey);
          }}
          onClose={() => setDialog(null)}
          toast={deps.toast}
        />
      )}
    </>
  );
  return { open, element };
}

/** The Branches modal in Home (R21 [manage]): as the editor's (editor/branching/BranchesDialog.tsx), for any main file. */
export function HomeBranchesDialog({ branches, mainFileKey, mainName, onOpen, onClose, toast, initialTab = "active" }: { branches: BranchesRepository; mainFileKey: FileKey; mainName: string; onOpen: (b: BranchRecord) => void; onClose: () => void; toast: (o: ToastOptions) => void; initialTab?: BranchTab }) {
  const [tab, setTab] = useState<BranchTab>(initialTab);
  const [rows, setRows] = useState<BranchRecord[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    void branches.list(mainFileKey, tab).then(
      (r) => live && setRows([...r].sort((a, b) => b.createdAt - a.createdAt)),
      (e) => {
        if (!live) return;
        setRows([]);
        toast({ kind: "error", message: `Couldn’t list the branches: ${errorText(e)}` });
      },
    );
    const off = branches.watch((e) => e.type !== "branch.main-changed" && e.branch.mainFileKey === mainFileKey && setVersion((v) => v + 1));
    return () => {
      live = false;
      off();
    };
  }, [branches, mainFileKey, tab, version, toast]);

  const act = async (what: string, run: () => Promise<unknown>, done?: string) => {
    try {
      await run();
      if (done) toast({ message: done });
      setVersion((v) => v + 1);
    } catch (e) {
      toast({ kind: "error", message: `Couldn’t ${what}: ${errorText(e)}` });
    }
  };
  const rowKey = (b: BranchRecord) => b.branchFileKey || b.branchKey || b.name;
  const menu = (b: BranchRecord): MenuEntry[] => [
    { id: "copy-link", label: "Copy link", disabled: !b.branchFileKey },
    { id: "rename", label: "Rename", disabled: b.status === "merged" || !b.branchFileKey },
    b.status === "active" ? { id: "archive", label: "Archive", disabled: !b.branchFileKey } : { id: "restore", label: "Restore", disabled: b.status === "merged" || !b.branchFileKey },
  ];
  const onMenu = (b: BranchRecord, id: string) => {
    if (id === "rename") setRenaming(rowKey(b));
    else if (id === "archive") void act("archive the branch", () => branches.archive(b.branchFileKey), "Branch archived");
    else if (id === "restore") void act("restore the branch", () => branches.restore(b.branchFileKey), "Branch restored");
    else if (id === "copy-link")
      void act(
        "copy the link",
        async () => {
          if (!navigator.clipboard) throw new Error("the clipboard isn’t available");
          await navigator.clipboard.writeText(`designerv2://file/${b.branchFileKey}`);
        },
        "Link copied to clipboard",
      );
  };
  const empty = useMemo(() => (tab === "active" ? "No active branches" : tab === "archived" ? "No archived branches" : "You haven’t created any branches"), [tab]);
  return (
    <Dialog title="Branches" size="medium" open onClose={onClose}>
      <div className={styles.branchDialog} data-home-branches={mainFileKey} aria-label={`Branches of ${mainName}`}>
        <Tabs
          label="Branches"
          value={tab}
          tabs={[
            { value: "active", label: "Active" },
            { value: "archived", label: "Archived" },
            { value: "yours", label: "Yours" },
          ]}
          onChange={(v) => {
            setRows(null);
            setTab(v as BranchTab);
          }}
        />
        <ScrollArea className={styles.branchList}>
          {rows === null ? (
            <Spinner size={16} />
          ) : !rows.length ? (
            <EmptyState title={empty} />
          ) : (
            rows.map((b) => (
              <div key={rowKey(b)} className={styles.branchRow} data-branch={rowKey(b)}>
                <span className={styles.branchText}>
                  {renaming === rowKey(b) ? (
                    <TextInput
                      label="Branch name"
                      value={b.name}
                      autoFocus
                      onCommit={(name) => {
                        const n = name.trim();
                        if (n && n !== b.name) void act("rename the branch", () => branches.rename(b.branchFileKey, n));
                      }}
                      onExit={() => setRenaming(null)}
                    />
                  ) : (
                    <>
                      <span className={styles.branchName}>{b.name}</span>
                      <span className={styles.branchHint}>{branchMeta(b)}</span>
                    </>
                  )}
                </span>
                <BranchBadge kind={branchBadge(b)} />
                <Button variant="secondary" className={styles.branchOpen} onClick={() => onOpen(b)} data-open-branch="">
                  Open
                </Button>
                <MenuButton label="Branch actions" entries={() => menu(b)} onSelect={(id) => onMenu(b, id)} align="end">
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
