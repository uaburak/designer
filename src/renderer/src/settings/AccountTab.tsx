/**
 * Settings › Account, as live Figma (5–7.png): the photo with Edit, Name / Email / Role, Your spaces, Language,
 * Theme with Enhance contrast, New features (Closed captions, Beta), Your uploaded fonts, Library, View history,
 * Account › Delete account. Signed out, the account's own sections give way to Log in; the machine's stay.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, ContextMenu, IconButton, Select, showToast, Switch, setContrast, setThemePreference, useTheme, type ThemePreference } from "@/ds";
import { LANGUAGES, type AccountPrefs } from "@shared/account";
import type { UploadedFont } from "@shared/ipc";
import { getStoreClient } from "@/store";
import { fontsBridge, openLink } from "./bridge";
import { ChangeEmailDialog, ChangeLanguageDialog, ChangeNameDialog, ChangeRoleDialog, DeleteAccountDialog, DraftLibrariesDialog, ViewHistoryDialog } from "./SettingsDialogs";
import { useProfile } from "./useProfile";
import { OfflineCache } from "./OfflineCache";
import { useCloud } from "../files/useCloud";
import type { CloudRepository } from "@shared/store/cloud";
import styles from "./Settings.module.css";

type DialogId = "team" | "name" | "email" | "role" | "language" | "view-history" | "delete" | "libraries" | null;

export function Section({ heading, children, ...data }: { heading?: string; children?: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <section className={styles.section} {...data}>
      {heading && <h3 className={styles.heading}>{heading}</h3>}
      {children}
    </section>
  );
}

export const Divider = () => <hr className={styles.divider} />;

export function Link({ children, onClick, danger, tight, ...rest }: { children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; tight?: boolean } & Record<`data-${string}`, string | undefined>) {
  return (
    <button type="button" className={[styles.link, danger && styles.danger, tight && styles.tight].filter(Boolean).join(" ")} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** A picked image as a 256 px square JPEG (centre-cropped): small enough for the server (≤ 300 kB). */
async function squarePhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    canvas.getContext("2d")!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AccountTab() {
  const { account, profile, save } = useProfile();
  const user = account.state?.user ?? null;
  const [dialog, setDialog] = useState<DialogId>(null);
  const [photoMenu, setPhotoMenu] = useState<{ x: number; y: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const theme = useTheme();
  const [teamName, setTeamName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const repo = getStoreClient().workspace;
    void repo.getWorkspace().then((w) => live && setTeamName(w.teamName), () => {});
    // Renamed here or in Home: the name follows
    const off = repo.watch((e) => {
      if (e.type === "workspace.updated" && live) setTeamName(e.workspace.teamName);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  // Personal Drafts in the cloud (docs/cloud.md §2): signed in, the person's own space and this computer's cache
  const cloud = getStoreClient().cloud as CloudRepository | undefined;
  const cloudStatus = useCloud(cloud);
  const personal = !!cloudStatus?.uid;
  const name = profile?.name ?? user?.name ?? user?.email ?? "";
  const prefs: AccountPrefs = profile?.prefs ?? {};
  const savePrefs = (p: AccountPrefs) => save({ prefs: p });
  const language = LANGUAGES.find((l) => l.id === (prefs.language ?? "en"))?.label ?? "English";

  return (
    <div className={styles.accountPage} data-settings-account="">
      <div className={styles.photoColumn}>
        {user && (
          <div className={styles.photo}>
            {user.picture ? <img className={styles.photoImage} src={user.picture} alt="" /> : <span className={styles.photoInitials}>{initials(name)}</span>}
            <button
              type="button"
              className={styles.photoEdit}
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setPhotoMenu({ x: r.left, y: r.bottom + 4 });
              }}
              data-photo-edit=""
            >
              Edit
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={async (e) => {
                const f = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (!f) return;
                try {
                  await save({ picture: await squarePhoto(f) });
                } catch {
                  showToast({ kind: "error", message: "Couldn’t read that image" });
                }
              }}
            />
            {photoMenu && (
              <ContextMenu
                at={photoMenu}
                entries={[{ id: "upload", label: "Upload photo…" }, ...(user.picture ? [{ id: "remove", label: "Remove photo" }] : [])]}
                onSelect={(id) => {
                  setPhotoMenu(null);
                  if (id === "upload") fileInput.current?.click();
                  else if (id === "remove") void save({ picture: null });
                }}
                onClose={() => setPhotoMenu(null)}
              />
            )}
          </div>
        )}
      </div>
      <div className={styles.content}>
        {user ? (
          <>
            <Section heading="Name" data-settings-section="name">
              <p className={styles.value} data-settings-value="">{name}</p>
              <Link onClick={() => setDialog("name")}>Change name</Link>
            </Section>
            <Section heading="Email" data-settings-section="email">
              <p className={styles.value}>{user.email}</p>
              <Link onClick={() => setDialog("email")}>Change email</Link>
            </Section>
            <Section heading="Role" data-settings-section="role">
              <p className={styles.value}>{profile?.role ?? "None"}</p>
              <Link onClick={() => setDialog("role")}>Change role</Link>
            </Section>
            <Divider />
            <section className={styles.section} data-settings-section="spaces">
              <h3 className={styles.title}>Your spaces</h3>
              {/* Our one space is this computer's workspace (its team name); organisations come with Phase 7 (Enterprise). */}
              {personal ? (
                // The person's own space: their Drafts on the server (docs/cloud.md §2), named after them
                <div className={styles.space} data-personal-space="">
                  <span className={styles.spaceAvatar} aria-hidden>{(name || "M").charAt(0).toUpperCase()}</span>
                  <div className={styles.spaceLines}>
                    <span>{name}</span>
                    <span className={styles.muted}>Owner</span>
                    <span className={styles.spaceSeat}>Full seat</span>
                  </div>
                </div>
              ) : (
                <div className={styles.space}>
                  <span className={styles.spaceAvatar} aria-hidden>{(teamName ?? "M").charAt(0).toUpperCase()}</span>
                  <div className={styles.spaceLines}>
                    <span>{teamName ?? "My team"}</span>
                    <span className={styles.muted}>Owner</span>
                    <span className={styles.spaceSeat}>Full seat</span>
                    {/* Ours: the local team's Rename (Home: right-click the team's name) */}
                    <Link tight onClick={() => setDialog("team")} data-rename-team="">
                      Rename team
                    </Link>
                  </div>
                </div>
              )}
              <p className={`${styles.text} ${styles.strong} ${styles.spaceNote}`}>
                <Link onClick={() => openLink("https://help.figma.com/hc/en-us/articles/27468498501527")}>Learn</Link> what products are included in each seat.
              </p>
            </section>
          </>
        ) : (
          <Section heading="Account" data-settings-section="log-in">
            <div className={styles.signedOut}>
              <p className={styles.text}>Log in to change your name, photo and role, see your sessions and make personal access tokens.</p>
              <Button
                variant="primary"
                disabled={!account.available || !!account.state?.signingIn}
                onClick={() => void account.run("log-in").then((f) => f && showToast({ kind: "error", message: f }))}
              >
                {account.state?.signingIn ? "Waiting for the browser…" : "Log in with Google…"}
              </Button>
            </div>
          </Section>
        )}
        <Divider />
        <Section heading="Language" data-settings-section="language">
          <p className={styles.value}>{language}</p>
          <Link onClick={() => setDialog("language")}>Change language</Link>
        </Section>
        <Divider />
        <Section heading="Theme" data-settings-section="theme">
          <Select
            label="Theme"
            className={styles.themeSelect}
            variant="outlined"
            value={theme.preference}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
            onChange={(v) => setThemePreference(v as ThemePreference)}
          />
          <div className={styles.switchRow}>
            <Switch label="Enhance contrast" size="large" checked={theme.contrast} onChange={setContrast} data-enhance-contrast="" />
            <div className={styles.switchText}>
              <span>Enhance contrast</span>
              <span className={styles.muted}>When enabled, contrast between text and controls and their backgrounds will be increased</span>
            </div>
          </div>
        </Section>
        {user && (
          <>
            <Divider />
            <Section heading="New features" data-settings-section="new-features">
              <div className={styles.feature}>
                Closed captions <span className={styles.beta}>Beta</span>
              </div>
              <div className={`${styles.switchRow} ${styles.featureSwitch}`}>
                <Switch label="Closed captions" size="large" checked={prefs.closedCaptions === true} onChange={(c) => void savePrefs({ closedCaptions: c })} data-closed-captions="" />
                <span>Enable closed captioning when using audio inside your files.</span>
              </div>
            </Section>
          </>
        )}
        {user && fontsBridge() && (
          <>
            <Divider />
            <Section heading="API requests" data-settings-section="rest-helper">
              <div className={styles.switchRow}>
                <Switch label="Answer API requests for my files" size="large" checked={prefs.restHelper !== false} onChange={(c) => void savePrefs({ restHelper: c })} data-rest-helper="" />
                <span>Answer API requests for my files while Wecra is open. When no one has a file open, Wecra opens it in the background to answer.</span>
              </div>
            </Section>
          </>
        )}
        {user && personal && cloud && (
          <>
            <Divider />
            <OfflineCache cloud={cloud} />
          </>
        )}
        {/* The web app has no fonts on the computer (docs/desktop.md §14.2: the uploaded fonts are files there) */}
        {fontsBridge() && (
          <>
            <Divider />
            <UploadedFonts />
          </>
        )}
        <Divider />
        <Section heading="Library" data-settings-section="library">
          <p className={styles.text}>
            <Link onClick={() => setDialog("libraries")}>Enable libraries</Link> for all files in your drafts
          </p>
        </Section>
        {user && (
          <>
            <Divider />
            <Section heading="View history" data-settings-section="view-history">
              <p className={styles.text}>
                {prefs.viewHistory === false ? "Your view history is off: teammates don’t see when you view their files, and you don’t see theirs. " : "You can currently see teammates’ view history in your files, and they can see yours. "}
                <Link onClick={() => openLink("https://help.figma.com/hc/en-us/articles/29638316371479")}>Learn more</Link>
              </p>
              <Link onClick={() => setDialog("view-history")}>Change preference</Link>
            </Section>
            <Divider />
            <Section heading="Account" data-settings-section="account">
              <Link danger onClick={() => setDialog("delete")} data-delete-account="">
                Delete account
              </Link>
            </Section>
          </>
        )}
      </div>

      {dialog === "team" && (
        <ChangeNameDialog
          title="Rename team"
          label="Team name"
          name={teamName ?? "My team"}
          onSave={(n) => getStoreClient().workspace.setTeamName(n).then((w) => setTeamName(w.teamName), () => showToast({ kind: "error", message: "Couldn’t rename the team" }))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "name" && <ChangeNameDialog name={name} onSave={(n) => save({ name: n })} onClose={() => setDialog(null)} />}
      {dialog === "email" && user && <ChangeEmailDialog email={user.email} provider={profile?.provider ?? "google"} onClose={() => setDialog(null)} />}
      {dialog === "role" && <ChangeRoleDialog role={profile?.role ?? null} onSave={(r) => save({ role: r })} onClose={() => setDialog(null)} />}
      {dialog === "language" && <ChangeLanguageDialog language={prefs.language ?? "en"} onSave={(l) => savePrefs({ language: l })} onClose={() => setDialog(null)} />}
      {dialog === "view-history" && <ViewHistoryDialog on={prefs.viewHistory !== false} onSave={(on) => savePrefs({ viewHistory: on })} onClose={() => setDialog(null)} />}
      {dialog === "libraries" && <DraftLibrariesDialog onClose={() => setDialog(null)} />}
      {dialog === "delete" && user && (
        <DeleteAccountDialog
          email={user.email}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            showToast({ message: "Your account was deleted" });
          }}
        />
      )}
    </div>
  );
}

const faces = new Map<string, Promise<void>>();

/** Loads each uploaded face into the page (a FontFace from its bytes) so its row's sample draws in it. */
function useFaces(fonts: UploadedFont[], read: ((id: string) => Promise<Uint8Array>) | null): Set<string> {
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!read) return;
    let live = true;
    for (const f of fonts) {
      const family = `designer-uploaded-${f.id}-${f.weight}-${f.italic ? "i" : "n"}`;
      let face = faces.get(family);
      if (!face) {
        // The whole weight range: a variable font's instance is its weight on the wght axis.
        face = read(f.id).then((bytes) => new FontFace(family, bytes.slice().buffer, { weight: "1 1000", style: f.italic ? "italic" : "normal" }).load()).then((ff) => void document.fonts.add(ff));
        faces.set(family, face);
      }
      void face.then(() => live && setLoaded((s) => (s.has(f.id + f.style) ? s : new Set(s).add(f.id + f.style))), () => {});
    }
    return () => {
      live = false;
    };
  }, [fonts, read]);
  return loaded;
}

/** "Your uploaded fonts": Upload font (main's Open dialog), each face's row with "Rag 123" in it and its trash button. */
function UploadedFonts() {
  const api = fontsBridge();
  const [fonts, setFonts] = useState<UploadedFont[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api) return;
    let live = true;
    void api.uploaded().then((f) => live && setFonts(f), () => {});
    return () => {
      live = false;
    };
  }, [api]);
  const loaded = useFaces(fonts, api ? api.read : null);
  return (
    <Section heading="Your uploaded fonts" data-settings-section="fonts">
      <p className={styles.text}>Upload fonts for your personal use. These fonts will be available across the files you view or edit.</p>
      <Button
        variant="primary"
        className={styles.fontsButton}
        disabled={!api}
        loading={busy}
        data-upload-font=""
        onClick={async () => {
          if (!api) return;
          setBusy(true);
          try {
            const r = await api.upload();
            if ("cancelled" in r) return;
            setFonts(r.fonts);
            if (r.failed.length) showToast({ kind: "error", message: `Couldn’t upload ${r.failed.join(", ")}: not a font file we can read` });
          } finally {
            setBusy(false);
          }
        }}
      >
        Upload font
      </Button>
      {fonts.length > 0 && (
        <div className={styles.fonts} role="list" aria-label="Your uploaded fonts">
          {fonts.map((f) => (
            <div key={`${f.id}:${f.style}`} role="listitem" className={styles.fontRow} data-uploaded-font={f.family}>
              <span className={styles.fontNames}>
                <span>{f.family}</span>
                <span className={styles.fontStyle}>{f.style}</span>
              </span>
              <span
                className={styles.fontSample}
                style={loaded.has(f.id + f.style) ? { fontFamily: `"designer-uploaded-${f.id}-${f.weight}-${f.italic ? "i" : "n"}"`, fontWeight: f.weight, fontStyle: f.italic ? "italic" : "normal" } : { visibility: "hidden" }}
                aria-hidden
              >
                Rag 123
              </span>
              <IconButton
                icon="24.trash"
                label={`Remove ${f.family} ${f.style}`}
                tooltip={false}
                onClick={async () => {
                  if (!api) return;
                  setFonts(await api.removeUploaded(f.id));
                }}
              />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

