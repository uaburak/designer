/**
 * "Branch review" (R21 [request] / [review] / [merge]), opened by Review and merge changes…:
 * - the summary: the branch's changes by page and top-level layer, each layer main ↔ branch "Side by side" or
 *   "Overlay"; the "Review request" (description, reviewers and their verdicts); conflicts → Resolve conflicts;
 * - its author: Request review (reviewers: Add / Search, then a description and "Send to N reviewers"), Request another
 *   review, Merge branch (Name, Description, Merge) when they can edit main and every conflict is picked;
 * - a reviewer: Add your review → "Finish your review" (Approve / Suggest changes, a comment, Submit), Review again.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Avatar, Banner, Button, Dialog, EmptyState, RadioGroup, ScrollArea, SearchField, Spinner, TextArea, TextInput, showToast } from "@/ds";
import type { BranchRecord, MergePreview } from "../../../../shared/merge/branches";
import type { Resolutions } from "../../../../shared/merge/types";
import type { FileKey } from "../../../../shared/store/types";
import { useEditor } from "../controller";
import type { BranchingBackend, Reviewer } from "./access";
import { ChunkCompare, useSideDocs } from "./ChunkCompare";
import { allPicked, reviewBadge, reviewRole, sendLabel } from "./model";
import { BranchBadge, BranchWindow, ChangeList, codeOf, Conflicts, errorText } from "./parts";
import { openBranchWindow, refreshBranch, useBranching } from "./state";
import styles from "./Branching.module.css";

type Step = "summary" | "conflicts" | "reviewers" | "describe" | "merge";

export function BranchReview({ backend, branchFileKey }: { backend: BranchingBackend; branchFileKey: FileKey }) {
  const ed = useEditor();
  const own = useBranching(ed, (s) => (s.record?.branchFileKey === branchFileKey ? s.record : null));
  const [fetched, setRecord] = useState<BranchRecord | null>(null);
  // The open file's own record (kept current by the editor's state), else the one read here.
  const record = own ?? fetched;
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Resolutions>({});
  const [step, setStep] = useState<Step>("summary");
  const [selected, setSelected] = useState<number | null>(null);
  const [me, setMe] = useState<{ id: string | null; name: string | null }>({ id: null, name: null });
  const [canMerge, setCanMerge] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const images = ed.source.images ? (h: string) => ed.source.images!.get(h) : null;
  const docs = useSideDocs(backend.branches, images);

  const close = () => {
    openBranchWindow(ed, null);
    ed.focusCanvas();
  };
  // The latest preview asked for is the one shown (the store keeps only the latest one per branch).
  const loads = useRef(0);
  const load = async (resolutions: Resolutions) => {
    const n = ++loads.current;
    try {
      const p = await backend.branches.preview(branchFileKey, "merge", resolutions);
      if (n !== loads.current) return p;
      setPreview(p);
      setSelected((s) => s ?? p.chunks[0]?.index ?? null);
      return p;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  };
  useEffect(() => {
    let live = true;
    void (async () => {
      const [r, who] = await Promise.all([backend.branches.get(branchFileKey), backend.me()]);
      if (!live) return;
      setRecord(r);
      setMe(who);
      if (r) setCanMerge(await backend.canEditMain(r.mainFileKey));
    })();
    void Promise.resolve().then(() => load({}));
    const off = backend.branches.watch((e) => {
      if (e.type !== "branch.main-changed" && e.branch.branchFileKey === branchFileKey) setRecord(e.branch);
    });
    return () => {
      live = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per window
  }, [branchFileKey]);

  if (!record) {
    return (
      <BranchWindow label="Branch review" title="Branch review" onClose={close}>
        <div className={styles.loading}>{error ? <EmptyState icon="24.warning" title="The branch couldn’t be loaded" body={error} /> : <Spinner size={24} />}</div>
      </BranchWindow>
    );
  }

  const role = reviewRole(record, me);
  const review = record.review;
  const conflicts = preview ? preview.conflicts.length > 0 : false;
  const picked = !!preview && (!conflicts || allPicked(picks, preview));
  const chunk = preview?.chunks.find((c) => c.index === selected) ?? null;
  const mine = review?.reviewers.find((r) => r.userId === me.id) ?? null;

  const footer = () => {
    if (step !== "summary") return undefined;
    const out: ReactNode[] = [<span key="grow" className={styles.grow} />];
    if (role === "reviewer")
      out.push(
        <Button key="review" variant="primary" onClick={() => setFinishing(true)} data-add-review="">
          {mine && mine.verdict !== "pending" ? "Review again" : "Add your review"}
        </Button>
      );
    if (role === "author") {
      if (!review || review.state === "closed")
        out.push(
          <Button key="request" variant="secondary" onClick={() => setStep("reviewers")}>
            Request review
          </Button>
        );
      else if (review.state !== "in-review")
        out.push(
          <Button key="again" variant="secondary" onClick={() => setStep("reviewers")}>
            Request another review
          </Button>
        );
    }
    if (role !== "reviewer" || canMerge)
      out.push(
        <Button key="merge" variant="primary" disabled={!canMerge || !picked || record.status !== "active"} onClick={() => setStep("merge")} data-merge-branch="">
          Merge branch
        </Button>
      );
    return <>{out}</>;
  };

  return (
    <BranchWindow
      label="Branch review"
      title={record.name}
      extra={<BranchBadge kind={reviewBadge(review)} />}
      onClose={close}
      onBack={step !== "summary" ? () => setStep(step === "describe" ? "reviewers" : "summary") : undefined}
      footer={footer()}
    >
      {step === "conflicts" && preview ? (
        <Conflicts preview={preview} picks={picks} onPicks={setPicks} docs={docs} selected={selected} onSelect={setSelected} onNext={() => setStep("summary")} />
      ) : step === "reviewers" || step === "describe" ? (
        <RequestReview
          backend={backend}
          record={record}
          step={step}
          onNext={() => setStep("describe")}
          onSent={(r) => {
            setRecord(r);
            setStep("summary");
            void refreshBranch(ed);
          }}
        />
      ) : step === "merge" && preview ? (
        <MergeStep
          record={record}
          onMerge={async (title, description) => {
            try {
              const p = Object.keys(picks).length ? await backend.branches.preview(branchFileKey, "merge", picks) : preview;
              await backend.branches.merge(branchFileKey, { previewId: p.previewId, resolutions: picks, title: title || undefined, description: description || undefined });
              showToast({ message: "Branch merged" });
              close();
              await refreshBranch(ed);
              await backend.openFile(record.mainFileKey);
            } catch (e) {
              if (codeOf(e) === "stale") {
                showToast({ message: "The files changed. Review the changes again." });
                setStep("summary");
                void load(picks);
              } else showToast({ kind: "error", message: `Couldn’t merge the branch: ${errorText(e)}` });
            }
          }}
        />
      ) : (
        <div className={styles.body}>
          <nav className={styles.sidebar}>
            {review && review.state !== "closed" && (
              <section className={styles.section} data-review-request="">
                <div className={styles.sectionTitle}>Review request</div>
                {review.description && <p className={styles.description}>{review.description}</p>}
                {review.reviewers.map((r) => (
                  <div key={r.userId} className={styles.person} data-reviewer={r.userId}>
                    <Avatar name={r.name ?? r.userId} size={24} />
                    <span className={styles.grow}>
                      <span className={styles.rowName}>{r.name ?? r.userId}</span>
                      {r.comment && <span className={styles.hint}>{r.comment}</span>}
                    </span>
                    <span className={styles.hint} data-verdict={r.verdict}>
                      {r.verdict === "approved" ? "Approved" : r.verdict === "changes-suggested" ? "Changes suggested" : "Pending"}
                    </span>
                  </div>
                ))}
              </section>
            )}
            {conflicts && preview && (
              <Banner tone="warning" action={{ label: "Resolve conflicts", onClick: () => setStep("conflicts") }} data-conflict-banner="">
                {allPicked(picks, preview) ? "Conflicts resolved" : `${preview.conflicts.length === 1 ? "1 conflict" : `${preview.conflicts.length} conflicts`} with the main file`}
              </Banner>
            )}
            <div className={styles.sectionTitle}>Changes</div>
            <ScrollArea className={styles.scroll}>
              {error ? <div className={styles.hint}>{error}</div> : !preview ? <Spinner size={16} /> : <ChangeList chunks={preview.chunks} selected={selected} onSelect={setSelected} />}
            </ScrollArea>
          </nav>
          <section className={styles.main}>
            {preview && chunk ? (
              <ChunkCompare
                docs={docs}
                previewId={preview.previewId}
                chunk={chunk}
                sides={[
                  { side: "main", caption: "Main file" },
                  { side: "branch", caption: record.name },
                ]}
              />
            ) : preview ? (
              <EmptyState icon="24.check" title="No changes" body="This branch has no changes to merge." />
            ) : null}
          </section>
        </div>
      )}
      {finishing && (
        <FinishReview
          onClose={() => setFinishing(false)}
          onSubmit={async (verdict, comment) => {
            try {
              await backend.branches.answerReview(branchFileKey, { verdict, comment: comment || undefined });
              setRecord(await backend.branches.get(branchFileKey));
              setFinishing(false);
            } catch (e) {
              showToast({ kind: "error", message: `Couldn’t submit the review: ${errorText(e)}` });
            }
          }}
        />
      )}
    </BranchWindow>
  );
}

/** Request review: reviewers (suggested: people who can edit main, each with Add; Search), then the description. */
function RequestReview({ backend, record, step, onNext, onSent }: { backend: BranchingBackend; record: BranchRecord; step: "reviewers" | "describe"; onNext: () => void; onSent: (r: BranchRecord) => void }) {
  const [people, setPeople] = useState<Reviewer[] | null>(null);
  const [query, setQuery] = useState("");
  const [added, setAdded] = useState<string[]>(() => record.review?.reviewers.map((r) => r.userId) ?? []);
  const [description, setDescription] = useState(record.review?.description ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void backend.reviewers(record.mainFileKey).then(
      (p) => live && setPeople(p),
      () => live && setPeople([])
    );
    return () => {
      live = false;
    };
  }, [backend, record.mainFileKey]);
  const q = query.trim().toLowerCase();
  const shown = (people ?? []).filter((p) => !q || (p.name ?? "").toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
  const send = async () => {
    setBusy(true);
    try {
      await backend.branches.requestReview(record.branchFileKey, { reviewerIds: added, description: description.trim() });
      const r = await backend.branches.get(record.branchFileKey);
      if (r) onSent(r);
    } catch (e) {
      setBusy(false);
      showToast({ kind: "error", message: `Couldn’t request the review: ${errorText(e)}` });
    }
  };
  if (step === "describe") {
    return (
      <div className={styles.form} data-review-describe="">
        <div className={styles.sectionTitle}>Request review</div>
        <TextArea label="Description" placeholder="Add a description of your changes" value={description} onChange={setDescription} minRows={4} />
        <div className={styles.formActions}>
          <Button variant="primary" disabled={!added.length || busy} loading={busy} onClick={() => void send()} data-send-review="">
            {sendLabel(added.length)}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.form} data-review-reviewers="">
      <div className={styles.sectionTitle}>Reviewers</div>
      <SearchField value={query} onChange={setQuery} placeholder="Search" />
      {people === null ? (
        <Spinner size={16} />
      ) : !people.length ? (
        <div className={styles.hint}>No one else can edit the main file. Share it to invite reviewers.</div>
      ) : (
        <ScrollArea className={styles.people}>
          {shown.map((p) => {
            const on = added.includes(p.userId);
            return (
              <div key={p.userId} className={styles.person} data-person={p.userId}>
                <Avatar name={p.name ?? p.email} size={24} />
                <span className={styles.grow}>
                  <span className={styles.rowName}>{p.name ?? p.email}</span>
                  <span className={styles.hint}>{p.email}</span>
                </span>
                <Button variant={on ? "secondary" : "tinted"} onClick={() => setAdded((a) => (on ? a.filter((x) => x !== p.userId) : [...a, p.userId]))}>
                  {on ? "Remove" : "Add"}
                </Button>
              </div>
            );
          })}
        </ScrollArea>
      )}
      <div className={styles.formActions}>
        <Button variant="primary" disabled={!added.length} onClick={onNext} data-request-review="">
          Request review
        </Button>
      </div>
    </div>
  );
}

/** Merge branch: the merge description (Name, Description — main's version history) and Merge. */
function MergeStep({ record, onMerge }: { record: BranchRecord; onMerge: (title: string, description: string) => Promise<void> }) {
  const [name, setName] = useState(record.name);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.form} data-merge-step="">
      <div className={styles.sectionTitle}>Merge branch</div>
      <p className={styles.hint}>The name and description go into the main file’s version history.</p>
      <TextInput label="Name" value={name} onChange={setName} />
      <TextArea label="Description" placeholder="Description" value={description} onChange={setDescription} />
      <div className={styles.formActions}>
        <Button
          variant="primary"
          loading={busy}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onMerge(name.trim(), description.trim()).finally(() => setBusy(false));
          }}
          data-merge=""
        >
          Merge
        </Button>
      </div>
    </div>
  );
}

/** "Finish your review": Approve or Suggest changes, an optional comment, Submit (R21 [review]). */
function FinishReview({ onClose, onSubmit }: { onClose: () => void; onSubmit: (verdict: "approved" | "changes-suggested", comment: string) => Promise<void> }) {
  const [verdict, setVerdict] = useState<"approved" | "changes-suggested">("approved");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="Finish your review"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void onSubmit(verdict, comment.trim()).finally(() => setBusy(false));
            }}
            data-submit-review=""
          >
            Submit
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody} data-finish-review="">
        <RadioGroup
          label="Review"
          value={verdict}
          options={[
            { value: "approved", label: "Approve" },
            { value: "changes-suggested", label: "Suggest changes" },
          ]}
          onChange={(v) => setVerdict(v as "approved" | "changes-suggested")}
        />
        <p className={styles.hint}>{verdict === "approved" ? "Add any comments you want to make (optional)." : "Add any general comments you want to make (optional)."}</p>
        <TextArea label="Comment" value={comment} onChange={setComment} />
      </div>
    </Dialog>
  );
}
