/**
 * The empty board (docs/social.md §6.4): a page without posts shows a card in the middle of the visible canvas — "Tell
 * the agent what to make", three example prompts (a click puts one in the composer), the board's brand, and Start from
 * a template (the left panel's Templates). The agent's composer takes the focus when the card first shows.
 */
import { useEffect } from "react";
import { Button } from "@/ds";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { BrandPicker } from "./BrandPicker";
import { draftForAgent } from "./SocialMode";
import { useSocialBoard } from "./socialState";
import styles from "./EmptyBoard.module.css";

/** The card's example prompts [ours] */
export const EXAMPLE_PROMPTS = [
  "An Instagram post and a story for our new product",
  "A LinkedIn post announcing this week's news",
  "A 6-second Reel from the product photo",
];

export function EmptyBoard() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const empty = board.page !== "" && board.posts.length === 0;
  // The composer takes the focus once the card shows (nothing typed is replaced).
  useEffect(() => {
    if (empty && ed.ui.get().socialRightTab !== "properties") draftForAgent(ed, "");
  }, [ed, empty]);
  if (!empty) return null;
  return (
    <div className={styles.wrap} data-social-empty="">
      <div className={styles.card} role="region" aria-label={t("Tell the agent what to make")}>
        <h2 className={styles.title}>{t("Tell the agent what to make")}</h2>
        <p className={styles.body}>{t("Describe the posts in the chat on the right — the agent makes them here, on the board.")}</p>
        <div className={styles.prompts}>
          {EXAMPLE_PROMPTS.map((p) => (
            <button key={p} type="button" className={styles.prompt} onClick={() => draftForAgent(ed, t(p))} data-example-prompt="">
              {t(p)}
            </button>
          ))}
        </div>
        <div className={styles.row}>
          <BrandPicker className={styles.brand} />
          <Button variant="secondary" onClick={() => ed.ui.set({ railTab: "posts", socialTemplatesOpen: true, variablesOpen: false })}>
            {t("Start from a template")}
          </Button>
        </div>
      </div>
    </div>
  );
}
