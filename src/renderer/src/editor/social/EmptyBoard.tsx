/**
 * The empty board (docs/social.md §19, replacing round 18's card the owner couldn't close): a page of a Social file
 * with no posts shows a strip over the canvas's top — never a modal, never in the canvas's middle — with a button per
 * common format (a click makes that post and its grid; it opens in focus), Start from a template, and × (it stays
 * closed for the file's session; the first post takes it away). The agent's suggestions are the left panel's own.
 */
import { Button, IconButton } from "@/ds";
import { formatById } from "@shared/social/formats";
import { t, useT } from "@/i18n";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { applySelection } from "../agents/mcpTools";
import { canWritePosts, editorWriter, newPost } from "./actions";
import { useSocialBoard } from "./socialState";
import styles from "./EmptyBoard.module.css";

/** The strip's formats [ours]: the owner's Instagram 3:4 post first, then the formats he makes most. */
export const STARTER_FORMATS = ["instagram.portrait", "instagram.reel", "instagram.story", "linkedin.square", "facebook.post", "tiktok.video"];

export function EmptyBoard() {
  useT();
  const ed = useEditor();
  const board = useSocialBoard(ed);
  const closed = useUI((s) => !!s.socialStarterClosed);
  const empty = board.page !== "" && board.posts.length === 0;
  if (!empty || closed) return null;
  const write = canWritePosts(ed);
  const make = (formatId: string) => {
    const id = newPost(ed, editorWriter(ed), { formatId, brandId: ed.ui.get().socialBrandId ?? null });
    applySelection(ed, [id], false);
  };
  return (
    <div className={styles.strip} role="region" aria-label={t("Start the board")} data-social-empty="">
      <div className={styles.head}>
        <h2 className={styles.title}>{t("No designs on this board yet — what shall we start with?")}</h2>
        <IconButton icon="24.close" label={t("Close")} onClick={() => ed.ui.set({ socialStarterClosed: true })} />
      </div>
      <div className={styles.formats}>
        {STARTER_FORMATS.map((id) => {
          const f = formatById(id);
          return f ? (
            <Button key={id} variant="secondary" icon="24.plus.small" disabled={!write} onClick={() => make(id)} data-starter-format={id}>
              {t(f.name)}
            </Button>
          ) : null;
        })}
      </div>
      <div className={styles.row}>
        <Button variant="secondary" onClick={() => ed.ui.set({ railTab: "posts", socialTemplatesOpen: true, variablesOpen: false })}>
          {t("Start from a template")}
        </Button>
        <span className={styles.hint}>{t("or tell the agent on the left — its designs land in their grids here")}</span>
      </div>
    </div>
  );
}
