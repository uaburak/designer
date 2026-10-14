// Agents and MCP (docs/ai.md): a coding agent in the Agents panel builds a screen in the file through Wecra's MCP
// tools (their names under each step, the app's words over them); each step lands on the canvas as it ends.
import { useRef, useState } from "react";
import { Collage, FrameName, Piece, Selection, useFlip } from "../collage/kit";
import type { Run } from "../runtime/motion";
import { agents, AgentText, ChatPanel, Steps, UserMessage, type Step } from "./chat";
import styles from "./ai.module.css";

const TOOLS = ["get_variable_defs", "create_nodes", "set_auto_layout", "apply_variable", "set_selection"];

export default function AgentsCollage() {
  const [asked, setAsked] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [built, setBuilt] = useState(0);
  const [done, setDone] = useState(false);
  const buildRef = useRef<HTMLDivElement>(null);
  useFlip(buildRef, built >= 3);

  const script = async (run: Run) => {
    await run.wait(700);
    setAsked(true);
    await run.wait(700);
    for (const [i, name] of TOOLS.entries()) {
      setSteps((s) => [...s, { name, done: false }]);
      await run.wait(620 + (i % 2) * 180);
      setSteps((s) => s.map((x, j) => (j === s.length - 1 ? { ...x, done: true } : x)));
      setBuilt(i + 1);
    }
    await run.wait(400);
    setDone(true);
  };

  const colored = built >= 4;
  return (
    <Collage size={[860, 560]} focus={[0.5, 0.5]} safe={720} script={script}>
      <Piece surface x={48} y={32} w={340} h={496} d={0} from="left" className={styles.chatPiece}>
        <ChatPanel composer="Ask Codex to change something" agent="Codex" focus={done}>
          {asked && <UserMessage>Make a sign-up screen for Bloom, with our colours</UserMessage>}
          {steps.length > 0 && (
            <div className={agents.agent}>
              <span className={agents.agentName}>Codex</span>
              <Steps steps={steps} />
              {done && <AgentText>Made “Sign up” with a header, two fields and a button, in Bloom’s colour variables. It’s selected on the canvas.</AgentText>}
            </div>
          )}
        </ChatPanel>
      </Piece>

      <FrameName x={500} y={64} show={built >= 2} selected={built >= 5}>
        Sign up
      </FrameName>
      {/* Auto layout set: the parts spread to the new gap by FLIP (useFlip); the colour variables cross-fade in */}
      <div ref={buildRef} className={styles.build} data-on={built >= 2 || undefined} data-auto={built >= 3 || undefined} data-colored={colored || undefined} style={{ left: 500, top: 64 }}>
        <span className={styles.buildTitle} data-flip="">
          <span>Bloom</span>
          <span data-brand="">Bloom</span>
        </span>
        <span className={styles.buildHead} data-flip="">
          Create your account
        </span>
        <span className={styles.buildField} data-flip="">
          Email
        </span>
        <span className={styles.buildField} data-flip="">
          Password
        </span>
        <span className={styles.buildButton} data-flip="">
          <i />
          <span>Sign up</span>
        </span>
      </div>
      <Selection box={{ x: 500, y: 64, w: 240, h: 440 }} show={built >= 5} size="240 × 440" />
    </Collage>
  );
}
