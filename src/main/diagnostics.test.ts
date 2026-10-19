// Help › Troubleshooting › Save Debug Info… (atlas 21 §7): what the file holds — and that it names no file.
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getName: () => "Wecra",
    getVersion: () => "1.2.3",
    getLocale: () => "en-US",
    getPath: () => "/tmp",
    getGPUInfo: async () => ({ gpuDevice: [{ vendorId: 1 }] }),
    getGPUFeatureStatus: () => ({ webgl2: "enabled" }),
    getAppMetrics: () => [{ type: "Browser", pid: 1, memory: { workingSetSize: 1000, peakWorkingSetSize: 2000 }, cpu: { percentCPUUsage: 1 } }],
  },
  contentTracing: {},
  dialog: {},
  session: {},
}));
vi.mock("./session", () => ({ readSettings: () => ({ theme: "system", zoomStop: 110, shortcuts: { bindings: {} } }) }));
vi.mock("./troubleshooting", () => ({ graphicsBackend: () => "default", hardwareAccelerationDisabled: () => false }));
vi.mock("./window", () => ({
  controllers: new Map([["main", { tabs: { state: { tabs: [{ kind: "file", status: "ready", title: "Secret plans" }, { kind: "file", status: "discarded", title: "Other" }], closed: [{ title: "Closed one" }] } } }]]),
}));
const { debugInfo } = await import("./diagnostics");

describe("Save Debug Info", () => {
  it("holds the app, the system, the GPU, the processes and the tabs counted — no file's name", async () => {
    const info = await debugInfo();
    expect(info).toMatchObject({ app: { name: "Wecra", version: "1.2.3" }, graphics: { backend: "default" }, settings: { theme: "system", zoomStop: 110 } });
    expect(info.windows).toEqual([{ tabs: 2, closed: 1, byKindAndState: { "file:ready": 1, "file:discarded": 1 } }]);
    const text = JSON.stringify(info);
    expect(text).not.toContain("Secret plans");
    expect(text).not.toContain("Closed one");
    expect(text).not.toContain("shortcuts");
  });
});
