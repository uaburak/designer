/**
 * A contract fake of the server's branch routes (docs/data.md §15.7) until round 2c builds them: one in-memory
 * `(method, path, body) → JSON` handler, the shapes of `remote.ts` (`BranchRow`, `BranchReview`). The rules are a
 * subset: names required, merged branches can't be restored, verdicts only from reviewers. Not a model of access.
 */
import type { BranchReview } from "../../../shared/merge/branches";
import { StoreError } from "../../../shared/store/protocol";
import type { BranchRow } from "../remote";

export class FakeBranchServer {
  readonly branches = new Map<string, BranchRow>();
  readonly bases = new Map<string, { seq: number; bytes: Uint8Array }>();
  readonly snapshots = new Map<string, Uint8Array>();
  /** Session counters of rooms (the branch room's block starts at main's, which jumps by 65536) */
  readonly sessionCounters = new Map<string, number>();
  readonly log: string[] = [];
  private n = 0;

  constructor(
    public userId = "u-me",
    private readonly now: () => number = () => 1_700_000_000_000,
  ) {}

  private row(key: string): BranchRow {
    const b = this.branches.get(key);
    if (!b) throw new StoreError("not-found", "No such branch");
    return b;
  }

  async handle(method: string, path: string, body?: unknown): Promise<unknown> {
    this.log.push(`${method} ${path}`);
    const url = new URL(path, "https://fake.test");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const b = body as Record<string, unknown> | undefined;
    // POST /files/:key/branches · GET /files/:key/branches?tab=
    if (parts[0] === "files" && parts[2] === "branches") {
      const mainKey = parts[1];
      if (method === "POST") {
        const name = typeof b?.name === "string" ? b.name.trim() : "";
        if (!name || typeof b?.branchKey !== "string") throw new StoreError("invalid", "name and branchKey required");
        const base = this.sessionCounters.get(mainKey) ?? 1;
        this.sessionCounters.set(mainKey, base + 65536);
        this.sessionCounters.set(b.branchKey, base);
        const row: BranchRow = {
          key: b.branchKey,
          mainKey,
          name,
          status: "active",
          createdBy: this.userId,
          createdByName: "Me",
          createdAt: this.now(),
          baseSeq: Number(b.baseSeq) || 0,
          mainSeenSeq: Number(b.baseSeq) || 0,
          sessionBase: base,
          archivedAt: null,
          mergedAt: null,
          mergedBy: null,
          mergeVersion: null,
          review: null,
        };
        this.branches.set(row.key, row);
        return { branch: row, sessionBase: base };
      }
      const tab = url.searchParams.get("tab");
      const rows = [...this.branches.values()].filter((r) => r.mainKey === mainKey && (tab === "active" ? r.status === "active" : tab === "archived" ? r.status !== "active" : r.createdBy === this.userId));
      return { branches: rows };
    }
    // PUT /files/:key/snapshot?seq=
    if (parts[0] === "files" && parts[2] === "snapshot" && method === "PUT") {
      this.snapshots.set(parts[1], body as Uint8Array);
      return {};
    }
    if (parts[0] !== "branches") throw new StoreError("not-found", `no route ${method} ${path}`);
    const key = parts[1];
    const row = this.row(key);
    if (parts.length === 2 && method === "PATCH") {
      if (typeof b?.name === "string") row.name = b.name;
      if (b?.status === "archived" && row.status === "active") {
        row.status = "archived";
        row.archivedAt = this.now();
      }
      if (b?.status === "active") {
        if (row.status === "merged") throw new StoreError("invalid", "A merged branch can't be restored");
        row.status = "active";
        row.archivedAt = null;
      }
      return { branch: row };
    }
    if (parts[2] === "base") {
      if (method === "PUT") {
        this.bases.set(key, { seq: Number(url.searchParams.get("seq")), bytes: body as Uint8Array });
        return {};
      }
      return this.bases.get(key)?.bytes;
    }
    if (parts[2] === "updated" && method === "POST") {
      row.baseSeq = Number(b?.baseSeq);
      row.mainSeenSeq = Number(b?.mainSeenSeq);
      return { branch: row };
    }
    if (parts[2] === "merged" && method === "POST") {
      row.status = "merged";
      row.mergedAt = this.now();
      row.mergedBy = this.userId;
      row.mergeVersion = String(b?.versionId ?? "");
      row.archivedAt = row.archivedAt ?? this.now();
      return { branch: row };
    }
    if (parts[2] === "reviews" && parts.length === 3 && method === "POST") {
      const ids = (b?.reviewerIds as string[]) ?? [];
      const review: BranchReview = {
        id: `r${++this.n}`,
        state: "in-review",
        requestedBy: this.userId,
        description: String(b?.description ?? ""),
        createdAt: this.now(),
        reviewers: ids.map((userId) => ({ userId, name: null, verdict: "pending", comment: "", at: null })),
      };
      row.review = review;
      return { review };
    }
    if (parts[2] === "reviews" && parts[4] === "verdict" && method === "POST") {
      const review = row.review;
      if (!review || review.id !== parts[3]) throw new StoreError("not-found", "No such review");
      const me = review.reviewers.find((r) => r.userId === this.userId);
      if (!me) throw new StoreError("forbidden", "Only a reviewer can answer");
      me.verdict = b?.verdict as "approved" | "changes-suggested";
      me.comment = String(b?.comment ?? "");
      me.at = this.now();
      review.state = me.verdict;
      return { review };
    }
    throw new StoreError("not-found", `no route ${method} ${path}`);
  }
}
