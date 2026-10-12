/**
 * Admin › Settings › AI (docs/ai.md §2.12; Figma's admins turn AI features on or off for the organization — the
 * wording of the rows is ours [unverified]): "AI features" (`aiEnabled`) and "AI credit limit" (`aiCreditLimit`,
 * credits per member per month; none by default). Members' apps apply both (src/shared/ai/orgPolicy.ts).
 */
import { useState } from "react";
import { Button, Dialog, RadioGroup, TextInput } from "@/ds";
import type { OrgSettings } from "@shared/org/types";
import { styles } from "./parts";

export const creditLimitSummary = (s: Pick<OrgSettings, "aiCreditLimit">) => (s.aiCreditLimit === null ? "No limit" : `${s.aiCreditLimit.toLocaleString("en-US")} credits a month`);

export function CreditLimitDialog({ value, onSave, onClose }: { value: number | null; onSave: (v: number | null) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"none" | "limit">(value === null ? "none" : "limit");
  const [text, setText] = useState(value === null ? "4250" : String(value));
  const n = Math.round(Number(text.replace(/[,\s]/g, "")));
  const valid = mode === "none" || (text.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 10_000_000);
  return (
    <Dialog
      title="AI credit limit"
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => {
              onSave(mode === "none" ? null : n);
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className={styles.form} data-ai-limit-dialog="">
        <RadioGroup
          label="AI credit limit"
          value={mode}
          options={[
            { value: "none", label: "No limit" },
            { value: "limit", label: "Limit each member's credits a month" },
          ]}
          onChange={(v) => setMode(v === "limit" ? "limit" : "none")}
        />
        <TextInput label="Credits a month" value={text} disabled={mode !== "limit"} invalid={!valid} onChange={setText} data-ai-limit-input="" />
        <span className={styles.note}>Members whose credits run out can't use AI features until their credits reset on the 1st of the month.</span>
      </div>
    </Dialog>
  );
}
