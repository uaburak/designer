/**
 * Settings › Community (help.figma.com 1500006061462, 360038510833, 4404108672663): the Community profile — a handle
 * ("Claim your handle": 15 letters, numbers or underscores at most, unique), then the profile's Bio (160), Location,
 * Website and the X and Instagram links — kept on the server with the account. Publishing to Community isn't built:
 * the profile is ready for it.
 */
import { useState } from "react";
import { Button, TextArea, TextInput, showToast } from "@/ds";
import { HANDLE_RE, MAX_BIO, type CommunityProfile } from "@shared/account";
import { Divider, Link, Section } from "./AccountTab";
import { useProfile } from "./useProfile";
import styles from "./Settings.module.css";

export function CommunityTab() {
  const { account, profile, save } = useProfile();
  // The fields as typed (null: as saved).
  const [edits, setEdits] = useState<CommunityProfile | null>(null);
  const draft = edits ?? profile?.community ?? {};
  const setDraft = (fn: (d: CommunityProfile) => CommunityProfile) => setEdits(fn(draft));
  const [claiming, setClaiming] = useState(false);
  const [handle, setHandle] = useState("");
  if (!account.state?.user)
    return (
      <div className={styles.page}>
        <Section heading="Community profile">
          <p className={`${styles.text} ${styles.muted}`}>Log in to create your Community profile.</p>
        </Section>
      </div>
    );
  const current = profile?.community ?? {};
  const field = (k: keyof CommunityProfile, label: string, placeholder: string) => (
    <div className={styles.formRow}>
      <span className={styles.formLabel}>{label}</span>
      <TextInput label={label} placeholder={placeholder} value={draft[k] ?? ""} onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))} maxLength={200} />
    </div>
  );
  const changed = JSON.stringify({ ...current, handle: undefined }) !== JSON.stringify({ ...draft, handle: undefined });
  const handleOk = HANDLE_RE.test(handle);
  return (
    <div className={styles.page} data-settings-community="">
      <Section heading="Handle" data-settings-section="handle">
        <p className={`${styles.value} ${current.handle ? styles.handle : styles.muted}`}>{current.handle ? `@${current.handle}` : "Register a handle to create your Community profile."}</p>
        {claiming ? (
          <div className={styles.profileFields}>
            <TextInput label="Handle" prefix="@" value={handle} onChange={setHandle} placeholder="handle" maxLength={15} autoFocus invalid={!!handle && !handleOk} />
            <span className={styles.muted}>15 characters at most: letters, numbers and underscores.</span>
            <div className={styles.stack}>
              <Button
                variant="primary"
                disabled={!handleOk}
                onClick={async () => {
                  const p = await save({ community: { ...current, handle } });
                  if (p) {
                    setClaiming(false);
                    showToast({ message: `@${handle} is yours` });
                  }
                }}
              >
                {current.handle ? "Save" : "Claim your handle"}
              </Button>
            </div>
          </div>
        ) : (
          <Link
            onClick={() => {
              setHandle(current.handle ?? "");
              setClaiming(true);
            }}
            data-claim-handle=""
          >
            {current.handle ? "Change handle" : "Claim your handle"}
          </Link>
        )}
      </Section>
      <Divider />
      <Section heading="Profile" data-settings-section="profile">
        <div className={styles.profileFields}>
          <div className={styles.formRow}>
            <span className={styles.formLabel}>{`Bio (${(draft.bio ?? "").length}/${MAX_BIO})`}</span>
            <TextArea label="Bio" value={draft.bio ?? ""} onChange={(v) => setDraft((d) => ({ ...d, bio: v.slice(0, MAX_BIO) }))} placeholder="Tell the Community about yourself" minRows={3} />
          </div>
          {field("location", "Location", "Location")}
          {field("website", "Website", "https://")}
          {field("x", "X (formerly Twitter)", "@username")}
          {field("instagram", "Instagram", "@username")}
          <div className={styles.stack}>
            <Button variant="primary" disabled={!changed} onClick={() => void save({ community: { ...draft, handle: current.handle } }).then((p) => {
                if (!p) return;
                setEdits(null);
                showToast({ message: "Profile saved" });
              })} data-save-profile="">
              Save
            </Button>
          </div>
        </div>
      </Section>
    </div>
  );
}
