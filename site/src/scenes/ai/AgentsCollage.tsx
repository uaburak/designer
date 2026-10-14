// Agents and MCP (docs/ai.md): a coding agent in the Agents panel builds a screen in the file through Wecra's MCP
// tools (their names under each step, the app's words over them). Three steps: it reads the file's colour
// variables, makes the screen (it lands on the canvas as that step ends) and applies the variables (the screen takes
// the brand's colour); then it says what it made, and the screen is selected.
import { useState } from "react";
import { Collage, FrameName, Piece, Selection } from "../collage/kit";
import type { Run } from "../runtime/motion";
import { agents, AgentText, ChatPanel, Steps, UserMessage, type Step } from "./chat";
import styles from "./ai.module.css";

const TOOLS = ["get_variable_defs", "create_nodes", "apply_variable"];

export default function AgentsCollage() {
  const [asked, setAsked] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [built, setBuilt] = useState(0);
  const [done, setDone] = useState(false);

  const script = async (run: Run) => {
    await run.wait(800);
    setAsked(true);
    await run.wait(900);
    for (const name of TOOLS) {
      setSteps((s) => [...s, { name, done: false }]);
      await run.wait(1100);
      setSteps((s) => s.map((x, j) => (j === s.length - 1 ? { ...x, done: true } : x)));
      setBuilt((b) => b + 1);
      await run.wait(500);
    }
    await run.wait(300);
    setDone(true);
  };

  const colored = built >= 3;
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

      <FrameName x={500} y={64} show={built >= 2} selected={done}>
        Sign up
      </FrameName>
      {/* Made in auto layout; the colour variables cross-fade in */}
      <div className={styles.build} data-on={built >= 2 || undefined} data-auto="" data-colored={colored || undefined} style={{ left: 500, top: 64 }}>
        <span className={styles.buildTitle}>
          <span>Bloom</span>
          <span data-brand="">Bloom</span>
        </span>
        <span className={styles.buildHead}>
          Create your account
        </span>
        <span className={styles.buildField}>
          Email
        </span>
        <span className={styles.buildField}>
          Password
        </span>
        <span className={styles.buildButton}>
          <i />
          <span>Sign up</span>
        </span>
      </div>
      <Selection box={{ x: 500, y: 64, w: 240, h: 440 }} show={done} size="240 × 440" />
    </Collage>
  );
}
