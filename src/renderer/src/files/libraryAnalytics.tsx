/**
 * Home's door to one library's analytics (docs/data.md §17.1: "right-click the library in the file browser ›
 * Library analytics"). The modal itself is the editor's (`@/editor/analytics`), loaded lazily.
 */
import { Suspense, lazy, type ComponentType } from "react";
import { Spinner } from "@/ds";
import type { StoreApi } from "@shared/store/repositories";

/** What the modal reads: the store's analytics and org libraries */
export type LibraryAnalyticsStore = Pick<StoreApi, "analytics" | "orgLibraries">;
export interface LibraryAnalyticsProps {
  store: LibraryAnalyticsStore;
  libraryKey: string;
  /** The library file's name */
  name?: string;
  /** The org: turns on "Compare with" */
  orgId?: string;
  onClose: () => void;
}

const Modal = lazy(() => import("@/editor/analytics").then((m) => ({ default: m.LibraryAnalyticsModal as ComponentType<LibraryAnalyticsProps> })));

export function LibraryAnalytics(props: LibraryAnalyticsProps) {
  return (
    <Suspense fallback={<Spinner size={24} />}>
      <Modal {...props} />
    </Suspense>
  );
}
