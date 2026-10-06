import { ThemeProvider } from "@/context/ThemeContext";
import { tabParams } from "@/app/bridge";
import { EditorTab } from "./EditorTab";
import { PreviewTab } from "./PreviewTab";
import { CVEditor } from "@/cv/CVEditor";
import { installTabHost } from "./host";

// In the desktop app: main's questions and the menu's commands, answered from this page.
installTabHost();

/** A tab's page (`?tab=…&kind=…&slug=…` — a view of its own in the desktop app, a frame of the shell in a browser): a project's editor, its saved draft's preview, or the CV's editor. */
export default function TabApp() {
  return (
    <ThemeProvider>
      {tabParams.kind === "preview" ? <PreviewTab slug={tabParams.slug} tabId={tabParams.id} /> : tabParams.kind === "cv" ? <CVEditor tabId={tabParams.id} /> : <EditorTab slug={tabParams.slug} tabId={tabParams.id} />}
    </ThemeProvider>
  );
}
