/**
 * `?admin`: the Admin location on the fake organization, in a browser or a view (one line in main.tsx:
 * `if (params.has("admin")) return lazy(() => import("@/admin/AdminRoute"));`).
 */
import { useState } from "react";
import { ToastHost, TooltipManager } from "@/ds";
import { AdminApp } from "./AdminApp";
import { createFakeAdminStore } from "./fake/fakeAdmin";

export default function AdminRoute() {
  const [fake] = useState(() => createFakeAdminStore({ latency: 60, autoDns: true }));
  return (
    <div style={{ height: "100vh" }}>
      <AdminApp orgId={fake.state.orgId} store={fake} fonts={fake.fonts} onTestSso={fake.testSso} onBack={() => history.back()} />
      <TooltipManager />
      <ToastHost />
    </div>
  );
}
