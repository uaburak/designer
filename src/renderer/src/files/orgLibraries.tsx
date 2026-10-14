/**
 * Libraries and fonts in Home for an organization (docs/data.md §16–§17, docs/desktop.md §14.3; wording in
 * docs/research/figma/R20-home-org.md "Libraries and fonts"):
 * - All teams › **Libraries**: the org's library analytics (`analytics.orgOverview`) — totals, one row per library
 *   with "Inserts last week", Search; a row opens that library's Library analytics.
 * - A team › **View settings** › Shared › **View team's libraries** (Enabled by default, Default mode) and
 *   **View team's fonts** (Upload fonts with the rights checkbox, remove).
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Dialog, EmptyState, IconButton, SearchField, Select, Spinner, TextArea, type ToastOptions } from "@/ds";
import { intlLocale, t, tp, useT } from "@/i18n";
import type * as O from "@shared/org/types";
import type { CollectionModes, OrgLibrariesAnalytics, TeamLibraryRow } from "@shared/libraries/orgTypes";
import type { FontConflictChoice, FontUploadCandidate, FontConflict, SharedFontFace, SharedFontScope } from "@shared/fonts/sharedTypes";
import type { SharedFontsApi } from "@shared/desktop";
import { DEFAULT_CHOICES, DEFAULT_CHOICE_LABEL, defaultChoice, defaultsFor, effectiveTypes, type DefaultChoice } from "./libraryDefaults";
import { orgErrorText } from "./org";
import type { OrgBackend } from "./storeAccess";
import styles from "./Files.module.css";

const number = (n: number) => n.toLocaleString(intlLocale());
/** The last answers this session (by org, by team): a dialog opened again shows them at once while it reads again
 *  (stale-while-revalidate, as the store's org cache does for Home's pages) */
const lastOverview = new Map<string, OrgLibrariesAnalytics>();
const lastTeamLibraries = new Map<string, TeamLibraryRow[]>();
const remember = <T,>(map: Map<string, T>, key: string, v: T): T => {
  map.delete(key);
  map.set(key, v);
  if (map.size > 50) map.delete(map.keys().next().value!);
  return v;
};
const matches = (name: string, text: string) => name.toLowerCase().includes(text.trim().toLowerCase());

// ---- All teams › Libraries ----------------------------------------------------------------------------------------

/** The org-wide library analytics (help.figma.com 360039238353: "Click All teams, then click Libraries"). */
export function OrgLibrariesDialog({ org, orgId, onOpenLibrary, onClose }: { org: OrgBackend; orgId: string; onOpenLibrary: (lib: { key: string; name: string }) => void; onClose: () => void }) {
  useT();
  const [data, setData] = useState<OrgLibrariesAnalytics | null>(() => lastOverview.get(orgId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    let live = true;
    org.analytics!.orgOverview(orgId).then(
      (d) => live && setData(remember(lastOverview, orgId, d)),
      (e) => live && !lastOverview.has(orgId) && setError(orgErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [org, orgId]);
  const rows = data ? data.libraries.filter((l) => !text.trim() || matches(l.name, text) || (l.teamName != null && matches(l.teamName, text))) : [];
  const totals = data
    ? [
        [t("Total teams"), data.totals.teams],
        [t("Teams with libraries"), data.totals.teamsWithLibraries],
        [t("Total libraries"), data.totals.libraries],
        [t("Total components"), data.totals.components],
        [t("Total styles"), data.totals.styles],
      ]
    : [];
  return (
    <Dialog open size="large" title={t("Libraries")} onClose={onClose}>
      {error ? (
        <EmptyState icon="24.warning" title={t("Couldn’t load library analytics")} body={error} />
      ) : !data ? (
        <div className={styles.center} aria-busy>
          <Spinner size={24} />
        </div>
      ) : (
        <div className={styles.libsPane}>
          <dl className={styles.libsTotals} aria-label={t("Totals")}>
            {totals.map(([label, n]) => (
              <div key={label} className={styles.libsTotal}>
                <dt className={styles.mutedText}>{label}</dt>
                <dd className={styles.libsTotalValue}>{number(n as number)}</dd>
              </div>
            ))}
          </dl>
          <SearchField label={t("Search")} placeholder={t("Search")} size="large" value={text} onChange={setText} />
          <table className={styles.libsTable} aria-label={t("Libraries")}>
            <thead>
              <tr>
                <th scope="col">{t("Library")}</th>
                <th scope="col">{t("# of components")}</th>
                <th scope="col">{t("# of styles")}</th>
                <th scope="col">{t("Inserts last week")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.key} data-library={l.name}>
                  <td>
                    <button type="button" className={styles.libsName} onClick={() => onOpenLibrary({ key: l.key, name: l.name })}>
                      <span className={styles.memberName}>{l.name}</span>
                      {l.teamName && <span className={styles.mutedText}>{l.teamName}</span>}
                    </button>
                  </td>
                  <td>{number(l.components)}</td>
                  <td>{number(l.styles)}</td>
                  <td>{number(l.insertsLastWeek)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className={styles.mutedText}>{text.trim() ? t("No libraries match “{text}”.", { text: text.trim() }) : t("No libraries have been published in this organization yet.")}</p>}
        </div>
      )}
    </Dialog>
  );
}

// ---- team › View settings -------------------------------------------------------------------------------------------

/** A team's settings (help.figma.com: the team's ⌄ › View settings); its Shared section. */
export function TeamSettingsDialog({ team, libraries, fonts, onLibraries, onFonts, onClose, onDescription }: { team: O.TeamInfo; libraries: boolean; fonts: boolean; onLibraries: () => void; onFonts: () => void; onClose: () => void; /** The team's admins: "Add a description" / "Change about" (help.figma.com 14945606265623) */ onDescription?: (description: string) => Promise<unknown> }) {
  useT();
  const [about, setAbout] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (about === null || !onDescription) return;
    setSaving(true);
    try {
      await onDescription(about.trim());
      setAbout(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open size="medium" title={t("{name} settings", { name: team.name })} onClose={onClose}>
      <section aria-label={t("About")} className={styles.dialogField} data-team-about="">
        <h2 className={styles.sectionTitle}>{t("About")}</h2>
        {about !== null ? (
          <>
            <TextArea label={t("Description")} placeholder={t("Description")} value={about} onChange={setAbout} maxRows={6} />
            <div className={styles.iconActions}>
              <Button variant="secondary" onClick={() => setAbout(null)} disabled={saving}>
                {t("Cancel")}
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {t("Save")}
              </Button>
            </div>
          </>
        ) : (
          <>
            {team.description ? <p className={styles.mutedText}>{team.description}</p> : !onDescription && <p className={styles.mutedText}>{t("No description")}</p>}
            {onDescription && (
              <button type="button" className={styles.settingsLink} onClick={() => setAbout(team.description)}>
                {team.description ? t("Change about") : t("Add a description")}
              </button>
            )}
          </>
        )}
      </section>
      {(libraries || fonts) && <section aria-label={t("Shared")} className={styles.dialogField}>
        <h2 className={styles.sectionTitle}>{t("Shared")}</h2>
        {libraries && (
          <button type="button" className={styles.settingsLink} onClick={onLibraries}>
            {t("View team’s libraries")}
          </button>
        )}
        {fonts && (
          <button type="button" className={styles.settingsLink} onClick={onFonts}>
            {t("View team’s fonts")}
          </button>
        )}
      </section>}
    </Dialog>
  );
}

/** "View team's libraries": each library the team can use, its Enabled by default and Default mode (§16.5). */
export function TeamLibrariesDialog({ org, orgId, team, canManage, toast, onClose }: { org: OrgBackend; orgId: string; team: O.TeamInfo; canManage: boolean; toast: (o: ToastOptions) => void; onClose: () => void }) {
  useT();
  const libs = org.orgLibraries!;
  const [rows, setRows] = useState<TeamLibraryRow[] | null>(() => lastTeamLibraries.get(team.id) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [collections, setCollections] = useState<Record<string, CollectionModes[]>>({});
  const workspaceId = team.workspaceId;

  useEffect(() => {
    let live = true;
    libs.teamLibraries(team.id).then(
      (r) => live && setRows(remember(lastTeamLibraries, team.id, r)),
      (e) => live && !lastTeamLibraries.has(team.id) && setError(orgErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [libs, team.id]);

  // The Default mode column needs the collections of libraries on for Design files (read once each)
  const wanted = useMemo(() => (rows ?? []).filter((r) => effectiveTypes(r, workspaceId).includes("design")).map((r) => r.key), [rows, workspaceId]);
  useEffect(() => {
    const missing = wanted.filter((k) => !(k in collections));
    if (!missing.length) return;
    let live = true;
    void Promise.all(missing.map((k) => libs.get(orgId, k).then((i) => [k, i.collections] as const, () => [k, [] as CollectionModes[]] as const))).then((got) => {
      if (live) setCollections((c) => ({ ...c, ...Object.fromEntries(got) }));
    });
    return () => {
      live = false;
    };
  }, [wanted, collections, libs, orgId]);

  const save = async (row: TeamLibraryRow, input: Parameters<typeof libs.updateSettings>[2]) => {
    try {
      await libs.updateSettings(orgId, row.key, input);
      setRows(remember(lastTeamLibraries, team.id, await libs.teamLibraries(team.id)));
    } catch (e) {
      toast({ kind: "error", message: orgErrorText(e) });
    }
  };

  return (
    <Dialog open size="large" title={t("Libraries")} onClose={onClose}>
      {error ? (
        <EmptyState icon="24.warning" title={t("Couldn’t load the team’s libraries")} body={error} />
      ) : !rows ? (
        <div className={styles.center} aria-busy>
          <Spinner size={24} />
        </div>
      ) : !rows.length ? (
        <EmptyState icon="24.library" title={t("No libraries")} body={t("Libraries published in this team, or shared with the organization, show up here.")} />
      ) : (
        <table className={styles.libsTable} aria-label={t("{name} libraries", { name: team.name })}>
          <thead>
            <tr>
              <th scope="col">{t("Library")}</th>
              <th scope="col">{t("Enabled by default")}</th>
              <th scope="col">{t("Default mode")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const types = effectiveTypes(r, workspaceId);
              const value = defaultChoice(types);
              const known = (DEFAULT_CHOICES as readonly string[]).includes(value);
              const multi = (collections[r.key] ?? []).filter((c) => c.modes.length >= 2);
              return (
                <tr key={r.key} data-library={r.name}>
                  <td>
                    <span className={styles.libsName}>
                      <span className={styles.memberName}>{r.name}</span>
                      <span className={styles.mutedText}>{r.teamName ?? t("Organization")}</span>
                    </span>
                  </td>
                  <td>
                    <Select
                      label={t("{name}: Enabled by default", { name: r.name })}
                      variant="ghost"
                      width="hug"
                      disabled={!canManage}
                      value={value}
                      options={[...(known ? [] : [{ value, label: value, disabled: true }]), ...DEFAULT_CHOICES.map((c) => ({ value: c, label: DEFAULT_CHOICE_LABEL(c) }))]}
                      onChange={(v) => void save(r, { scope: { type: "team", id: team.id }, defaults: defaultsFor(v as DefaultChoice, r, workspaceId) })}
                    />
                  </td>
                  <td>
                    {types.includes("design") && multi.length ? (
                      <span className={styles.libsModes}>
                        {multi.map((c) => (
                          <Select
                            key={c.collectionKey}
                            label={t("{name}: {collection} default mode", { name: r.name, collection: c.name })}
                            prefix={multi.length > 1 ? c.name : undefined}
                            variant="ghost"
                            width="hug"
                            disabled={!canManage}
                            value={r.setting.defaultModes.find((d) => d.collectionKey === c.collectionKey)?.modeId ?? c.modes[0].id}
                            options={c.modes.map((m) => ({ value: m.id, label: m.name }))}
                            onChange={(v) => void save(r, { scope: { type: "team", id: team.id }, defaultModes: [{ collectionKey: c.collectionKey, modeId: v === c.modes[0].id ? null : v }] })}
                          />
                        ))}
                      </span>
                    ) : (
                      <span className={styles.mutedText}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

// ---- View team's fonts ----------------------------------------------------------------------------------------------

type Picked = { candidates: FontUploadCandidate[]; conflicts: FontConflict[]; failed: { fileName: string; reason: string }[] };

/** "View team's fonts": the team's fonts by family, Upload fonts (main's Open dialog, the rights checkbox), Remove. */
export function TeamFontsDialog({ fonts, orgId, team, canManage, toast, onClose }: { fonts: SharedFontsApi; orgId: string; team: O.TeamInfo; canManage: boolean; toast: (o: ToastOptions) => void; onClose: () => void }) {
  useT();
  const scope: SharedFontScope = useMemo(() => ({ type: "team", orgId, teamId: team.id }), [orgId, team.id]);
  const [faces, setFaces] = useState<SharedFontFace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fonts.sharedList(scope).then(
      (r) => live && setFaces(r.faces),
      (e) => live && setError(orgErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [fonts, scope]);

  const families = useMemo(() => {
    const by = new Map<string, SharedFontFace[]>();
    for (const f of faces ?? []) by.set(f.family, [...(by.get(f.family) ?? []), f]);
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [faces]);

  const pick = async () => {
    try {
      const r = await fonts.sharedPick(scope);
      if ("cancelled" in r) return;
      if (!r.candidates.length) {
        toast({ kind: "error", message: r.failed.length ? t("Couldn’t upload {files}: {error}", { files: r.failed.map((f) => f.fileName).join(", "), error: r.failed[0].reason }) : t("No fonts to upload") });
        return;
      }
      setPicked(r);
    } catch (e) {
      toast({ kind: "error", message: orgErrorText(e) });
    }
  };

  const remove = async (family: string) => {
    try {
      setFaces((await fonts.sharedRemove({ scope, family })).faces);
      toast({ message: t("Removed {name}", { name: family }) });
    } catch (e) {
      toast({ kind: "error", message: orgErrorText(e) });
    }
  };

  if (picked) {
    return (
      <UploadFontsDialog
        picked={picked}
        busy={busy}
        onClose={() => setPicked(null)}
        onUpload={async (choices) => {
          setBusy(true);
          try {
            const r = await fonts.sharedUpload({ scope, tokens: picked.candidates.map((c) => c.token), licenceConfirmed: true, choices });
            setFaces((await fonts.sharedList(scope)).faces);
            setPicked(null);
            const n = r.uploaded.length;
            if (r.failed.length) toast({ kind: "error", message: t("Couldn’t upload {files}: {error}", { files: r.failed.map((f) => f.fileName).join(", "), error: r.failed[0].reason }) });
            else toast({ message: n ? tp(n, "Uploaded {n} font", "Uploaded {n} fonts") : t("No fonts uploaded") });
          } catch (e) {
            toast({ kind: "error", message: orgErrorText(e) });
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  return (
    <Dialog
      open
      size="medium"
      title={t("Fonts")}
      onClose={onClose}
      footer={
        canManage ? (
          <Button variant="primary" size="large" onClick={() => void pick()}>
            {t("Upload fonts")}
          </Button>
        ) : undefined
      }
    >
      {error ? (
        <EmptyState icon="24.warning" title={t("Couldn’t load the team’s fonts")} body={error} />
      ) : !faces ? (
        <div className={styles.center} aria-busy>
          <Spinner size={24} />
        </div>
      ) : !families.length ? (
        <p className={styles.mutedText}>{t("No fonts have been uploaded to {name} yet. Fonts uploaded here show up in the font picker for the team’s files.", { name: team.name })}</p>
      ) : (
        <ul className={styles.memberList} aria-label={t("{name} fonts", { name: team.name })}>
          {families.map(([family, list]) => (
            <li key={family} className={styles.memberRow} data-family={family}>
              <span className={styles.memberText}>
                <span className={styles.memberName}>{family}</span>
                <span className={styles.mutedText}>{tp(list.length, "{n} style", "{n} styles")}</span>
              </span>
              <span className={styles.spacer} />
              {canManage && <IconButton icon="24.trash.outline" label={t("Remove {name}", { name: family })} onClick={() => void remove(family)} />}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** After the Open dialog: the files, Skip / Replace for families already there, the rights checkbox, Upload. */
function UploadFontsDialog({ picked, busy, onUpload, onClose }: { picked: Picked; busy: boolean; onUpload: (choices: Record<string, FontConflictChoice>) => void; onClose: () => void }) {
  useT();
  const [confirmed, setConfirmed] = useState(false);
  const [choices, setChoices] = useState<Record<string, FontConflictChoice>>(() => Object.fromEntries(picked.conflicts.map((c) => [c.family, "skip" as const])));
  return (
    <Dialog
      open
      size="medium"
      title={t("Upload fonts")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="large" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" size="large" disabled={!confirmed} loading={busy} onClick={() => confirmed && onUpload(choices)}>
            {t("Upload")}
          </Button>
        </>
      }
    >
      <div className={styles.dialogField}>
        <ul className={styles.memberList} aria-label={t("Fonts to upload")}>
          {picked.candidates.map((c) => (
            <li key={c.token} className={styles.memberRow}>
              <span className={styles.memberText}>
                <span className={styles.memberName}>{c.fileName}</span>
                <span className={styles.mutedText}>{[...new Set(c.faces.map((f) => `${f.family} ${f.style}`))].join(", ")}</span>
              </span>
            </li>
          ))}
        </ul>
        {picked.conflicts.map((c) => (
          <div key={c.family} className={styles.accessRow}>
            <span className={styles.accessLabel}>{t("{name} is already uploaded ({styles})", { name: c.family, styles: tp(c.existing, "{n} style", "{n} styles") })}</span>
            <Select
              label={t("{name}: Skip or Replace", { name: c.family })}
              width="hug"
              value={choices[c.family]}
              options={[
                { value: "skip", label: t("Skip") },
                { value: "replace", label: t("Replace") },
              ]}
              onChange={(v) => setChoices((s) => ({ ...s, [c.family]: v as FontConflictChoice }))}
            />
          </div>
        ))}
        {picked.failed.map((f) => (
          <p key={f.fileName} className={styles.passwordError}>{`${f.fileName}: ${f.reason}`}</p>
        ))}
        <Checkbox label={t("I have the necessary rights and licenses to use the font(s)")} checked={confirmed} onChange={setConfirmed} />
      </div>
    </Dialog>
  );
}
