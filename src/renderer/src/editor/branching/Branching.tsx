/**
 * The editor's branching (docs/editor.md "Branching", Phase 7 round 2b): mounted once in the editor shell. It loads
 * the file's branch record, follows the repository's events, and shows Create branch…, the main-changed notice, the
 * Branches modal, Branch review and Update from main file. `BranchTitle` is the left sidebar's "‹file› / ‹branch›".
 */
import { useEffect, useState } from "react";
import { Button, Dialog, IconButton, TextInput, showToast } from "@/ds";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { createBranch } from "../objectCommands";
import { backendOf } from "./access";
import { BranchesDialog } from "./BranchesDialog";
import { BranchReview } from "./BranchReview";
import { branchBadge } from "./model";
import { BranchBadge, errorText } from "./parts";
import { attachBranching, branching, openBranchWindow, setBranching, useBranching } from "./state";
import { UpdateFromMain } from "./UpdateFromMain";
import styles from "./Branching.module.css";

export function Branching() {
  const ed = useEditor();
  useEffect(() => attachBranching(ed), [ed]);
  const create = useUI((s) => !!s.branchDialog);
  const win = useBranching(ed, (s) => s.window);
  const backend = backendOf(ed);
  return (
    <>
      {create && <CreateBranch />}
      <MainChangedNotice />
      {backend && win?.kind === "branches" && <BranchesDialog backend={backend} tab={win.tab} />}
      {backend && win?.kind === "review" && <BranchReview backend={backend} branchFileKey={win.branchFileKey} />}
      {backend && win?.kind === "update" && <UpdateFromMain backend={backend} branchFileKey={win.branchFileKey} />}
    </>
  );
}

/** File › Create branch…: the branch's name; Create makes it from main and opens it (R21 [guide]). */
function CreateBranch() {
  const ed = useEditor();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => {
    ed.ui.set({ branchDialog: false });
    ed.focusCanvas();
  };
  const create = async () => {
    const n = name.trim();
    if (!n || busy) return;
    const backend = backendOf(ed);
    const mainFileKey = branching(ed).fileKey;
    if (!backend || !mainFileKey) {
      // No branches in the store yet (round 2a): round 10's plain copy.
      void createBranch(ed, n);
      close();
      return;
    }
    setBusy(true);
    try {
      await ed.source.flush();
      const b = await backend.branches.create(mainFileKey, n);
      close();
      await backend.openFile(b.branchFileKey);
    } catch (e) {
      setBusy(false);
      showToast({ kind: "error", message: `Couldn’t create the branch: ${errorText(e)}` });
    }
  };
  return (
    <Dialog
      title="Create branch"
      open
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} loading={busy} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      {/* TextInput keeps Enter to itself (stopPropagation): Return submits through onExit, as Create team's dialog. */}
      <div data-create-branch="">
        <TextInput label="Branch name" placeholder="Branch name" value={name} onChange={setName} autoFocus onExit={(r) => (r === "enter" ? void create() : r === "escape" ? close() : undefined)} />
      </div>
    </Dialog>
  );
}

/** Main changed since the branch's base: a notice at the bottom right with Update (R21 [update]; wording unverified). */
function MainChangedNotice() {
  const ed = useEditor();
  const shown = useBranching(ed, (s) => s.record?.status === "active" && s.mainChanged && !s.noticeDismissed && s.window === null);
  const key = useBranching(ed, (s) => s.record?.branchFileKey ?? null);
  if (!shown || !key) return null;
  return (
    <div className={styles.notice} role="status" data-main-changed="">
      <span className={styles.grow}>There are updates from the main file</span>
      <Button variant="primary" onClick={() => openBranchWindow(ed, { kind: "update", branchFileKey: key })}>
        Update
      </Button>
      <IconButton icon="24.close.small" label="Dismiss" onClick={() => setBranching(ed, { noticeDismissed: true })} />
    </div>
  );
}

/**
 * The left sidebar's file name: on a branch "‹main› / ‹branch›" and the branch's badge (In review, Approved, Changes
 * suggested, Archived, Merged); on main the name alone.
 */
export function BranchTitle({ name }: { name: string }) {
  const ed = useEditor();
  const record = useBranching(ed, (s) => s.record);
  const mainName = useBranching(ed, (s) => s.mainName);
  if (!record) return <span>{name}</span>;
  return (
    <span className={styles.titleRow} data-branch-title="">
      <span className={styles.mainName}>{mainName ?? "Main file"}</span>
      <span className={styles.slash}>/</span>
      <span className={styles.branchName}>{record.name}</span>
      <BranchBadge kind={branchBadge(record)} />
    </span>
  );
}
