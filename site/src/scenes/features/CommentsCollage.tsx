// Comments: a pin dropped on a card, its thread (a question, a reply typed in and posted), then resolved. The pin lands
// on a spring, the thread opens from it, the reply is typed at a person's pace with a blinking caret, and the posted
// message takes the composer's place (stacked in one grid cell: the thread never changes size).
import { useState } from "react";
import { Button } from "@/ds/components/Button";
import { Avatar } from "@/ds/components/Misc";
import { Icon } from "@/ds/icons/Icon";
import { around, Collage, CURSOR, Cursor, Piece, usePointer } from "../collage/kit";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

const REPLY = "Done, it fits on one line now.";
const PIN: [number, number] = [226, 40];
const POST: [number, number] = [345, 232];
const RESOLVE: [number, number] = [318, 133];

export default function CommentsCollage() {
  const [pin, setPin] = useState(false);
  const [thread, setThread] = useState(false);
  const [typed, setTyped] = useState("");
  const [typing, setTyping] = useState(false);
  const [sent, setSent] = useState(false);
  const [resolved, setResolved] = useState(false);
  const ada = usePointer([60, 380]);
  const ken = usePointer([300, 430]);

  const script = async (run: Run) => {
    await run.wait(900);
    await ada.click(run, [PIN[0] - 8, PIN[1] + 30]);
    setPin(true);
    await run.wait(420);
    setThread(true);
    await ada.to(run, [70, 300], { ms: 900 });
    await run.wait(300);
    setTyping(true);
    void ken.to(run, [POST[0] - 70, POST[1] + 40], { wait: false, ms: 1100 });
    await run.wait(200);
    await run.type(REPLY, setTyped);
    await run.wait(260);
    await ken.click(run, POST);
    setSent(true);
    setTyping(false);
    await run.wait(1200);
    await ada.click(run, RESOLVE);
    setResolved(true);
    await Promise.all([ada.idle(run, around(RESOLVE, 14)), ken.idle(run, around([POST[0] - 40, POST[1] + 56], 12), { pause: 3000 })]);
  };

  return (
    <Collage size={[400, 400]} script={script}>
      <Piece x={36} y={48} w={220} h={150} d={0} from="fade">
        <div className={styles.cmtCard}>
          <span className={styles.cmtTitle}>Spring collection, now in store</span>
          <span className={styles.cmtLine} style={{ width: 150 }} />
          <span className={styles.cmtLine} style={{ width: 110 }} />
          <span className={styles.cmtButton}>Shop now</span>
        </div>
      </Piece>
      <div className={styles.pin} data-out={!pin || undefined} data-resolved={resolved || undefined} style={{ left: PIN[0], top: PIN[1] }}>
        <span className={styles.pinFace}>
          <Avatar name="Ada Lin" size={24} />
        </span>
        <span className={styles.pinFace} data-check="">
          <Icon name="16.check" />
        </span>
      </div>

      <Piece surface x={132} y={112} w={252} show={thread} from="scale" origin="94px -40px" className={styles.thread}>
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
