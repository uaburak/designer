/**
 * Library analytics (docs/data.md §17): the modal for one org library — Home renders it from a library's context
 * menu (`LibraryAnalyticsModal({store, libraryKey})`, `store` the StoreApi), the editor from the file name menu.
 */
export { LibraryAnalyticsModal, type AnalyticsStore, type LibraryAnalyticsModalProps } from "./LibraryAnalyticsModal";
export { canShowLibraryAnalytics, EditorLibraryAnalytics, openLibraryAnalytics } from "./EditorAnalytics";
