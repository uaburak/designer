/**
 * Admin › Settings › Content › Sharing and publishing › Public sharing ([F-share]: Public link sharing, Require
 * passwords, Require design file links to expire 1 hour–31 days, Custom settings for workspaces › Add workspace) and
 * Data › Data storage localization ([F-region]; ours: self-serve — the region, Change → confirm → the files moved one
 * per `moveNext` call with the progress; docs/multiplayer.md §15.10).
 */
import { useEffect, useRef, useState } from "react";
import { Banner, Button, Checkbox, Dialog, Select, Switch, TextInput, showToast } from "@/ds";
import type { OrgSettings, OrgWorkspace } from "@shared/org/types";
import { DATA_REGION_LABEL, LINK_EXPIRY_MAX_HOURS, type DataRegion, type DataRegionStatus, type WorkspaceSharingSettings } from "@shared/org/identity";
import { useAdmin, useLoad } from "./context";
import { formatHours } from "./labels";
import { ConfirmDialog, Field, styles } from "./parts";
import { errorParts } from "./SettingsLogin";

/** The Public sharing row's value lines */
export function sharingSummary(s: Pick<OrgSettings, "publicLinks" | "passwordRequired" | "linkExpiryMaxHours">): string[] {
  if (!s.publicLinks) return ["Public links off"];
  const out = [s.passwordRequired ? "Public links with a password" : "Public links on"];
  if (s.linkExpiryMaxHours !== null) out.push(`Links expire within ${formatHours(s.linkExpiryMaxHours)}`);
  return out;
}

/** A link expiry maximum as a number and a unit, and back (1 hour … 31 days) */
function ExpiryField({ n, unit, onChange, disabled }: { n: string; unit: "hours" | "days"; onChange: (n: string, unit: "hours" | "days") => void; disabled?: boolean }) {
  return (
    <div className={styles.inlineRow}>
      <TextInput className={styles.numberField} label="Maximum" value={n} onChange={(v) => onChange(v, unit)} variant="outlined" disabled={disabled} invalid={!disabled && expiryHours(n, unit) === null} />
      <Select label="Unit" width={100} value={unit} disabled={disabled} options={[{ value: "hours", label: "Hours" }, { value: "days", label: "Days" }]} onChange={(v) => onChange(n, v as "hours" | "days")} />
    </div>
  );
}
function expiryHours(n: string, unit: "hours" | "days"): number | null {
  const v = Number(n.trim());
  if (n.trim() === "" || !Number.isFinite(v)) return null;
  const h = v * (unit === "days" ? 24 : 1);
  return Number.isInteger(h) && h >= 1 && h <= LINK_EXPIRY_MAX_HOURS ? h : null;
}
function splitExpiry(h: number | null | undefined): { n: string; unit: "hours" | "days" } {
  if (h === null || h === undefined) return { n: "7", unit: "days" };
  return h % 24 === 0 ? { n: String(h / 24), unit: "days" } : { n: String(h), unit: "hours" };
}

export function PublicSharingDialog({ settings, onClose }: { settings: OrgSettings; onClose: () => void }) {
  const { orgId, store, run } = useAdmin();
  const { data: workspaces } = useLoad(() => store.admin.workspaces(orgId), [orgId]);
  const [publicLinks, setPublicLinks] = useState(settings.publicLinks);
  const [passwordRequired, setPasswordRequired] = useState(settings.passwordRequired);
  const [expires, setExpires] = useState(settings.linkExpiryMaxHours !== null);
  const [expiry, setExpiry] = useState(splitExpiry(settings.linkExpiryMaxHours));
  const [editing, setEditing] = useState<OrgWorkspace | null>(null);
  const [adding, setAdding] = useState(false);
  const hours = expires ? expiryHours(expiry.n, expiry.unit) : null;
  const valid = !expires || hours !== null;
  const custom = (workspaces ?? []).filter((w) => w.sharing && Object.keys(w.sharing).length);
  const others = (workspaces ?? []).filter((w) => !custom.includes(w));
  const save = () => {
    const patch: Partial<OrgSettings> = {};
    if (publicLinks !== settings.publicLinks) patch.publicLinks = publicLinks;
    if (passwordRequired !== settings.passwordRequired) patch.passwordRequired = passwordRequired;
    if (hours !== settings.linkExpiryMaxHours) patch.linkExpiryMaxHours = hours;
    if (Object.keys(patch).length) void run(() => store.admin.updateSettings(orgId, patch), "Public sharing saved");
    onClose();
  };
  return (
    <>
      <Dialog
        title="Public sharing" open size="large" onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!valid} onClick={save}>Save</Button>
          </>
        }
      >
        <div className={styles.form}>
          <div className={styles.switchRow} data-sharing="publicLinks">
            <span className={styles.settingText}>
              <span className={styles.settingLabel}>Public link sharing</span>
              <span className={styles.settingDescription}>Off, files in the organization are private: only members and people invited to them can open them.</span>
            </span>
            <Switch label="Public link sharing" checked={publicLinks} onChange={setPublicLinks} />
          </div>
          <div className={styles.option} data-sharing="passwordRequired">
            <Checkbox label="Require passwords" checked={passwordRequired} disabled={!publicLinks} onChange={setPasswordRequired} />
            <span className={styles.optionDescription}>Removes “Anyone with the link”: public links need a password.</span>
          </div>
          <div className={styles.option} data-sharing="linkExpiry">
            <Checkbox label="Require design file links to expire" checked={expires} disabled={!publicLinks} onChange={setExpires} />
            <span className={styles.optionDescription}>Public links turn private after at most this long (1 hour to 31 days). This also turns public links off in FigJam.</span>
            {expires && publicLinks && (
              <div className={styles.optionDescription}>
                <ExpiryField n={expiry.n} unit={expiry.unit} onChange={(n, unit) => setExpiry({ n, unit })} />
                {!valid && <div className={styles.error}>Choose between 1 hour and 31 days.</div>}
              </div>
            )}
          </div>
          <div className={styles.form} data-sharing="workspaces">
            <div className={styles.sectionHeader}>
              <h3 className={styles.settingsSubTitle}>Custom settings for workspaces</h3>
              <Button variant="secondary" disabled={others.length === 0} onClick={() => setAdding(true)}>Add workspace</Button>
            </div>
            <div className={styles.note}>Override these settings for files in a workspace's teams. Drafts and teams outside workspaces use the organization's.</div>
            {custom.map((w) => (
              <div key={w.id} className={styles.settingRow} data-workspace-sharing={w.id}>
                <span className={styles.settingText}>
                  <span className={styles.settingLabel}>{w.name}</span>
                  <span className={styles.settingDescription}>{workspaceSummary(w.sharing!)}</span>
                </span>
                <Button variant="secondary" onClick={() => setEditing(w)}>Edit</Button>
                <Button variant="secondary" onClick={() => void run(() => store.admin.updateWorkspace(w.id, { sharing: null }), "Custom settings removed")}>Remove</Button>
              </div>
            ))}
          </div>
        </div>
      </Dialog>
      {adding && <AddWorkspaceDialog workspaces={others} onPick={(w) => { setAdding(false); setEditing(w); }} onClose={() => setAdding(false)} />}
      {editing && <WorkspaceSharingDialog workspace={editing} org={settings} onClose={() => setEditing(null)} />}
    </>
  );
}

function workspaceSummary(w: WorkspaceSharingSettings): string {
  const parts: string[] = [];
  if (w.publicLinks !== undefined) parts.push(w.publicLinks ? "Public links on" : "Public links off");
  if (w.passwordRequired !== undefined) parts.push(w.passwordRequired ? "Passwords required" : "Passwords not required");
  if (w.linkExpiryMaxHours !== undefined) parts.push(w.linkExpiryMaxHours === null ? "Links don't have to expire" : `Links expire within ${formatHours(w.linkExpiryMaxHours)}`);
  return parts.join(" · ") || "Organization settings";
}

function AddWorkspaceDialog({ workspaces, onPick, onClose }: { workspaces: OrgWorkspace[]; onPick: (w: OrgWorkspace) => void; onClose: () => void }) {
  const [id, setId] = useState(workspaces[0]?.id ?? "");
  return (
    <Dialog
      title="Add workspace" open onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!id} onClick={() => onPick(workspaces.find((w) => w.id === id)!)}>Next</Button>
        </>
      }
    >
      <Field title="Workspace">
        <Select label="Workspace" value={id} options={workspaces.map((w) => ({ value: w.id, label: w.name }))} onChange={setId} />
      </Field>
    </Dialog>
  );
}

type Tri = "org" | "on" | "off";
function WorkspaceSharingDialog({ workspace, org, onClose }: { workspace: OrgWorkspace; org: OrgSettings; onClose: () => void }) {
  const { store, run } = useAdmin();
  const w = workspace.sharing ?? {};
  const [links, setLinks] = useState<Tri>(w.publicLinks === undefined ? "org" : w.publicLinks ? "on" : "off");
  const [pw, setPw] = useState<Tri>(w.passwordRequired === undefined ? "org" : w.passwordRequired ? "on" : "off");
  const [exp, setExp] = useState<Tri>(w.linkExpiryMaxHours === undefined ? "org" : w.linkExpiryMaxHours === null ? "off" : "on");
  const [expiry, setExpiry] = useState(splitExpiry(w.linkExpiryMaxHours ?? org.linkExpiryMaxHours));
  const hours = exp === "on" ? expiryHours(expiry.n, expiry.unit) : null;
  const valid = exp !== "on" || hours !== null;
  const orgSetting = (on: boolean) => `Organization setting (${on ? "On" : "Off"})`;
  const save = () => {
    const sharing: WorkspaceSharingSettings = {};
    if (links !== "org") sharing.publicLinks = links === "on";
    if (pw !== "org") sharing.passwordRequired = pw === "on";
    if (exp !== "org") sharing.linkExpiryMaxHours = hours;
    void run(() => store.admin.updateWorkspace(workspace.id, { sharing: Object.keys(sharing).length ? sharing : null }), "Custom settings saved");
    onClose();
  };
  return (
    <Dialog
      title={`Custom settings for ${workspace.name}`} open size="medium" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={save}>Save</Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field title="Public link sharing">
          <Select label="Public link sharing" value={links} onChange={(v) => setLinks(v as Tri)} options={[{ value: "org", label: orgSetting(org.publicLinks) }, { value: "on", label: "On" }, { value: "off", label: "Off" }]} />
        </Field>
        <Field title="Require passwords">
          <Select label="Require passwords" value={pw} onChange={(v) => setPw(v as Tri)} options={[{ value: "org", label: orgSetting(org.passwordRequired) }, { value: "on", label: "Required" }, { value: "off", label: "Not required" }]} />
        </Field>
        <Field title="Require design file links to expire">
          <Select label="Require design file links to expire" value={exp} onChange={(v) => setExp(v as Tri)} options={[{ value: "org", label: orgSetting(org.linkExpiryMaxHours !== null) }, { value: "on", label: "Required" }, { value: "off", label: "Not required" }]} />
        </Field>
        {exp === "on" && <ExpiryField n={expiry.n} unit={expiry.unit} onChange={(n, unit) => setExpiry({ n, unit })} />}
        {!valid && <div className={styles.error}>Choose between 1 hour and 31 days.</div>}
      </div>
    </Dialog>
  );
}

// ---- Data storage localization -----------------------------------------------------------------------------------

const REGIONS = Object.keys(DATA_REGION_LABEL) as DataRegion[];
const left = (st: DataRegionStatus) => st.files.total - st.files.moved + st.libraries.total - st.libraries.moved;

export function DataRegionDialog({ onClose }: { onClose: () => void }) {
  const { orgId, store, changed } = useAdmin();
  const identity = store.identity!;
  const { data: loaded } = useLoad(() => identity.dataRegion(orgId), [orgId]);
  const [status, setStatus] = useState<DataRegionStatus | null>(null);
  const [pick, setPick] = useState<DataRegion | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const st = status ?? loaded ?? null;
  if (!st) return null;
  const target = pick ?? st.region;
  const total = st.files.total + st.libraries.total;
  const done = st.files.moved + st.libraries.moved;
  const pending = left(st);

  /** `POST admin/data-region/move` until `moving` is null (§15.16): one file or library per call */
  const move = async (region?: DataRegion) => {
    setMoving(true);
    try {
      let s = region && region !== st.region ? await identity.setDataRegion(orgId, region) : st;
      if (!alive.current) return;
      setStatus(s);
      changed();
      for (;;) {
        s = await identity.moveNext(orgId);
        if (!alive.current) return;
        setStatus(s);
        if (s.moving === null) break;
      }
      changed();
      showToast({ message: left(s) === 0 ? `Files moved to ${DATA_REGION_LABEL[s.region]}` : "Some files couldn't be moved" });
    } catch (e) {
      if (alive.current) showToast({ message: errorParts(e).message, kind: "error" });
    } finally {
      if (alive.current) {
        setMoving(false);
        setPick(null);
      }
    }
  };
  return (
    <>
      <Dialog
        title="Data storage localization" open size="medium" onClose={onClose}
        footer={
          moving ? (
            <Button variant="secondary" onClick={onClose}>Close</Button>
          ) : (
            <>
              {pending > 0 && <Button variant="secondary" onClick={() => void move()}>Resume moving</Button>}
              <span className={styles.spacer} />
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button variant="primary" disabled={!st.available || target === st.region} onClick={() => setConfirming(true)}>Change</Button>
            </>
          )
        }
      >
        <div className={styles.form}>
          <div className={styles.note}>
            The content of the organization's files and libraries — shapes, text, frames, components, images and video — is stored in this region. Comments, file names, fonts, thumbnails, activity logs and other metadata aren't localized.
          </div>
          {!st.available && <Banner tone="warning">The European Union region isn't available on this server.</Banner>}
          <Field title="Region">
            <Select label="Region" value={target} disabled={moving || !st.available} options={REGIONS.map((r) => ({ value: r, label: DATA_REGION_LABEL[r] }))} onChange={(v) => setPick(v as DataRegion)} />
          </Field>
          {(moving || pending > 0) && (
            <div className={styles.form} data-region-progress="">
              <div className={styles.progress} role="progressbar" aria-label="Moving files" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
                <span className={styles.progressBar} style={{ width: `${total ? (done / total) * 100 : 100}%` }} />
              </div>
              <div className={styles.note}>{moving ? `Moving files… ${done} of ${total}` : `${pending === 1 ? "1 file is" : `${pending} files are`} still in the previous region.`}</div>
            </div>
          )}
          {moving && <div className={styles.note}>Files being moved can't be edited for a few seconds each. Closing this stops the move; it can be resumed.</div>}
        </div>
      </Dialog>
      {confirming && (
        <ConfirmDialog
          title={`Move files to ${DATA_REGION_LABEL[target]}?`} confirm="Change"
          body={`New files are stored in ${DATA_REGION_LABEL[target]} at once. ${total === 1 ? "The existing file is" : `The ${total} existing files and libraries are`} moved one by one; each is read-only for a few seconds while it moves.`}
          onConfirm={() => void move(target)}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}
