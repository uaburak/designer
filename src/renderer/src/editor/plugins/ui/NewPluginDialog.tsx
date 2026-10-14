/**
 * Plugins › Development › New plugin… (docs/plugins.md §6): Figma's "Create a plugin" — Figma design or Dev Mode,
 * the name, the template (Default, Run once, Custom UI; Dev Mode: Inspect, Code Generator), then "Save as": main writes
 * the template's files into the folder the person picks (plugins:new-plugin, 5e) and the plugin joins Development.
 */
import { useState } from "react";
import { Button, Dialog, SegmentedControl, Select, TextInput } from "@/ds";
import { t, useT } from "@/i18n";
import type { PluginService } from "../service";

type Template = "default" | "run-once" | "custom-ui" | "inspect" | "codegen";
const DESIGN: { value: Template; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "run-once", label: "Run once" },
  { value: "custom-ui", label: "Custom UI" },
];
const DEV: { value: Template; label: string }[] = [
  { value: "inspect", label: "Inspect" },
  { value: "codegen", label: "Code Generator" },
];

export function NewPluginDialog({ service, onClose }: { service: PluginService; onClose: () => void }) {
  useT();
  const [editor, setEditor] = useState<"figma" | "dev">("figma");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<Template>("default");
  const [busy, setBusy] = useState(false);
  const templates = (editor === "figma" ? DESIGN : DEV).map((o) => ({ ...o, label: t(o.label) }));
  return (
    <Dialog
      open
      title={t("Create a plugin")}
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={!name.trim() || busy}
          onClick={() => {
            setBusy(true);
            void service.newPlugin(name.trim(), template).then((made) => (made ? onClose() : setBusy(false)));
          }}
        >
          {t("Save as")}
        </Button>
      }
    >
      <SegmentedControl
        label={t("Editor")}
        value={editor}
        fullWidth
        options={[
          { value: "figma", label: t("Figma design") },
          { value: "dev", label: t("Dev Mode") },
        ]}
        onChange={(v) => {
          setEditor(v as "figma" | "dev");
          setTemplate(v === "dev" ? "inspect" : "default");
        }}
      />
      <TextInput label={t("Name your plugin")} placeholder={t("Name your plugin")} value={name} onChange={setName} autoFocus />
      <Select label={t("Template")} value={template} options={templates} onChange={(v) => setTemplate(v as Template)} />
    </Dialog>
  );
}
