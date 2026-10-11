/** The local image models' worker (docs/ai.md §4). Stub until round 6b. */
import type { AiModelId } from "../../../../shared/ai/types";

export async function runModel(_id: AiModelId, _input: unknown): Promise<unknown> {
  throw new Error("Local models aren't built yet");
}
