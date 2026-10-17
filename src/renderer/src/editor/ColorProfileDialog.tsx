/**
 * File › Color profile… (Figma's document colour profile modal, atlas 07 §14): the file's profile, sRGB or Display P3;
 * picking the other one offers Convert (the default, remembered: the colours look the same, their values change —
 * into sRGB, colours outside it are clamped) or Assign (the values stay, the colours look different), confirmed as
 * "Convert to …" / "Assign …". One undo step (colorProfile.ts). Unverified: the modal's English (Figma's keys
 * `color_management.document_modal.*` only) and its layout — this follows its options and buttons.
 */
import { useState } from "react";
import { Button, Dialog, RadioGroup } from "@/ds";
import { useEditor } from "./controller";
import { useUI } from "./hooks";
import { changeColorProfile, documentProfile, preferredChange, type DocumentProfile, type ProfileChange } from "./colorProfile";
import { t, useT } from "@/i18n";
import styles from "./ColorProfileDialog.module.css";

const NAME: Record<DocumentProfile, string> = { SRGB: "sRGB", DISPLAY_P3: "Display P3" };

export function ColorProfileDialog() {
  const open = useUI((s) => !!s.colorProfileDialog);
  return open ? <ColorProfileForm /> : null;
}

function ColorProfileForm() {
  useT();
  const ed = useEditor();
  const current = documentProfile(ed);
  const [to, setTo] = useState<DocumentProfile>(current);
  const [how, setHow] = useState<ProfileChange>(preferredChange);
  const close = () => {
    ed.ui.set({ colorProfileDialog: false });
    ed.focusCanvas();
  };
  const changing = to !== current;
  const names = { from: t(NAME[current]), to: t(NAME[to]) };
  return (
    <Dialog
      title={t("Color profile")}
      open
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!changing}
            onClick={() => {
              changeColorProfile(ed, to, how);
              close();
            }}
          >
            {how === "convert" ? t("Convert to {profile}", { profile: names.to }) : t("Assign {profile}", { profile: names.to })}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <RadioGroup label={t("Color profile")} value={to} options={(["SRGB", "DISPLAY_P3"] as const).map((p) => ({ value: p, label: p === current ? t("{profile} (current)", { profile: t(NAME[p]) }) : t(NAME[p]) }))} onChange={(v) => setTo(v as DocumentProfile)} />
        {changing && (
          <>
            <RadioGroup
              label={t("Change")}
              value={how}
              options={[
                { value: "convert", label: t("Convert") },
                { value: "assign", label: t("Assign") },
              ]}
              onChange={(v) => setHow(v as ProfileChange)}
            />
            <p className={styles.note}>
              {how === "convert" ? t("Colors keep how they look; their values change ({from} → {to}).", names) : t("Color values stay as they are; colors will look different in {to}.", names)}
            </p>
            {how === "convert" && to === "SRGB" && <p className={styles.warning}>{t("Colors outside sRGB will be clamped.")}</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}
