/**
 * The store's composition root: the workspace on disk (docs/data.md §3), its records, files, blobs and libraries,
 * and `LocalAdapter`, the four repositories over them (§8). `LocalAdapter` is always authoritative: the UI reads
 * and writes only through it (over RPC); shared files reach their rooms behind it (multiplayer/service.ts).
 */
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { closeSync, openSync, promises as fsp, writeSync } from "node:fs";
import { join } from "node:path";
import { newDocumentMessage } from "../shared/schema/codec";
import { codec, type Message } from "../shared/schema/document.generated";
import { sessionIdFor, splitSessionId } from "../shared/schema/guid";
import { NodeTable } from "../shared/schema/patch";
import { withNewAssetIdentity } from "../shared/store/assetIdentity";
import { StoreError } from "../shared/store/protocol";
import type {
  BlobStore,
  FileChange,
  FileQuery,
  FileRepository,
  FontsEvent,
  LibraryEvent,
  LibraryRegistry,
  OpenedFile,
  StoreAdmin,
  StoreApi,
  Unsubscribe,
  WorkspaceEvent,
  WorkspaceRepository,
} from "../shared/store/repositories";
import { isFileKey, type FileKey, type FileMeta, type FileSpace, type FolderId, type PreviewRecord, type VersionRecord } from "../shared/store/types";
import { inlineCompactor, type Compactor } from "./compactor";
import { writeLocalCopy } from "./export/fig";
import { prepareFigImport } from "./import/fig";
import { LocalBlobs, pngSize } from "./local/blobs";
import { fileDetailsOf, type FileDetails } from "../shared/store/fileSettings";
import { Emitter } from "./local/emitter";
import { FileStore, type SessionOwner, type Timers } from "./local/fileStore";
import { atomicWrite, ensureDir, readJsonOrNull, writeJsonAtomic } from "./local/fsutil";
import { base62, HlcClock, newFileKey, newFolderId, systemClock, type Clock } from "./local/ids";
import { LocalLibraries } from "./local/libraries";
import { SchemaRegistry, currentMessage, readSnapshotFile } from "./local/snapshot";
import { versionDateLabel } from "./local/versions";
import { RoomVersions, withRoomVersions } from "./local/versionsRoom";
import { LocalWorkspace, newMeta, workspaceDirs, type Log, type WorkspaceDirs } from "./local/workspace";
import { previewService, type PreviewSession } from "./preview/previews";
import { SerialQueue } from "./local/queue";
import { multiplayerApi } from "./multiplayer/api";
import { MultiplayerService } from "./multiplayer/service";
import { uploadDestination } from "./multiplayer/uploads";
import { cleanOrgPlace, importIntoOrg } from "./multiplayer/orgImport";
import { CommentsService, commentsApi } from "./comments/service";
import { NotificationsService, notificationsApi } from "./notifications/service";
import { OrgService } from "./org/service";
import { PersonalService, type CloudState } from "./personal/service";
import { BranchService } from "./branches/service";
import { localBranchHost } from "./branches/localHost";
import { dirname } from "node:path";
import { decodeCanvas, encodeCanvas } from "../shared/fig/container";
import { DOCUMENT_FORMAT_VERSION, SCHEMA_BINARY } from "../shared/schema/document.generated";
import { nodeCodecs, own } from "./kiwi/codecs";
import { decodeWithSchema, isCurrentSchema } from "./kiwi/schemas";
import { libraryServerOf, OrgLibraries, type LibraryCacheStore, type LibraryServer } from "./libraries/org";
import { LibraryRouter } from "./libraries/router";
import { orgLibrariesRepository } from "./libraries/orgLibraries";
import { AnalyticsQueue, analyticsRepository } from "./libraries/analyticsQueue";
import { identityRepository } from "./org/identity";
import { governanceEvents, governanceRepository, refreshGates } from "./org/governance";
import { PluginsService } from "./plugins/service";
import { DevModeService, type LocalDevRecord } from "./devmode/service";
import { SearchService } from "./search/service";
import { AiService } from "./ai/service";
import { UsageReporter } from "./libraries/usage";
import { withFakeLatency } from "./fakeLatency";
import { BrandsService } from "./brands/service";
import { t as tr } from "../shared/i18n";

export interface LocalStoreOptions {
  workspaceDir: string;
  /** userData: device.json (the device ordinal) lives here */
  userDataDir?: string;
  deviceOrdinal?: number;
  clock?: Clock;
  timers?: Timers;
  compactor?: Compactor;
  teamName?: string;
  log?: Log;
  generation?: number;
  /** Blob GC runs this long after start (default 10 min); null disables the timer */
  gcDelayMs?: number | null;
  /** DESIGNER_SEED=demo: .fig files imported into a "Samples" folder when the workspace has no files */
  seedFigs?: string[];
  /** The preview viewer's built page (out/viewer/index.html), for "Export preview as HTML…" (docs/data.md §13) */
  viewerTemplate?: string | null;
  /** How the store reaches the multiplayer server (shared files, previews); the global fetch by default (tests: the Worker's handler) */
  fetch?: typeof fetch;
  /** Personal Drafts in the cloud (docs/cloud.md §2): signed in, the workspace is the account's cache (default on;
   *  tests of local files' own behaviour turn it off) */
  personalDrafts?: boolean;
  /** How long a lock held by another live process is waited for (default 5 s) */
  lockWaitMs?: number;
}

const defaultLog: Log = (level, message, detail) => {
  if (level === "debug" && process.env.DESIGNER_LOG !== "debug") return;
  const line = `[store] ${level}: ${message}`;
  if (level === "error" || level === "warn") console.error(line, detail ?? "");
  else console.log(line, detail ?? "");
};

/** Workspaces locked by live stores of this process (a stale lock with our own pid is a crashed store). */
const LOCKED_HERE = new Set<string>();

/** `ps -o etime=` ("[[dd-]hh:]mm:ss") in seconds; null when unreadable. */
export function parseElapsed(etime: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(etime);
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/** When the live process `pid` started (wall clock ms), or null where `ps` can't tell (Windows, an error). */
function processStartedAt(pid: number): number | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" } });
    const s = parseElapsed(out);
    return s === null ? null : Date.now() - s * 1000;
  } catch {
    return null;
  }
}

/**
 * Whether a live process that started at `startedAt` (wall clock ms; null: unknown) can be the one that wrote a lock
 * at `wroteAt`: one started after the lock was written got a dead store's pid (pids are reused), it holds nothing.
 */
export function canHoldLock(wroteAt: number | undefined, startedAt: number | null): boolean {
  if (typeof wroteAt !== "number" || startedAt === null) return true;
  return startedAt <= wroteAt + 5000; // ps counts whole seconds; slack for that
}

/**
 * Takes the workspace's lock. A live holder is waited for up to `waitMs`: the store of an app that is quitting (or of a
 * main process restarted by `npm run dev`) releases it within a few seconds, and failing at once made main's restarts
 * (no pause between them) fail too, until it gave up with "Wecra can't save changes right now".
 */
async function acquireLock(dirs: WorkspaceDirs, now: number, log: Log, waitMs: number): Promise<void> {
  const path = join(dirs.root, ".lock");
  const deadline = Date.now() + waitMs;
  for (let takeovers = 0; takeovers < 2; ) {
    try {
      const fd = openSync(path, "wx", 0o644);
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now, wroteAt: Date.now() }));
      closeSync(fd);
      LOCKED_HERE.add(dirs.root);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = await readJsonOrNull<{ pid: number; startedAt: number; wroteAt?: number }>(path);
    let alive = false;
    if (held && held.pid !== process.pid) {
      try {
        process.kill(held.pid, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === "EPERM";
      }
      // A killed store's pid since given to another process must not lock the workspace for good (the store would
      // fail to start on every try, and main give up, until the lock file was deleted by hand).
      if (alive && !canHoldLock(held.wroteAt, processStartedAt(held.pid))) alive = false;
    } else if (held?.pid === process.pid) alive = LOCKED_HERE.has(dirs.root);
    if (alive) {
      // Another process's (this process's own live store won't let go while we wait)
      if (held?.pid !== process.pid && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw new StoreError("io", tr("The workspace is in use by another process (pid {pid})", { pid: String(held?.pid) }));
    }
    log("warn", `taking over a stale workspace lock (pid ${held?.pid ?? "?"})`);
    await fsp.rm(path, { force: true });
    takeovers++;
  }
  throw new StoreError("io", tr("Couldn't lock the workspace"));
}

export class LocalStore {
  readonly workspaceEvents: Emitter<WorkspaceEvent>;
  readonly libraryEvents: Emitter<LibraryEvent>;
  readonly fileChanges: Emitter<FileChange>;
  private gcTimer: unknown = null;
  private closed = false;
  /** The session main handed over (`multiplayer.setSession`): previews publish with it (docs/multiplayer.md §9) */
  session: PreviewSession | null = null;
  private sessionHeard!: () => void;
  /** Main has said once whether a session is on (the login gate waits for it, src/store/server.ts) */
  readonly sessionKnown = new Promise<void>((resolve) => (this.sessionHeard = resolve));
  markSessionKnown(): void {
    this.sessionHeard();
  }
  /** The viewer's built page, for previews exported as HTML */
  viewerTemplate: string | null = null;
  /** Serializes previews.json */
  readonly previewQueue = new SerialQueue();
  /** Shared files' rooms (docs/multiplayer.md §5); idle until main hands over a session */
  /** Comments (docs/multiplayer.md §10): local files' in files/<key>/comments.json, shared files' on the server */
  readonly comments: CommentsService;
  /** The bell (docs/multiplayer.md §12): the person's inbox socket while a session is on */
  readonly notifications: NotificationsService;
  readonly multiplayer: MultiplayerService;
  /** How the store reaches the server: the global fetch, or a test's handler */
  readonly fetch: typeof globalThis.fetch;

  private constructor(
    readonly dirs: WorkspaceDirs,
    readonly ws: LocalWorkspace,
    readonly files: FileStore,
    readonly blobs: LocalBlobs,
    readonly libraries: LocalLibraries,
    /** 1 until the server gives this installation its own (docs/multiplayer.md §2.1) */
    public deviceOrdinal: number,
    readonly clock: Clock,
    readonly log: Log,
    readonly generation: number,
    private readonly compactor: Compactor,
    readonly timers: Timers,
    /** Stamps journal frames and records */
    readonly hlc: HlcClock,
    private readonly userDataDir: string | null = null,
    fetchFn?: typeof globalThis.fetch,
    personalDrafts = true,
  ) {
    this.fetch = fetchFn ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
    this.workspaceEvents = ws.events;
    // Local libraries' events and org libraries' (from the Inbox, src/store/libraries/org.ts) on one topic
    this.libraryEvents = new Emitter<LibraryEvent>();
    libraries.events.on((e) => this.libraryEvents.emit(e));
    this.fileChanges = files.changes;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the host's getter reads the live ordinal
    const self = this;
    this.multiplayer = new MultiplayerService(
      {
        fileChanges: files.changes,
        backlog: (fileKey, fromSeq) => files.backlog(fileKey, fromSeq),
        appendRemote: (fileKey, message) => files.appendRemote(fileKey, message),
        // The tree under concurrent moves (docs/multiplayer.md §18.12)
        appendCorrection: (fileKey, message) => files.appendSystem(fileKey, message, { kind: "system", label: "Multiplayer" }),
        structureAt: (fileKey, skip) => files.structureAt(fileKey, skip),
        createSharedFile: (input) => this.createSharedFile(input),
        fillFile: (fileKey, snapshot, message) => this.fillCloudFile(fileKey, snapshot, message),
        newFileKey: () => newFileKey(),
        newDocument: () => codec.encodeMessage(newDocumentMessage()),
        setFileSpace: async (fileKey, space) => void (await ws.queue.run(() => ws.setFileSpace(fileKey, space))),
        getMeta: (fileKey) => (ws.files.has(fileKey) ? ws.getMeta(fileKey) : null),
        get deviceOrdinal() {
          return self.deviceOrdinal;
        },
        setDeviceOrdinal: (ordinal) => this.setDeviceOrdinal(ordinal),
        load: () => readJsonOrNull(join(dirs.root, "multiplayer.json")),
        saveInstallationId: (id) => this.saveMultiplayer((s) => (s.installationId = id)),
        saveLink: (fileKey, link) =>
          this.saveMultiplayer((s) => {
            s.links ??= {};
            if (link) s.links[fileKey] = link;
            else delete s.links[fileKey];
          }),
        log,
        hasBlobs: (sha1s) => blobs.has(sha1s),
        getBlob: (sha1) => blobs.get(sha1),
        putBlob: async (bytes) => void (await blobs.put(bytes)),
        headSnapshot: async (fileKey) => codec.encodeMessage(currentMessage(await readSnapshotFile((await files.compactedHead(fileKey)).path))),
        thumbnail: async (fileKey) => (ws.files.has(fileKey) && ws.getMeta(fileKey).thumbnail ? new Uint8Array(await fsp.readFile(join(dirs.files, fileKey, "thumbnail.png")).catch(() => new Uint8Array())) : null),
        blobSizes: (sha1s) => Promise.all(sha1s.map((sha1) => fsp.stat(blobs.path(sha1)).then((st) => st.size, () => 0))),
        // The upload panel's destination (docs/multiplayer.md §5.1): the org's, team's and folder's names from the org cache
        describeUpload: (fileKey, place) =>
          uploadDestination(place, {
            orgName: async (id) => (await this.org.orgs.get(id)).name,
            teamName: async (id) => (await this.org.teams.get(id)).name,
            projectName: async (id) => (await this.org.projects.get(id)).name,
            localFolder: () => {
              const folderId = ws.files.has(fileKey) ? ws.getMeta(fileKey).folderId : null;
              return (folderId && ws.folders.get(folderId)?.name) || null;
            },
          }),
      },
      // Upload bodies stream so the upload panel sees their bytes go (Node's fetch streams a request with `duplex`); a
      // test's in-process handler gets them whole
      { fetch: this.fetch, WebSocket: globalThis.WebSocket as never, random: () => randomInt(0, 2 ** 32) / 2 ** 32, streamUploads: !fetchFn },
    );
    const commentsPath = (fileKey: FileKey) => {
      if (!ws.files.has(fileKey)) throw new StoreError("not-found", tr("No such file"));
      return join(dirs.files, fileKey, "comments.json");
    };
    this.comments = new CommentsService(
      {
        load: async (fileKey) => readJsonOrNull(commentsPath(fileKey)),
        save: (fileKey, record) => this.commentsQueue.run(() => writeJsonAtomic(dirs.tmp, commentsPath(fileKey), record)),
        now: () => clock.now(),
        random: () => randomInt(0, 2 ** 32) / 2 ** 32,
      },
      this.multiplayer,
    );
    // A shared file's image still coming down is waited for by whoever reads it (docs/cloud.md §4.1)
    blobs.whenMissing = (sha1) => this.multiplayer.wantBlob(sha1);
    this.notifications = new NotificationsService(this.multiplayer, { WebSocket: globalThis.WebSocket as never });
    this.personal = new PersonalService(this.multiplayer, this.personalHost(), this.notifications, { enabled: personalDrafts });
    const spacePath = (orgId: string) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(orgId)) throw new StoreError("invalid", `bad org id ${orgId}`);
      return join(dirs.root, "spaces", `${orgId}.json`);
    };
    this.org = new OrgService(
      this.multiplayer,
      {
        loadCache: (orgId) => readJsonOrNull(spacePath(orgId)),
        saveCache: (orgId, cache) =>
          this.spacesQueue.run(async () => {
            if (!cache) return void (await fsp.rm(spacePath(orgId), { force: true }));
            await ensureDir(join(dirs.root, "spaces"));
            await writeJsonAtomic(dirs.tmp, spacePath(orgId), cache);
          }),
        cachedOrgIds: async () => (await fsp.readdir(join(dirs.root, "spaces")).catch(() => [] as string[])).filter((n) => /^[A-Za-z0-9_-]{1,64}\.json$/.test(n)).map((n) => n.slice(0, -5)),
        createOrgFile: (input) => this.createOrgFile(input),
        deleteLocalFile: (fileKey) => this.deleteItems({ files: [fileKey], folders: [] }),
        setFileSpace: async (fileKey, space) => void (await ws.queue.run(() => ws.setFileSpace(fileKey, space))),
        getMeta: (fileKey) => (ws.files.has(fileKey) ? ws.getMeta(fileKey) : null),
        headSnapshot: async (fileKey) => codec.encodeMessage(currentMessage(await readSnapshotFile((await files.compactedHead(fileKey)).path))),
        log,
        now: () => clock.now(),
      },
      this.notifications,
    );
    this.branches = new BranchService(localBranchHost({ dirs, ws, files, libraries, multiplayer: this.multiplayer, clock, log, timers }));
    // Governance+'s refusals as org events (docs/governance.md §2.5): Home re-reads the org's gate
    this.governanceEvents = governanceEvents(this.multiplayer, this.org, () => clock.now());
    const mp = this.multiplayer;
    this.roomVersions = new RoomVersions({
      // Signed out, a shared file's history is its local copy's checkpoints.
      roomKey: async (fileKey) => (mp.signedIn ? mp.roomKey(fileKey) : null),
      call: (method, path, body) => mp.call(method, path, body),
      callBytes: (method, path) => mp.callBytes(method, path),
      syncState: (fileKey) => mp.syncState(fileKey),
      flushedHead: async (fileKey) => (await files.flush(fileKey), files.headSeqOf(fileKey)),
      headTable: async (fileKey) => (await files.headTable(fileKey)).table,
      downloadBlobs: (key, sha1s) => mp.downloadBlobs(key, sha1s),
      getMeta: (fileKey) => ws.getMeta(fileKey),
      addFile: async (input) => {
        const key = newFileKey();
        await files.createFile(key, input.snapshot, input.images, 0);
        const meta = newMeta(key, input.name, null, clock.now());
        meta.enabledLibraries = [...input.enabledLibraries];
        return this.addDraft(meta);
      },
      now: () => clock.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });

    // Libraries in organizations and their analytics (docs/data.md §16, §17): caches under Workspace/spaces/
    const spaces = join(dirs.root, "spaces");
    const cachePath = (name: string) => join(spaces, ...name.split("/"));
    const cache: LibraryCacheStore = {
      readJson: (name) => readJsonOrNull(cachePath(name)),
      writeJson: (name, value) =>
        this.spacesQueue.run(async () => {
          await ensureDir(dirname(cachePath(name)));
          await writeJsonAtomic(dirs.tmp, cachePath(name), value);
        }),
      readBytes: async (name) => fsp.readFile(cachePath(name)).then((b) => new Uint8Array(b), () => null),
      writeBytes: async (name, bytes) => {
        await ensureDir(dirname(cachePath(name)));
        await atomicWrite(dirs.tmp, cachePath(name), bytes);
      },
    };
    this.libraryServer = libraryServerOf(this.multiplayer);
    const patchFile = (fileKey: FileKey, patch: Partial<FileMeta>) => ws.queue.run(() => ws.patchFile(fileKey, patch));
    const copyOf = (roomKey: string) => [...ws.files.values()].find((m) => m.space?.key === roomKey) ?? null;
    this.orgLibraries = new OrgLibraries(
      {
        server: this.libraryServer,
        cache,
        getMeta: (fileKey) => ws.files.get(fileKey) ?? null,
        copyOf,
        patchFile,
        blobs,
        pngSize,
        // deflate-raw, not zstd: the browser's dev store reads what the desktop publishes (DecompressionStream)
        encodePayload: (message) => encodeCanvas({ schema: SCHEMA_BINARY, message, version: DOCUMENT_FORMAT_VERSION, compression: "deflate-raw" }, nodeCodecs),
        decodePayload: async (bytes) => {
          const c = decodeCanvas(bytes, nodeCodecs);
          return isCurrentSchema(c.schema) ? own(c.message) : codec.encodeMessage(decodeWithSchema(c.schema, c.message).message);
        },
        log,
      },
      this.notifications,
    );
    this.orgLibraries.watch((e) => this.libraryEvents.emit(e));
    this.libraryRouter = new LibraryRouter(
      {
        listAvailable: async (forFileKey) => libraries.listAvailable(forFileKey),
        getRecord: async (lib) => libraries.getRecord(lib),
        getVersion: (lib, version) => libraries.getVersion(lib, version),
        previewPublish: (lib, assets) => libraries.previewPublish(lib, assets ?? []),
        publish: (req) => libraries.publish(req),
        unpublish: (lib) => libraries.unpublish(lib),
        setEnabled: (fileKey, lib, enabled) => libraries.setEnabled(fileKey, lib, !!enabled),
        getPayloads: (lib, wants, opts) => libraries.getPayloads(lib, wants ?? [], { withDependencies: !!opts?.withDependencies }),
        diff: (lib, have) => libraries.diff(lib, have ?? []),
        watch: (listener) => libraries.events.on(listener),
      },
      this.orgLibraries,
      { getMeta: (fileKey) => ws.files.get(fileKey) ?? null, copyOf, patchFile, moved: libraries, log },
    );
    const json = (name: string) => ({ load: () => readJsonOrNull(join(spaces, name)), save: (v: unknown) => this.spacesQueue.run(async () => (await ensureDir(spaces), await writeJsonAtomic(dirs.tmp, join(spaces, name), v))) });
    const queueFile = json("analytics-queue.json");
    this.analytics = new AnalyticsQueue({ server: this.libraryServer, getMeta: (fileKey) => ws.files.get(fileKey) ?? null, load: queueFile.load, save: queueFile.save, now: () => clock.now(), timers, log });
    this.analytics.start();
    this.notifications.onReconnect(() => void this.analytics.flush());
    const usageFile = json("analytics-usage.json");
    this.usage = new UsageReporter({
      server: this.libraryServer,
      getMeta: (fileKey) => ws.files.get(fileKey) ?? null,
      readDocument: async (fileKey) => {
        const { table, seq } = await files.headTable(fileKey);
        return { nodes: table.toMessage().nodeChanges ?? [], headSeq: seq };
      },
      load: usageFile.load,
      save: usageFile.save,
      now: () => clock.now(),
      timers,
      log,
    });
    files.changes.on((c) => this.usage.touched(c.fileKey));

    // Plugins (docs/plugins.md §6, §10): saved / recents in plugins.json, private plugins cached under spaces/plugins/
    const pluginsPath = join(dirs.root, "plugins.json");
    this.plugins = new PluginsService({
      server: this.libraryServer,
      cache,
      loadLocal: () => readJsonOrNull(pluginsPath),
      saveLocal: (value) => this.spacesQueue.run(() => writeJsonAtomic(dirs.tmp, pluginsPath, value)),
      getMeta: (fileKey) => ws.files.get(fileKey) ?? null,
      orgInfo: (orgId) => this.org.orgs.get(orgId).catch(() => null),
      teamWorkspace: (teamId) => this.org.teams.get(teamId).then((t) => t.workspaceId),
      notices: this.notifications,
      now: () => clock.now(),
      log,
    });
    // Dev Mode (docs/editor.md D-1, D-3, D-4, D-6): a local file's records beside its journal
    const devPath = (fileKey: FileKey, what: LocalDevRecord) => {
      if (!isFileKey(fileKey)) throw new StoreError("invalid", `bad file key ${fileKey}`);
      return join(dirs.files, fileKey, `${what}.json`);
    };
    this.devMode = new DevModeService({
      server: this.libraryServer,
      getMeta: (fileKey) => ws.files.get(fileKey) ?? null,
      roomKey: (fileKey) => this.multiplayer.roomKey(fileKey),
      linkedCopy: (key) => this.multiplayer.linkedCopy(key),
      branchOf: async (fileKey) => {
        const r = await this.branches.get(fileKey);
        return r ? { mainFileKey: r.mainFileKey, mainKey: r.mainKey } : null;
      },
      readLocal: (fileKey, what) => readJsonOrNull(devPath(fileKey, what)),
      writeLocal: (fileKey, what, value) => writeJsonAtomic(dirs.tmp, devPath(fileKey, what), value),
      now: () => clock.now(),
    });
    // Other people's dev resources / Code Connect changes, said by the file's room: open copies read them again.
    this.multiplayer.onDevMode((fileKey, what) => void this.multiplayer.roomKey(fileKey).then((room) => this.devMode.roomChanged(fileKey, room, what), () => this.devMode.roomChanged(fileKey, null, what)));

    // AI (docs/ai.md §2.9, §2.10): the usage ledger, Skills and the org reports under Workspace/spaces/ai/
    const aiRoot = join(spaces, "ai");
    const aiPath = (name: string) => {
      if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/.test(name) || name.includes("..")) throw new StoreError("invalid", `bad AI file name ${name}`);
      return join(aiRoot, ...name.split("/"));
    };
    this.ai = new AiService({
      read: (name) => fsp.readFile(aiPath(name), "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e))),
      write: async (name, text) => {
        await ensureDir(dirname(aiPath(name)));
        await atomicWrite(dirs.tmp, aiPath(name), text);
      },
      remove: (name) => fsp.rm(aiPath(name), { force: true }),
      list: (dir) => fsp.readdir(aiPath(dir)).catch(() => [] as string[]),
      server: this.libraryServer,
      getMeta: (fileKey) => ws.files.get(fileKey as FileKey) ?? null,
      newId: () => base62(16),
      now: () => clock.now(),
      timers,
      log,
    });
    this.multiplayer.onSession(() => void this.ai.flush());

    // The brand and product library (docs/studio.md §3.1): Workspace/spaces/brands/<brandId>/brand.json and images/
    const brandsRoot = join(spaces, "brands");
    const brandPath = (name: string) => {
      if (!/^[A-Za-z0-9_-]{1,64}(\/(brand\.json|images\/[A-Za-z0-9_-]{1,64}\.(png|jpg|webp)))?$/.test(name)) throw new StoreError("invalid", `bad library file name ${name}`);
      return join(brandsRoot, ...name.split("/"));
    };
    this.brands = new BrandsService({
      read: (name) => fsp.readFile(brandPath(name), "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e))),
      write: async (name, text) => {
        await ensureDir(dirname(brandPath(name)));
        await atomicWrite(dirs.tmp, brandPath(name), text);
      },
      readBytes: (name) => fsp.readFile(brandPath(name)).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength), (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e))),
      writeBytes: async (name, bytes) => {
        await ensureDir(dirname(brandPath(name)));
        await atomicWrite(dirs.tmp, brandPath(name), bytes);
      },
      remove: (name) => fsp.rm(brandPath(name), { force: true, recursive: true }),
      brandIds: () => fsp.readdir(brandsRoot, { withFileTypes: true }).then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name), () => [] as string[]),
      newId: () => base62(12),
      now: () => clock.now(),
      log,
    });

    // Visual search (docs/ai.md §6): one index per file under Workspace/spaces/search/
    const searchRoot = join(spaces, "search");
    const searchPath = (name: string) => {
      if (!/^[A-Za-z0-9_-]+\.idx$/.test(name)) throw new StoreError("invalid", `bad search index name ${name}`);
      return join(searchRoot, name);
    };
    this.search = new SearchService({
      read: (name) => fsp.readFile(searchPath(name)).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength), (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e))),
      write: async (name, bytes) => {
        await ensureDir(searchRoot);
        await atomicWrite(dirs.tmp, searchPath(name), bytes);
      },
      remove: (name) => fsp.rm(searchPath(name), { force: true }),
      list: () => fsp.readdir(searchRoot).catch(() => [] as string[]),
      getMeta: (fileKey) => ws.files.get(fileKey as FileKey) ?? null,
      log,
    });
  }

  /** The AI usage ledger, Skills, the org reports (docs/ai.md §2.9) */
  readonly ai: AiService;
  /** The brand and product library (docs/studio.md §3) */
  readonly brands: BrandsService;
  /** The visual search index (docs/ai.md §6) */
  readonly search: SearchService;

  /** Saved / recents, private plugins and approvals (docs/plugins.md §10); events on topic `plugins` */
  readonly plugins: PluginsService;
  /** Dev resources, Code Connect, statuses' reports, prototype members (docs/editor.md D-8); events on topic `devmode` */
  readonly devMode: DevModeService;

  /** The server as the libraries reach it */
  readonly libraryServer: LibraryServer;
  /** Org libraries (docs/data.md §16.3), behind the router with the local ones */
  readonly orgLibraries: OrgLibraries;
  readonly libraryRouter: LibraryRouter;
  /** Library analytics' queue (§17.5) and instance snapshots (§17.4) */
  readonly analytics: AnalyticsQueue;
  readonly usage: UsageReporter;
  /** Shared fonts changed (docs/desktop.md §14.3): the Inbox's `{t: "fonts"}` on topic `fonts` */
  readonly fonts = { onEvent: (listener: (e: FontsEvent) => void): Unsubscribe => this.notifications.onFonts((n) => listener({ orgId: n.orgId, version: n.version })) };

  /** Shared files' version history: their rooms' (docs/data.md §15.7.1) */
  readonly roomVersions: RoomVersions;

  /** The org spaces (docs/multiplayer.md §14.6): the server's orgs, teams, folders and their files, cached per org */
  readonly org: OrgService;
  /** Personal Drafts in the cloud and the cache the workspace is (docs/cloud.md §2) */
  readonly personal: PersonalService;

  /** The personal service's view of the disk (docs/cloud.md §2) */
  private personalHost(): ConstructorParameters<typeof PersonalService>[1] {
    const { ws, files, dirs } = this;
    const blobSizes = new Map<string, number>();
    const blobSize = async (sha1: string) => {
      let n = blobSizes.get(sha1);
      if (n === undefined) {
        n = await fsp.stat(this.blobs.path(sha1)).then((st) => st.size, () => 0);
        blobSizes.set(sha1, n);
      }
      return n;
    };
    return {
      metas: () => ws.files.values(),
      getMeta: (fileKey) => ws.files.get(fileKey) ?? null,
      patchMeta: async (fileKey, patch) => void (ws.files.has(fileKey) && (await ws.queue.run(() => ws.patchFile(fileKey, patch)))),
      addRemote: async (input) => {
        const fileKey = newFileKey();
        await ensureDir(join(dirs.files, fileKey));
        const meta = newMeta(fileKey, input.name.trim() || "Untitled", null, input.createdAt);
        meta.updatedAt = input.updatedAt;
        meta.trashedAt = input.trashedAt;
        meta.cloud = { ...input.cloud };
        return ws.queue.run(() => ws.addFile(meta));
      },
      forget: (fileKey) => this.deleteItems({ files: [fileKey], folders: [] }),
      dropDocument: async (fileKey) => {
        await files.dropDocument(fileKey);
        this.scheduleGc(60_000);
      },
      documentSize: async (fileKey) => {
        let n = await files.sizeOf(fileKey);
        for (const sha1 of await files.blobRefsOf(fileKey)) n += await blobSize(sha1);
        return n;
      },
      isOpen: (fileKey) => files.openFiles().some((f) => f.fileKey === fileKey && f.sessions > 0),
      isLibrary: (fileKey) => this.libraries.getRecord(fileKey)?.status === "published",
      lastOpened: (fileKey) => ws.prefs.viewedAt[fileKey] ?? null,
      trashedAt: (meta) => {
        if (meta.trashedAt !== null) return meta.trashedAt;
        for (let id = meta.folderId, guard = 0; id && guard < 12; guard++) {
          const f = ws.folders.get(id);
          if (!f) break;
          if (f.trashedAt !== null) return f.trashedAt;
          id = f.parentId;
        }
        return null;
      },
      folderPath: (meta) => {
        const names: string[] = [];
        for (let id = meta.folderId, guard = 0; id && guard < 12; guard++) {
          const f = ws.folders.get(id);
          if (!f) break;
          names.unshift(f.name);
          id = f.parentId;
        }
        return names;
      },
      setAccount: (uid) => ws.setAccount(uid),
      headSnapshot: async (fileKey) => codec.encodeMessage(currentMessage(await readSnapshotFile((await files.compactedHead(fileKey)).path))),
      headSeq: async (fileKey) => (await files.flush(fileKey), files.headSeqOf(fileKey)),
      load: () => readJsonOrNull(join(dirs.root, "cloud.json")),
      save: (state: CloudState) => writeJsonAtomic(dirs.tmp, join(dirs.root, "cloud.json"), state),
      log: this.log,
      now: () => this.clock.now(),
      setTimeout: (fn, ms) => this.timers.setTimeout(fn, ms),
      clearTimeout: (h) => this.timers.clearTimeout(h),
    };
  }

  /** A cloud file listed from the server gets its room's document (docs/cloud.md §2), as a shared file's copy does */
  async fillCloudFile(fileKey: FileKey, snapshot: Uint8Array, message?: Message): Promise<void> {
    this.guard();
    this.ws.getMeta(fileKey);
    let table: NodeTable;
    try {
      table = NodeTable.fromMessage(message ?? codec.decodeMessage(snapshot));
    } catch (e) {
      throw new StoreError("corrupt", tr("The file couldn't be read: {reason}", { reason: (e as Error).message }));
    }
    if (!table.get("0:0")) throw new StoreError("corrupt", tr("The file has no document"));
    await this.files.createFile(fileKey, snapshot, [...table.imageHashes()].sort(), table.derivedDataVersion);
    // New edit sessions here never reuse one of this device's earlier sessions of the file (its GUIDs are in the room):
    // past the counter kept when it was evicted and past every session of this device the snapshot holds
    let next = Number((await readJsonOrNull<{ nextLocal?: unknown }>(join(this.dirs.files, fileKey, "sessions.json")))?.nextLocal) || 1;
    for (const guid of table.nodes.keys()) {
      const { deviceOrdinal, n } = splitSessionId(Number(guid.split(":")[0]));
      if (deviceOrdinal === this.deviceOrdinal) next = Math.max(next, n + 1);
    }
    if (next > 1) await this.setNextLocal(fileKey, next);
    this.files.forgetSize(fileKey);
  }

  /** A new file's record: signed in, a draft of the account registered on the server (docs/cloud.md §2) */
  private async addDraft(meta: FileMeta): Promise<FileMeta> {
    this.personal.asDraft(meta);
    const added = await this.ws.queue.run(() => this.ws.addFile(meta));
    this.personal.created(added.fileKey);
    return added;
  }
  /** Governance+'s refusals (docs/governance.md §2.5, round 14e) on topic `org` (`access.blocked`) */
  readonly governanceEvents: ReturnType<typeof governanceEvents>;
  /** Branches (docs/data.md §15): records, merge previews, Update from main and Merge; events on topic `branches` */
  readonly branches: BranchService;
  private readonly spacesQueue = new SerialQueue();

  /** A new org file's local copy (docs/multiplayer.md §14.6): an empty document, its `space` set from the start. */
  async createOrgFile(input: { name: string; space: FileSpace }): Promise<FileMeta> {
    this.guard();
    const fileKey = newFileKey();
    await this.files.createFile(fileKey, codec.encodeMessage(newDocumentMessage({ thumbnail: true })), []);
    const meta = newMeta(fileKey, input.name.trim() || "Untitled", null, this.clock.now());
    meta.space = { ...input.space };
    return this.ws.queue.run(() => this.ws.addFile(meta));
  }

  private readonly commentsQueue = new SerialQueue();
  private readonly multiplayerQueue = new SerialQueue();
  /** multiplayer.json, read-modify-written one change at a time */
  private saveMultiplayer(change: (s: { installationId?: unknown; links?: Record<string, unknown> }) => void): Promise<void> {
    return this.multiplayerQueue.run(async () => {
      const path = join(this.dirs.root, "multiplayer.json");
      const s = (await readJsonOrNull<{ installationId?: unknown; links?: Record<string, unknown> }>(path)) ?? {};
      change(s);
      await writeJsonAtomic(this.dirs.tmp, path, s);
    });
  }

  /** The server's ordinal for this installation: new edit sessions and stamps use it, and the next start reads it. */
  async setDeviceOrdinal(ordinal: number): Promise<void> {
    if (!Number.isInteger(ordinal) || ordinal < 2 || ordinal > 4095) throw new StoreError("invalid", `device ordinal out of range: ${ordinal}`);
    this.deviceOrdinal = ordinal;
    this.files.setDeviceOrdinal(ordinal);
    this.hlc.setDeviceOrdinal(ordinal);
    if (this.userDataDir) await writeJsonAtomic(this.dirs.tmp, join(this.userDataDir, "device.json"), { ordinal, createdAt: this.clock.now(), from: "server" });
  }

  /** A file shared with the user: the room's snapshot as it is — no GUID remapping, so its nodes keep the room's ids. */
  async createSharedFile(input: { name: string; snapshot: Uint8Array; space?: FileSpace | null; fileKey?: FileKey; message?: Message }): Promise<FileMeta> {
    this.guard();
    let table: NodeTable;
    try {
      table = NodeTable.fromMessage(input.message ?? codec.decodeMessage(input.snapshot));
    } catch (e) {
      throw new StoreError("corrupt", tr("The shared file couldn't be read: {reason}", { reason: (e as Error).message }));
    }
    if (!table.get("0:0")) throw new StoreError("corrupt", tr("The shared file has no document"));
    const key = input.fileKey ?? newFileKey();
    await this.files.createFile(key, input.snapshot, [...table.imageHashes()].sort(), table.derivedDataVersion);
    const meta = newMeta(key, input.name.trim() || "Untitled", null, this.clock.now());
    if (input.space) meta.space = { ...input.space };
    return this.ws.queue.run(() => this.ws.addFile(meta));
  }

  static async open(opts: LocalStoreOptions): Promise<LocalStore> {
    const clock = opts.clock ?? systemClock;
    const log = opts.log ?? defaultLog;
    const dirs = workspaceDirs(opts.workspaceDir);
    await ensureDir(dirs.root);
    await acquireLock(dirs, clock.now(), log, opts.lockWaitMs ?? 5000);
    try {
      // tmp/ holds only staging files of interrupted atomic writes; .trash-pending/ finishes earlier deletions.
      await fsp.rm(dirs.tmp, { recursive: true, force: true });
      await ensureDir(dirs.tmp);
      await ensureDir(dirs.trashPending);
      for (const n of await fsp.readdir(dirs.trashPending)) void fsp.rm(join(dirs.trashPending, n), { recursive: true, force: true });

      const deviceOrdinal = opts.deviceOrdinal ?? (await readDeviceOrdinal(opts.userDataDir, dirs));
      const hlc = new HlcClock(deviceOrdinal, clock);
      const schemas = new SchemaRegistry(dirs.schemas, dirs.tmp);
      await ensureDir(dirs.schemas);
      await schemas.ensureCurrent();
      const ws = await LocalWorkspace.load({ dirs, hlc, clock, log, teamName: opts.teamName, rebuildMeta: (k) => rebuildMeta(dirs, k, clock) });
      const blobs = new LocalBlobs(dirs.blobs, dirs.tmp);
      const timers = opts.timers ?? {
        setTimeout: (fn: () => void, ms: number) => {
          const t = setTimeout(fn, ms);
          t.unref?.();
          return t;
        },
        clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
      };
      const compactor = opts.compactor ?? inlineCompactor;
      // A branch at the end of its GUID block asks its main file for the next (docs/data.md §15.2).
      const late: { store: LocalStore | null } = { store: null };
      const files = new FileStore({ dirs, workspace: ws, schemas, hlc, clock, deviceOrdinal, compactor, log, timers, nextSessionBlock: (k) => late.store?.branches.nextSessionBlock(k) ?? Promise.resolve(null), editor: () => late.store?.multiplayer.userId ?? null });
      const libraries = new LocalLibraries({ dirs, workspace: ws, files, blobs, hlc, clock, log });
      await libraries.load();
      ws.sizeOf = (k) => files.cachedSize(k);
      const store = new LocalStore(dirs, ws, files, blobs, libraries, deviceOrdinal, clock, log, opts.generation ?? 1, compactor, timers, hlc, opts.userDataDir ?? null, withFakeLatency(opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)), process.env.DESIGNER_FAKE_LATENCY_MS), opts.personalDrafts !== false);
      store.viewerTemplate = opts.viewerTemplate ?? null;
      late.store = store;
      void store.branches.load().catch((e) => log("warn", "loading branches failed", e));
      // Background start-up work: sizes for the file list, version thinning, the first GC.
      void Promise.all([...ws.files.keys()].map((k) => files.sizeOf(k).catch(() => 0))).catch(() => {});
      void files.thinAll([...ws.files.keys()]).catch((e) => log("warn", "version thinning failed", e));
      const gcDelay = opts.gcDelayMs === undefined ? 10 * 60 * 1000 : opts.gcDelayMs;
      if (gcDelay !== null) store.scheduleGc(gcDelay);
      if (opts.seedFigs?.length && ws.files.size === 0) await store.seed(opts.seedFigs);
      return store;
    } catch (e) {
      await fsp.rm(join(dirs.root, ".lock"), { force: true });
      LOCKED_HERE.delete(dirs.root);
      throw e;
    }
  }

  private scheduleGc(ms: number): void {
    if (this.gcTimer) this.timers.clearTimeout(this.gcTimer);
    this.gcTimer = this.timers.setTimeout(() => {
      this.gcTimer = null;
      void this.collectGarbage().catch((e) => this.log("warn", "blob GC failed", e));
    }, ms);
  }

  private async seed(paths: string[]): Promise<void> {
    const folder = await this.ws.queue.run(() => this.ws.createFolder({ name: "Samples", parentId: null }, newFolderId()));
    for (const p of paths) await this.importLocalCopy(p, folder.id).catch((e) => this.log("warn", `seed ${p} failed`, e));
  }

  private guard(): void {
    if (this.closed) throw new StoreError("shutting-down", tr("The store is shutting down"));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Workspace operations that span records and file data
  // -------------------------------------------------------------------------------------------------------------------

  private checkFolder(folderId: FolderId | null): void {
    if (folderId === null) return;
    this.ws.getFolder(folderId);
    if (this.ws.isFolderTrashed(folderId)) throw new StoreError("trashed", tr("That folder is in Trash"));
  }

  async createFile(input: { name?: string; folderId: FolderId | null }): Promise<FileMeta> {
    this.guard();
    const folderId = input?.folderId ?? null;
    this.checkFolder(folderId);
    const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim() : "Untitled";
    const libs = this.ws.workspace.defaultLibraries.filter((k) => this.libraries.getRecord(k)?.status === "published" && this.ws.files.has(k));
    const fileKey = newFileKey();
    const doc = newDocumentMessage({ libraries: libs.map((k) => ({ libraryKey: k, name: this.ws.files.get(k)!.name })), thumbnail: true });
    await this.files.createFile(fileKey, codec.encodeMessage(doc), []);
    const meta = newMeta(fileKey, name, folderId, this.clock.now());
    meta.enabledLibraries = libs;
    return this.addDraft(meta);
  }

  async duplicateFile(fileKey: FileKey): Promise<FileMeta> {
    this.guard();
    await this.personal.ensureLocal(fileKey);
    const src = this.ws.getMeta(fileKey);
    const head = await this.files.compactedHead(fileKey);
    const key = newFileKey();
    await this.createDuplicate(key, head.path, head.blobRefs, head.derivedDataVersion);
    const folderId = src.folderId && !this.ws.isFolderTrashed(src.folderId) ? src.folderId : null;
    const meta = newMeta(key, `${src.name} (Copy)`, folderId, this.clock.now());
    meta.enabledLibraries = [...src.enabledLibraries];
    meta.thumbnail = await this.copyThumbnail(fileKey, key, src.thumbnail);
    return this.addDraft(meta);
  }

  /**
   * A duplicate's first snapshot (Duplicate file, Duplicate version): the snapshot as it is, except that its local
   * assets are new assets — no key, published version or move of the original's (docs/schema.md §8.1).
   */
  private async createDuplicate(key: FileKey, snapshotPath: string, blobRefs: string[], derivedDataVersion = 0): Promise<void> {
    const message = currentMessage(await readSnapshotFile(snapshotPath));
    const fresh = withNewAssetIdentity(message);
    if (fresh === message) await this.files.createFileFromSnapshot(key, snapshotPath, blobRefs, derivedDataVersion || (message.derivedDataVersion ?? 0));
    else await this.files.createFile(key, codec.encodeMessage(fresh), blobRefs, fresh.derivedDataVersion ?? 0);
  }

  private async copyThumbnail(from: FileKey, to: FileKey, thumb: FileMeta["thumbnail"]): Promise<FileMeta["thumbnail"]> {
    if (!thumb) return null;
    try {
      await fsp.copyFile(join(this.dirs.files, from, "thumbnail.png"), join(this.dirs.files, to, "thumbnail.png"));
      return { version: 1, width: thumb.width, height: thumb.height };
    } catch {
      return null;
    }
  }

  async trash(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<void> {
    this.guard();
    // A registered draft goes to the server's trash first (docs/cloud.md §2)
    await this.personal.trashFirst(items?.files ?? [], true);
    const { files } = await this.ws.queue.run(() => this.ws.trash(items ?? {}));
    for (const f of files) await this.libraries.fileTrashed(f.fileKey);
  }

  async restore(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<void> {
    this.guard();
    await this.personal.trashFirst(items?.files ?? [], false);
    const { files } = await this.ws.queue.run(() => this.ws.restore(items ?? {}));
    for (const k of files) await this.libraries.fileRestored(k);
  }

  async deleteForever(items: { files?: FileKey[]; folders?: FolderId[] }): Promise<void> {
    this.guard();
    const doomed = this.ws.collectDeletion(items ?? {});
    // A registered draft is deleted on the server first (docs/cloud.md §2)
    await this.personal.deleteFirst(doomed.files);
    await this.deleteItems(doomed);
  }

  async emptyTrash(): Promise<void> {
    this.guard();
    // Signed in, the trash Home shows: the account's drafts (docs/cloud.md §2)
    const contents = this.ws.account !== null ? { files: this.ws.listFiles({ in: "trash" }).map((f) => f.fileKey), folders: [] } : this.ws.trashContents();
    const doomed = this.ws.collectDeletion(contents);
    await this.personal.deleteFirst(doomed.files);
    await this.deleteItems(doomed);
  }

  private async deleteItems(doomed: { files: FileKey[]; folders: FolderId[] }): Promise<void> {
    for (const k of doomed.files) {
      this.branches.forget(k);
      await this.files.deleteFileData(k);
      await this.libraries.fileDeleted(k);
      await this.search.fileDeleted(k);
      await this.ws.queue.run(() => this.ws.forgetFile(k));
    }
    // Deepest folders first, so a parent never disappears before its children.
    const depth = (id: FolderId) => this.ws.folderDepth(id);
    for (const id of [...doomed.folders].sort((a, b) => depth(b) - depth(a))) await this.ws.queue.run(() => this.ws.forgetFolder(id));
    if (doomed.files.length) this.scheduleGc(0);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Versions, import, export
  // -------------------------------------------------------------------------------------------------------------------

  async createVersion(fileKey: FileKey, input: { kind?: "named" | "restore"; title?: string; description?: string; restoredFrom?: string }): Promise<VersionRecord> {
    this.guard();
    this.ws.getMeta(fileKey);
    const kind = input?.kind ?? "named";
    if (kind !== "named" && kind !== "restore") throw new StoreError("invalid", `bad version kind ${kind}`);
    if (kind === "restore") {
      if (!input.restoredFrom) throw new StoreError("invalid", "a restore version names the version it restored");
      await this.files.getVersion(fileKey, input.restoredFrom);
    }
    const title = typeof input?.title === "string" && input.title.trim() ? input.title.trim() : null;
    const description = typeof input?.description === "string" && input.description.trim() ? input.description.trim() : null;
    await this.files.flush(fileKey);
    return this.files.addVersion(fileKey, { kind, title, description, restoredFrom: kind === "restore" ? input.restoredFrom! : null, libraryVersion: null });
  }

  async duplicateVersion(fileKey: FileKey, id: string): Promise<FileMeta> {
    this.guard();
    const src = this.ws.getMeta(fileKey);
    const { record, path } = await this.files.getVersion(fileKey, id);
    const key = newFileKey();
    await this.createDuplicate(key, path, record.blobRefs, record.derivedDataVersion ?? 0);
    const meta = newMeta(key, `${src.name} (${record.title ?? versionDateLabel(record.createdAt)})`, null, this.clock.now());
    meta.enabledLibraries = [...src.enabledLibraries];
    return this.addDraft(meta);
  }

  async importLocalCopy(path: string, folderId: FolderId | null): Promise<FileMeta> {
    this.guard();
    if (typeof path !== "string" || !path) throw new StoreError("invalid", "importLocalCopy needs a path");
    this.checkFolder(folderId ?? null);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fsp.readFile(path));
    } catch (e) {
      throw new StoreError("not-found", `Couldn't read ${path}: ${(e as Error).message}`);
    }
    return this.importFig(bytes, path, folderId ?? null);
  }

  /** `files.importFigBytes`: a `.fig` the page read itself (Home's Import, a file dropped from Finder). */
  async importFigBytes(bytes: Uint8Array, name: string, folderId: FolderId | null = null, org?: unknown): Promise<FileMeta> {
    this.guard();
    if (!(bytes instanceof Uint8Array)) throw new StoreError("invalid", "importFigBytes needs the file's bytes");
    const place = cleanOrgPlace(org);
    const label = typeof name === "string" ? name : "";
    // An org shown in Home: into its Drafts or folder, as an org file (docs/multiplayer.md §5.1)
    if (place)
      return importIntoOrg(
        {
          mp: this.multiplayer,
          teamOf: async (projectId) => (await this.org.projects.get(projectId)).teamId,
          importLocal: (space) => this.importFig(bytes, label, null, space),
          headSnapshot: async (fileKey) => codec.encodeMessage(currentMessage(await readSnapshotFile((await this.files.compactedHead(fileKey)).path))),
          deleteLocal: (fileKey) => this.deleteItems({ files: [fileKey], folders: [] }),
          filesChanged: (orgId, projectId) => void this.org.notice({ t: "org", what: "files", orgId, ...(projectId ? { projectId } : {}) }),
          log: this.log,
        },
        place,
      );
    this.checkFolder(folderId ?? null);
    return this.importFig(bytes, label, folderId ?? null);
  }

  private async importFig(bytes: Uint8Array, name: string, folderId: FolderId | null, space?: FileSpace): Promise<FileMeta> {
    // The import keeps GUIDs below 2^20 and moves the rest to the new file's first session.
    const prepared = prepareFigImport(bytes, { name, sessionID: sessionIdFor(this.deviceOrdinal, 1) });
    for (const data of prepared.images.values()) await this.blobs.put(data);
    const key = newFileKey();
    await this.files.createFile(key, prepared.message, prepared.blobRefs, prepared.derivedDataVersion);
    await this.setNextLocal(key, 2);
    const meta = newMeta(key, prepared.name, folderId, this.clock.now());
    meta.importedFrom = { kind: "fig", name: prepared.name };
    // An org file's copy from the start: never listed among the local Drafts
    if (space) meta.space = { ...space };
    if (prepared.thumbnail) {
      const dims = pngSize(prepared.thumbnail);
      if (dims) {
        await atomicWrite(this.dirs.tmp, join(this.dirs.files, key, "thumbnail.png"), prepared.thumbnail);
        meta.thumbnail = { version: 1, width: dims.width, height: dims.height };
      }
    }
    if (prepared.report) this.log("info", `imported ${name}: ${prepared.report.nodesIn} → ${prepared.report.nodesOut} nodes`, prepared.report);
    // Into the person's Drafts (docs/cloud.md §2): a draft registered on the server, unless it is an org file's copy
    if (!space) this.personal.asDraft(meta);
    const created = await this.ws.queue.run(() => this.ws.addFile(meta));
    await this.files.addVersion(key, { kind: "import", title: null, description: null, restoredFrom: null, libraryVersion: null });
    if (!space) this.personal.created(key);
    return created;
  }

  private async setNextLocal(fileKey: FileKey, n: number): Promise<void> {
    const p = join(this.dirs.files, fileKey, "store.json");
    const s = await readJsonOrNull<{ sessions: { nextLocal: number } }>(p);
    if (!s) return;
    s.sessions.nextLocal = Math.max(s.sessions.nextLocal, n);
    await writeJsonAtomic(this.dirs.tmp, p, s);
  }

  /** Images the file's head uses that aren't in the blob store yet (a shared file's still downloading). */
  async missingImages(fileKey: FileKey): Promise<number> {
    this.guard();
    this.ws.getMeta(fileKey);
    const refs = await this.files.headBlobRefs(fileKey);
    return (await this.blobs.has(refs)).filter((here) => !here).length;
  }

  /** File settings (docs/home.md "File settings [ours]"): the file's bytes here by kind, its versions and its local activity. */
  async fileDetails(fileKey: FileKey): Promise<FileDetails> {
    this.guard();
    const meta = this.ws.getMeta(fileKey);
    const documentHere = await this.files.hasDocument(fileKey);
    const disk = documentHere ? await this.files.diskUsage(fileKey) : { document: 0, versions: 0, thumbnail: 0, frames: [] };
    const versions = documentHere ? await this.files.listVersions(fileKey) : [];
    const refs = documentHere ? await this.files.blobRefsOf(fileKey) : [];
    const previews = (await this.previewRecords()).filter((p) => p.fileKey === fileKey);
    const previewRefs = [...new Set(previews.flatMap((p) => p.blobRefs))].filter((r) => !refs.includes(r));
    return fileDetailsOf({
      meta,
      documentHere,
      disk,
      versions,
      blobs: await this.blobs.stat(refs),
      previews: { count: previews.length, at: previews.map((p) => p.updatedAt), bytes: (await this.blobs.stat(previewRefs)).reduce((n, b) => n + (b?.size ?? 0), 0) },
    });
  }

  async exportLocalCopy(fileKey: FileKey, path: string, opts: { partial?: boolean } = {}): Promise<void> {
    this.guard();
    if (typeof path !== "string" || !path) throw new StoreError("invalid", "exportLocalCopy needs a path");
    await this.personal.ensureLocal(fileKey);
    const meta = this.ws.getMeta(fileKey);
    const head = await this.files.compactedHead(fileKey);
    await writeLocalCopy({
      snapshotPath: head.path,
      meta,
      thumbnailPath: join(this.dirs.files, fileKey, "thumbnail.png"),
      blobRefs: head.blobRefs,
      blobs: this.blobs,
      tmpDir: this.dirs.tmp,
      path,
      now: this.clock.now(),
      partial: opts.partial === true,
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // GC, previews, admin
  // -------------------------------------------------------------------------------------------------------------------

  private async previewRecords(): Promise<PreviewRecord[]> {
    return (await readJsonOrNull<PreviewRecord[]>(join(this.dirs.root, "previews.json"))) ?? [];
  }

  /** Mark and sweep (§10.3): live = every file's and version's blobRefs, its comments' files, library payloads and thumbnails, previews. */
  async collectGarbage(): Promise<{ live: number; deleted: number; kept: number }> {
    const live = new Set<string>();
    for (const k of this.ws.files.keys()) {
      for (const r of await this.files.blobRefsOf(k)) live.add(r);
      for (const r of await this.comments.blobRefs(k)) live.add(r);
    }
    for (const r of await this.libraries.blobRefs()) live.add(r);
    for (const p of await this.previewRecords()) for (const r of p.blobRefs) live.add(r);
    const { deleted, kept } = await this.blobs.sweep(live, this.clock.now());
    if (deleted) this.log("info", `blob GC deleted ${deleted} blobs`);
    return { live: live.size, deleted, kept };
  }

  async flushAll(): Promise<void> {
    await this.files.flushAll();
  }

  /** Resolves when the store has no queued or background work (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.files.idle();
      await this.ws.queue.idle();
      await this.libraries.queue.idle();
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.gcTimer) this.timers.clearTimeout(this.gcTimer);
    // The rooms' sockets close first, cleanly (main kills this process 1 s after asking it to stop, and the sends
    // below may take longer): a socket that never says goodbye is a ghost in the facepile until the room expires it
    this.multiplayer.close();
    this.comments.close();
    this.usage.close();
    // The quit's sends (up to 2 s each) run alongside the files' flush, not before it: awaited one after the other
    // first, they used up main's 3 s (a signal's 1.5 s) and the store was killed before the files were closed and the
    // lock released (a stale lock on the next start).
    const sends = Promise.all([
      this.ai.close().catch((e) => this.log("warn", "ai: the quit's send failed", e)),
      this.analytics.close().catch((e) => this.log("warn", "analytics: the quit's send failed", e)),
    ]);
    this.orgLibraries.close();
    this.plugins.close();
    this.governanceEvents.close();
    this.personal.close();
    this.org.close();
    this.branches.close();
    this.notifications.close();
    await this.files.shutdown();
    await this.ws.queue.idle();
    await this.libraries.queue.idle();
    await this.compactor.close();
    await sends;
    await fsp.rm(join(this.dirs.root, ".lock"), { force: true });
    LOCKED_HERE.delete(this.dirs.root);
  }

  /** Simulates a crash in tests: drops the lock bookkeeping without flushing anything. */
  abandonForTests(): void {
    this.closed = true;
    if (this.gcTimer) this.timers.clearTimeout(this.gcTimer);
    LOCKED_HERE.delete(this.dirs.root);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The repositories (LocalAdapter), bound to the session owner (an RPC connection, or one in-process user)
  // -------------------------------------------------------------------------------------------------------------------

  api(owner: SessionOwner = {}): StoreApi {
    return localAdapter(this, owner);
  }
}

/** `LocalAdapter` (docs/data.md §8.2): the four repositories over the local store, for one owner of edit sessions. */
export function localAdapter(s: LocalStore, owner: SessionOwner): StoreApi {
  const ws = s.ws;
  const q = <T>(fn: () => Promise<T>) => ws.queue.run(fn);
  const workspace: WorkspaceRepository = {
    getWorkspace: async () => ({ ...ws.workspace }),
    updateWorkspace: (patch) => q(() => ws.updateWorkspace(patch ?? {})),
    setTeamName: (name) => q(() => ws.setTeamName(name)),
    getPrefs: async () => structuredClone(ws.prefs),
    setBrowsePrefs: (patch) => q(() => ws.setBrowsePrefs(patch ?? {})),
    listFolders: async () => ws.listFolders(),
    createFolder: (input) => q(() => ws.createFolder(input, newFolderId())),
    updateFolder: (id, patch) => q(() => ws.updateFolder(id, patch ?? {})),
    listFiles: async (query: FileQuery) => {
      const list = ws.listFiles(query);
      // Sizes are computed lazily; fill in the ones not known yet.
      return Promise.all(list.map(async (f) => (f.sizeBytes ? f : { ...f, sizeBytes: await s.files.sizeOf(f.fileKey).catch(() => 0) })));
    },
    getFile: async (fileKey) => {
      await s.multiplayer.whenCopied(fileKey).catch(() => {}); // a shared copy opened early (its tab asks its name)
      const f = ws.getFile(fileKey);
      return f.sizeBytes ? f : { ...f, sizeBytes: await s.files.sizeOf(fileKey).catch(() => 0) };
    },
    createFile: (input) => s.createFile(input),
    duplicateFile: (fileKey) => s.duplicateFile(fileKey),
    renameFile: async (fileKey, name) => {
      // A registered draft is renamed on the server first (docs/cloud.md §2); offline, refused
      if (typeof name === "string" && name.trim()) await s.personal.renameFirst(fileKey, name);
      const meta = await q(() => ws.renameFile(fileKey, name));
      if (!meta.cloud) await s.multiplayer.renameRemote(fileKey, meta.name);
      return meta;
    },
    moveFiles: (keys, folderId) => q(() => ws.moveFiles(keys ?? [], folderId ?? null)),
    trash: (items) => s.trash(items),
    restore: (items) => s.restore(items),
    deleteForever: (items) => s.deleteForever(items),
    emptyTrash: () => s.emptyTrash(),
    setStarred: (target, starred) => q(() => ws.setStarred(target, !!starred)),
    recordViewed: (fileKey) => q(() => ws.recordViewed(fileKey)),
    removeFromRecents: (fileKey) => q(() => ws.removeFromRecents(fileKey)),
    watch: (listener) => s.workspaceEvents.on(listener),
  };
  const files: FileRepository = {
    // An archived or merged branch opens read-only (docs/data.md §15.5).
    // A draft whose document isn't here downloads it first (docs/cloud.md §2)
    // A shared copy whose tab opened before its document came down (multiplayer.openShared early) waits for it
    open: async (fileKey, opts) => {
      await s.multiplayer.whenCopied(fileKey);
      await s.personal.ensureLocal(fileKey);
      return s.files.open(fileKey, { mode: s.branches.openMode(fileKey, opts?.mode === "edit" ? "edit" : "view"), tabId: opts?.tabId }, owner);
    },
    reattach: (fileKey, sessionID, last) => s.files.reattach(fileKey, sessionID, last ?? 0, owner),
    append: (fileKey, batch) => s.files.append(fileKey, batch, owner),
    flush: (fileKey) => s.files.flush(fileKey),
    close: async (fileKey, sessionID) => {
      await s.files.close(fileKey, sessionID);
      // An org file's instance snapshot (docs/data.md §17.4) when it closes
      s.usage.closedFile(fileKey);
      // The cache's bound (docs/cloud.md §2)
      s.personal.closed_(fileKey);
    },
    subscribe: (fileKey, fromSeq, listener) => subscribeLocal(s, fileKey, fromSeq, listener),
    saveThumbnail: async (fileKey, png, size) => {
      await s.files.saveThumbnail(fileKey, png, size ?? { width: 0, height: 0 });
      // A shared file's thumbnail reaches the server too (the REST API's thumbnailUrl, docs/multiplayer.md §16.7)
      s.multiplayer.thumbnailSaved(fileKey);
    },
    setUiState: (fileKey, patch) => s.files.setUiState(fileKey, patch ?? {}),
    setUndoHistory: (fileKey, history) => s.files.setUndoHistory(fileKey, history),
    saveSnapshot: (fileKey, save) => s.files.saveSnapshot(fileKey, save, owner),
    listVersions: (fileKey) => s.files.listVersions(fileKey),
    createVersion: (fileKey, input) => s.createVersion(fileKey, input ?? {}),
    updateVersion: (fileKey, id, patch) => s.files.updateVersion(fileKey, id, patch ?? {}),
    openVersion: (fileKey, id) => s.files.openVersion(fileKey, id),
    restoreDiff: (fileKey, id) => s.files.restoreDiff(fileKey, id),
    duplicateVersion: (fileKey, id) => s.duplicateVersion(fileKey, id),
    importLocalCopy: (path, folderId) => s.importLocalCopy(path, folderId ?? null),
    importFigBytes: (bytes, name, folderId, org) => s.importFigBytes(bytes, name, folderId ?? null, org),
    exportLocalCopy: (fileKey, path, opts) => s.exportLocalCopy(fileKey, path, { partial: opts?.partial === true }),
    missingImages: (fileKey) => s.missingImages(fileKey),
    details: (fileKey) => s.fileDetails(fileKey),
  };
  const blobs: BlobStore = {
    put: (bytes, hint) => s.blobs.put(bytes, hint),
    has: (sha1s) => s.blobs.has(sha1s ?? []),
    get: (sha1) => s.blobs.get(sha1),
    url: (sha1) => `app://designer/_blob/${sha1}`,
    watch: (listener) => s.multiplayer.onBlobsArrived(listener),
  };
  // Routed by key: local libraries (§9) and org libraries (§16.3)
  const r = s.libraryRouter;
  const libraries: LibraryRegistry = {
    listAvailable: (forFileKey) => r.listAvailable(forFileKey),
    getRecord: (lib) => r.getRecord(lib),
    getVersion: (lib, version) => r.getVersion(lib, version),
    previewPublish: (lib, assets) => r.previewPublish(lib, assets ?? []),
    publish: async (req) => {
      s.branches.checkCanPublish(req?.libraryFileKey);
      return r.publish(req);
    },
    unpublish: (lib) => r.unpublish(lib),
    setEnabled: (fileKey, lib, enabled) => r.setEnabled(fileKey, lib, !!enabled),
    getPayloads: (lib, wants, opts) => r.getPayloads(lib, wants ?? [], { withDependencies: !!opts?.withDependencies }),
    diff: (lib, have) => r.diff(lib, have ?? []),
    watch: (listener) => s.libraryEvents.on(listener),
  };
  const previews = previewsOf(s);
  const store: StoreAdmin = {
    shutdown: () => s.shutdown(),
    flushAll: () => s.flushAll(),
    info: async () => ({
      workspaceDir: s.dirs.root,
      wid: ws.workspace.wid,
      deviceOrdinal: s.deviceOrdinal,
      generation: s.generation,
      openFiles: s.files.openFiles(),
    }),
    collectGarbage: () => s.collectGarbage(),
  };
  const mp = multiplayerApi(s.multiplayer, owner);
  const multiplayer: typeof mp = {
    ...mp,
    // Previews publish with the same session (docs/multiplayer.md §9); a new one also sweeps the expired ones.
    setSession: (session) => {
      s.session = session && typeof session.server === "string" && typeof session.token === "string" ? { server: session.server, token: session.token } : null;
      s.markSessionKnown();
      if (s.session) void previews.sweepExpired().catch((e) => s.log("warn", "sweeping expired previews failed", e));
      // The personal Drafts follow the account (docs/cloud.md §2): its listings at once, then the sync behind
      return mp.setSession(session).then((status) => {
        void s.personal.sessionChanged().catch((e) => s.log("warn", "cloud: the sync after a sign-in failed", e));
        return status;
      });
    },
  };
  return {
    workspace,
    // A shared file's version history is its room's (docs/data.md §15.7.1).
    files: withRoomVersions(files, s.roomVersions),
    blobs,
    libraries,
    previews,
    store,
    multiplayer,
    comments: commentsApi(s.comments),
    notifications: notificationsApi(s.notifications),
    orgs: s.org.orgs,
    teams: s.org.teams,
    projects: s.org.projects,
    admin: s.org.admin,
    branches: s.branches.repository(),
    orgLibraries: orgLibrariesRepository(s.libraryServer),
    analytics: analyticsRepository(s.analytics, s.libraryServer),
    identity: identityRepository(s.multiplayer, (orgId) => s.org.notice({ t: "org", what: "org", orgId })),
    governance: governanceRepository(s.multiplayer, { changed: (orgId) => refreshGates(s.org, orgId), retry: (orgId) => s.multiplayer.retryBlocked(orgId) }),
    plugins: s.plugins.repository(),
    devMode: s.devMode.repository(),
    ai: s.ai.repository(),
    search: s.search.repository(),
    cloud: s.personal.repository(),
    brands: s.brands.repository(),
  };
}

/** `previews.*` (docs/data.md §13) over this store, plus main's `exportHtml` and the start's `sweepExpired`. */
export function previewsOf(s: LocalStore): ReturnType<typeof previewService> {
  return previewService({
    root: s.dirs.root,
    tmpDir: s.dirs.tmp,
    now: () => s.clock.now(),
    fileName: (fileKey) => s.ws.getMeta(fileKey).name,
    readBlob: (sha1) => s.blobs.get(sha1),
    session: () => s.session,
    fetch: s.fetch,
    viewerTemplate: s.viewerTemplate,
    run: (fn) => s.previewQueue.run(fn),
    devData: async (fileKey) => {
      const [devResources, codeConnect] = await Promise.all([s.devMode.repository().devResources(fileKey).catch(() => []), s.devMode.repository().codeConnect(fileKey).catch(() => [])]);
      return devResources.length || codeConnect.length ? { fileKey, devResources, codeConnect } : null;
    },
  });
}

/** In-process subscription: the backlog after `fromSeq`, then live changes, never a seq twice. */
function subscribeLocal(s: LocalStore, fileKey: FileKey, fromSeq: number, listener: (c: FileChange) => void): Unsubscribe {
  let last = fromSeq;
  let live = true;
  const queued: FileChange[] = [];
  let caughtUp = false;
  const deliver = (c: FileChange) => {
    if (!live || c.seq <= last) return;
    last = c.seq;
    listener(c);
  };
  const off = s.fileChanges.on((c) => {
    if (c.fileKey !== fileKey) return;
    if (caughtUp) deliver(c);
    else queued.push(c);
  });
  void s.files
    .backlog(fileKey, fromSeq)
    .then((frames) => {
      for (const f of frames) deliver(f);
    })
    .catch((e) => s.log("warn", `${fileKey}: backlog failed`, e))
    .finally(() => {
      caughtUp = true;
      for (const c of queued.splice(0)) deliver(c);
    });
  return () => {
    live = false;
    off();
  };
}

async function readDeviceOrdinal(userDataDir: string | undefined, dirs: WorkspaceDirs): Promise<number> {
  if (!userDataDir) return 1;
  const path = join(userDataDir, "device.json");
  const d = await readJsonOrNull<{ ordinal: number }>(path);
  if (d && Number.isInteger(d.ordinal) && d.ordinal >= 1 && d.ordinal <= 4095) return d.ordinal;
  await ensureDir(userDataDir);
  await writeJsonAtomic(dirs.tmp, path, { ordinal: 1, createdAt: Date.now() });
  return 1;
}

/** A corrupt meta.json: name from the snapshot's DOCUMENT node (unless it is the default "Document"), else "Recovered file". */
async function rebuildMeta(dirs: WorkspaceDirs, fileKey: FileKey, clock: Clock): Promise<{ name: string; createdAt: number } | null> {
  if (!isFileKey(fileKey)) return null;
  const dir = join(dirs.files, fileKey);
  const state = await readJsonOrNull<{ head?: { snapshot?: string } }>(join(dir, "store.json"));
  const names = (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) => /^snapshot-\d{12}\.kiwi$/.test(n)).sort();
  const candidates = [state?.head?.snapshot, ...names.reverse()].filter((n): n is string => !!n);
  for (const n of candidates) {
    try {
      const m = currentMessage(await readSnapshotFile(join(dir, n)));
      const doc = m.nodeChanges?.find((x) => x.type === "DOCUMENT");
      const st = await fsp.stat(dir);
      const name = doc?.name && doc.name !== "Document" ? doc.name : "Recovered file";
      return { name, createdAt: Math.min(st.birthtimeMs || clock.now(), clock.now()) };
    } catch {
      /* next */
    }
  }
  return null;
}

export type { OpenedFile };
