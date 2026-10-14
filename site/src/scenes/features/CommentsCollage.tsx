// Comments: a pin dropped on a card, its thread (a question, a reply typed in), then resolved.
import { useState } from "react";
import { Button } from "@/ds/components/Button";
import { Avatar } from "@/ds/components/Misc";
import { Icon } from "@/ds/icons/Icon";
import { Collage, CURSOR, Cursor, Piece } from "../collage/kit";
import type { Run } from "../runtime/motion";
import styles from "./features.module.css";

const REPLY = "Done, it fits on one line now.";

export default function CommentsCollage() {
  const [pin, setPin] = useState(false);
  const [thread, setThread] = useState(false);
  const [typed, setTyped] = useState(0);
  const [sent, setSent] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [ada, setAda] = useState<[number, number]>([60, 380]);

  const script = async (run: Run) => {
    await run.wait(900);
    setAda([214, 66]);
    await run.wait(1200);
    setPin(true);
    await run.wait(500);
    setThread(true);
    setAda([330, 360]);
    await run.wait(1000);
    await run.tween(1400, (t) => setTyped(Math.round(REPLY.length * t)), (t) => t);
    await run.wait(300);
    setSent(true);
    await run.wait(1600);
    setResolved(true);
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
      <div className={styles.pin} data-out={!pin || undefined} data-resolved={resolved || undefined} style={{ left: 226, top: 40 }}>
        {resolved ? <Icon name="16.check" /> : <Avatar name="Ada Lin" size={24} />}
      </div>

      <Piece surface x={132} y={112} w={252} show={thread} className={styles.thread}>
        <div className={styles.threadHead}>
          <span>Comment</span>
          <span className={styles.threadResolve} data-on={resolved || undefined}>
            <Icon name="16.check" />
            {resolved ? "Resolved" : "Resolve"}
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
          <span className={styles.replyField}>
            {REPLY.slice(0, typed) || <span className={styles.placeholder}>Reply</span>}
            {typed > 0 && typed < REPLY.length && <span className={styles.caret} />}
          </span>
          <Button variant="primary" disabled={typed < REPLY.length}>
            Post
          </Button>
        </div>
      </Piece>
      <Cursor x={ada[0]} y={ada[1]} color={CURSOR.purple} name="Ada" d={300} />
    </Collage>
  );
}
