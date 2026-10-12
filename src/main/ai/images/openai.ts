import { AiError, classify } from "../oneShot";
import { answerOf, type ImageAnswer, type ImageJob } from "./types";

/**
 * OpenAI Images (docs/ai.md §2.5): `POST /v1/images/generations` for Make an image, `/v1/images/edits` (multipart:
 * `image[]` — the picture, then the reference — `mask` with transparent = change, `prompt`) for Edit, Expand and Erase.
 * The key is the owner's (Settings › AI, in the keychain); the model is the route's, else `gpt-image-1`.
 */

export const OPENAI_IMAGE_MODEL = "gpt-image-1";

/** The API's nearest size for a wanted aspect (it takes these three, or auto). */
export function openAiSize(size?: { width: number; height: number }): string {
  if (!size || !(size.width > 0) || !(size.height > 0)) return "auto";
  const r = size.width / size.height;
  return r > 1.2 ? "1536x1024" : r < 1 / 1.2 ? "1024x1536" : "1024x1024";
}

async function failure(res: Response): Promise<AiError> {
  let message = `OpenAI answered ${res.status}`;
  try {
    const j = (await res.json()) as { error?: { message?: string; code?: string } };
    if (j.error?.message) message = j.error.message;
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return new AiError("signed-out", "The OpenAI key was refused. Check it in Settings › AI.");
  if (res.status === 429) return new AiError("rate-limited", message);
  if (res.status === 400 && /safety|moderation|content policy/i.test(message)) return new AiError("refused", message);
  return classify(message);
}

export async function openAiImage(job: ImageJob, o: { key: string; fetch?: typeof fetch; baseUrl?: string }): Promise<ImageAnswer> {
  const fetchFn = o.fetch ?? fetch;
  const base = (o.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = job.model || OPENAI_IMAGE_MODEL;
  const headers = { Authorization: `Bearer ${o.key}` };
  let res: Response;
  try {
    if (!job.image) {
      res = await fetchFn(`${base}/images/generations`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: job.prompt, n: 1, size: openAiSize(job.size) }),
        signal: job.signal,
      });
    } else {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", job.prompt);
      form.append("n", "1");
      form.append("size", openAiSize(job.size));
      form.append("image[]", new Blob([new Uint8Array(job.image)], { type: "image/png" }), "image.png");
      if (job.reference) form.append("image[]", new Blob([new Uint8Array(job.reference)], { type: "image/png" }), "reference.png");
      if (job.mask) form.append("mask", new Blob([new Uint8Array(job.mask)], { type: "image/png" }), "mask.png");
      res = await fetchFn(`${base}/images/edits`, { method: "POST", headers, body: form, signal: job.signal });
    }
  } catch (err) {
    if (job.signal.aborted) throw job.signal.reason instanceof AiError ? job.signal.reason : new AiError("cancelled", "Cancelled.");
    throw classify(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = body.data?.[0]?.b64_json;
  const answer = b64 ? answerOf(Buffer.from(b64, "base64"), model) : null;
  if (!answer) throw new AiError("bad-output", "OpenAI sent no picture.");
  return answer;
}
