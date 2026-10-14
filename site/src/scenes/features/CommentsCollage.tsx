// Comments, two people in one file (docs/site.md §2.1): Ada clicks the card and her comment is pinned there, its thread
// opening beside the pin; Kerem types a reply at a person's pace and posts it (the message takes the composer's place,
// stacked in one grid cell: the thread never changes size); Ada resolves the thread and the pin turns into a check.
// Then both rest where they last were.
import { useState } from "react";
import { Button } from "@/ds/components/Button";
import { Avatar } from "@/ds/components/Misc";
import { Icon } from "@/ds/icons/Icon";
import { Collage, CURSOR, Cursor, Piece, usePointer } from "../collage/kit";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

const REPLY = "Done, it fits on one line now.";
/** Where Ada clicks (the title): the pin's point (its bottom-left corner) lands there, the thread opens under it. */
const SPOT: [number, number] = [196, 106];
const PIN = { x: SPOT[0], y: SPOT[1] - 36 };
const THREAD = { x: 112, y: SPOT[1] + 22, w: 252 };
/** The thread's Post and Resolve buttons (stage px, measured). */
const POST: [number, number] = [THREAD.x + 206, THREAD.y + 113];
const RESOLVE: [number, number] = [THREAD.x + 182, THREAD.y + 21];

export default function CommentsCollage() {
  const [pin, setPin] = useState(false);
  const [thread, setThread] = useState(false);
  const [typed, setTyped] = useState("");
  const [typing, setTyping] = useState(false);
  const [sent, setSent] = useState(false);
  const [resolved, setResolved] = useState(false);
  const ada = usePointer([56, 330]);
  const ken = usePointer([POST[0] - 40, 360]);

  const script = async (run: Run) => {
    await run.wait(1000);
    await ada.click(run, SPOT, { beat: 260 });
    setPin(true);
    setThread(true);
    await run.wait(500);
    await ada.to(run, [64, 252], { ms: 800 });
    await run.wait(400);
    // Kerem joins and replies
    setTyping(true);
    await ken.to(run, [POST[0] - 40, POST[1] + 44], { ms: 900 });
    await run.type(REPLY, setTyped);
    await run.wait(300);
    await ken.click(run, POST, { beat: 260 });
    setSent(true);
    setTyping(false);
    await run.wait(1000);
    await ada.click(run, RESOLVE, { beat: 260 });
    setResolved(true);
  };

  return (
    <Collage size={[400, 400]} script={script}>
      <Piece x={32} y={76} w={220} h={150} d={0} from="fade">
        <div className={styles.cmtCard}>
          <span className={styles.cmtTitle}>Spring collection, now in store</span>
          <span className={styles.cmtLine} style={{ width: 150 }} />
          <span className={styles.cmtLine} style={{ width: 110 }} />
          <span className={styles.cmtButton}>Shop now</span>
        </div>
      </Piece>
      <div className={styles.pin} data-out={!pin || undefined} data-resolved={resolved || undefined} style={{ left: PIN.x, top: PIN.y }}>
        <span className={styles.pinFace}>
          <Avatar name="Ada Lin" size={24} />
        </span>
        <span className={styles.pinFace} data-check="">
          <Icon name="16.check" />
        </span>
      </div>

      <Piece surface x={THREAD.x} y={THREAD.y} w={THREAD.w} show={thread} from="scale" origin="86px -20px" className={styles.thread}>
        <div className={styles.threadHead}>
          <span>Comment</span>
          <span className={styles.threadResolve} data-on={resolved || undefined} data-pressable="">
            <Icon name="16.check" />
            <span className={styles.swap}>
              <span data-out={resolved || undefined}>Resolve</span>
              <span data-out={!resolved || undefined}>Resolved</span>
            </span>
          </span>
        </div>
        <div className={styles.msg}>
          <Avatar name="Ada Lin" size={24} />
          <div>
            <p className={styles.msgMeta}>
              <strong>Ada Lin</strong> 2m ago
            </p>
            <p>Can the title fit on one line?</p>
          </div>
        </div>
        <div className={styles.stack}>
          <div className={styles.msg} data-out={!sent || undefined}>
            <Avatar name="Kerem Aydın" size={24} />
            <div>
              <p className={styles.msgMeta}>
                <strong>Kerem Aydın</strong> Just now
              </p>
              <p>{REPLY}</p>
            </div>
          </div>
          <div className={styles.reply} data-out={sent || undefined}>
            <span className={styles.replyField} data-focus={typing || undefined}>
              {typed || <span className={styles.placeholder}>Reply</span>}
              {typing && <span className={styles.caret} data-typing={(typed.length > 0 && typed.length < REPLY.length) || undefined} />}
            </span>
            <Button variant="primary" disabled={typed.length < REPLY.length}>
              Post
            </Button>
          </div>
        </div>
      </Piece>
      <Cursor {...ken.state} color={CURSOR.green} name="Kerem" d={600} show={typing || sent} />
      <Cursor {...ada.state} color={CURSOR.purple} name="Ada" d={300} />
    </Collage>
  );
}
