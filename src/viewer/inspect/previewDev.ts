/**
 * The developer preview viewer's Dev Mode data (docs/editor.md D-1, D-3): the dev resources and Code Connect mappings
 * the preview was made with (`manifest.devMode`), read-only. Templates run in the plugin VM, loaded the first time a
 * snippet needs it.
 */
import type { PreviewDevData } from "@shared/preview/format";
import type { DevData } from "../context";
import type { SandboxFactory } from "./codeConnect";

const sandbox: SandboxFactory = async (opts) => (await import("@/editor/plugins")).createSandbox(opts);

export function previewDevData(data: PreviewDevData | undefined): DevData | undefined {
  if (!data) return undefined;
  return {
    fileKey: data.fileKey,
    canEdit: false,
    devResources: async (fileKey, nodeIds) => data.devResources.filter((r) => r.fileKey === fileKey && nodeIds.includes(r.nodeId)),
    codeConnect: { fileKey: data.fileKey, mappings: async (fileKey) => data.codeConnect.filter((m) => m.fileKey === fileKey), sandbox },
    watch: () => () => {},
  };
}
