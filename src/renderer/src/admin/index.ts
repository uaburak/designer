/**
 * The Admin location (Phase 7 round 1d): `AdminApp({ orgId, store })` over `AdminRepository` (docs/multiplayer.md
 * §14.6); Home renders it for admins. `createFakeAdminStore` is the in-memory org it runs on until the store's
 * repositories land (`?admin`).
 */
export { AdminApp, type AdminAppProps, type AdminSection } from "./AdminApp";
export type { AdminStore, AdminTeamsApi } from "./context";
export { createFakeAdminStore, type FakeAdminStore } from "./fake/fakeAdmin";
