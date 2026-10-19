/**
 * Figma's VectorOperationPanel (Atlas 05 §9.2): with boolean groups selected that an older version of the boolean
 * operations made (the schema's vector operation version 0 or absent — booleans from before Figma's update), a note
 * under the header and a secondary "Update" that brings them to the latest version (the engine's
 * UPGRADE_VECTOR_OPERATION, one undo step). The note's English is unverified: Figma ships only its keys
 * (vector_operation.update_text with the number of layers, …update_button).
 */
import { Button } from "@/ds";
import { useEditor } from "../../controller";
import { engineEnabled, runEditorCommand } from "../../commands";
import { useTopics } from "../../hooks";
import { typeOf, type PanelNode } from "./shared";
import { t, tp, useT } from "@/i18n";
import styles from "./Design.module.css";

export function VectorOperationNote({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  // The command's state changes with the selection and with every edit.
  useTopics(ed.store, ["selection", "undo"]);
  if (!nodes.some((n) => typeOf(n) === "BOOLEAN_OPERATION") || !engineEnabled(ed, "UPGRADE_VECTOR_OPERATION")) return null;
  return (
    <div className={styles.vectorOperation} data-vector-operation="">
      <p className={styles.vectorOperationText}>{tp(nodes.length, "This boolean group uses an older version of boolean operations.", "These boolean groups use an older version of boolean operations.")}</p>
      <Button variant="secondary" onClick={() => runEditorCommand(ed, "vector.update-boolean")}>
        {t("Update")}
      </Button>
    </div>
  );
}
