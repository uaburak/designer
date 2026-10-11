/**
 * Home's door to one library's analytics (docs/data.md §17.1: "right-click the library in the file browser ›
 * Library analytics"). The modal itself is the editor's (round 3c, `@/editor/analytics` exports
 * `LibraryAnalyticsModal({store, libraryKey})`); it is loaded lazily, and until that module exists in the build a
 * placeholder dialog stands in. At the merge the main session may replace the glob below with
 * `lazy(() => import("@/editor/analytics").then((m) => ({ default: m.LibraryAnalyticsModal })))`.
 */
import { Suspense, lazy, type ComponentType } from "react";
import { Button, Dialog, Spinner } from "@/ds";
import type { StoreApi } from "@shared/store/repositories";
import styles from "./Files.module.css";

/** What the modal reads: the store's analytics and org libraries */
export type LibraryAnalyticsStore = Pick<StoreApi, "analytics" | "orgLibraries">;
export interface LibraryAnalyticsProps {
  store: LibraryAnalyticsStore;
  libraryKey: string;
  /** The library file's name (the placeholder's title) */
  name?: string;
  onClose: () => void;
}

type Module = { LibraryAnalyticsModal?: ComponentType<LibraryAnalyticsProps> };
// Empty until round 3c's module is in the tree (a glob matching nothing is no build error)
const found = import.meta.glob<Module>("../editor/analytics/index.ts");
const loader = Object.values(found)[0];

function Placeholder({ name, onClose }: LibraryAnalyticsProps) {
  return (
    <Dialog
      open
      size="medium"
      title="Library analytics"
      onClose={onClose}
      footer={
        <Button variant="primary" size="large" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className={styles.dialogText}>{name ? `Analytics for “${name}” aren’t available in this build yet.` : "Library analytics aren’t available in this build yet."}</p>
    </Dialog>
  );
}

const Modal: ComponentType<LibraryAnalyticsProps> = loader
  ? lazy(async () => {
      const m = await loader();
      return { default: m.LibraryAnalyticsModal ?? Placeholder };
    })
  : Placeholder;

export function LibraryAnalytics(props: LibraryAnalyticsProps) {
  return (
    <Suspense fallback={<Spinner size={24} />}>
      <Modal {...props} />
    </Suspense>
  );
}
