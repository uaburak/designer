import { AiError, classify } from "../oneShot";
import { answerOf, ASPECT_RATIOS, ratioOf, type ImageAnswer, type ImageJob } from "./types";

/**
 * The Gemini API (docs/ai.md §2.5): `models/{model}:generateContent` with the prompt and the pictures as `inlineData`
 * parts, `responseModalities: ["TEXT", "IMAGE"]`; the answer's first inlineData part is the picture. Gemini takes no
 * mask: Expand's padded picture and Erase's mask go as pictures the prompt explains. The key is the owner's; the model
 * is the route's, else `gemini-2.5-flash-image`.
 *
 * Studio (docs/studio.md §5.3): the references follow the text in the prompt's order, each after a short "Image n:
 * role" part; the picture to edit (Fix label) comes last and the text says so. `imageConfig.aspectRatio` is the
 * request's (else the nearest to the size); the Gemini 3 image models (Nano Banana Pro, Nano Banana 2) are asked for
 * "2K" (`imageConfig.imageSize`, their default is 1K).
 */

export const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

/** Google's model ids (ai.google.dev/gemini-api/docs/models, checked 2026-10-13): the models the routes offer. */
export const NANO_BANANA_PRO = "gemini-3-pro-image";
export const NANO_BANANA_2 = "gemini-3.1-flash-image";
export const NANO_BANANA = "gemini-2.5-flash-image";

/** The models that take `imageSize` (1K / 2K / 4K): Gemini 3 Pro Image and 3.1 Flash Image (not Flash Lite, 1K only). */
export const takesImageSize = (model: string) => /^(gemini-3-pro-image|gemini-3\.1-flash-image|gemini-nano-banana)/.test(model);

export const aspectOf = (s?: { width: number; height: number }) => {
  if (!s || !(s.width > 0) || !(s.height > 0)) return undefined;
  const r = s.width / s.height;
  return ASPECT_RATIOS.reduce((a, b) => (Math.abs(Math.log(ratioOf(b) / r)) < Math.abs(Math.log(ratioOf(a) / r)) ? b : a));
};

export async function geminiImage(job: ImageJob, o: { key: string; fetch?: typeof fetch; baseUrl?: string }): Promise<ImageAnswer> {
  const fetchFn = o.fetch ?? fetch;
  const base = (o.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const model = job.model || GEMINI_IMAGE_MODEL;
  const parts: Record<string, unknown>[] = [];
  let text = job.prompt;
  const refs = job.references ?? [];
  if (refs.length) {
    if (job.image) text += `\nThe last picture, after the ${refs.length === 1 ? "reference" : `${refs.length} references`}, is the picture to edit.`;
    parts.push({ text });
    refs.forEach((r, i) => parts.push({ text: `Image ${i + 1}${r.role ? `: ${r.role}` : ""}` }, { inlineData: { mimeType: r.mime, data: r.data.toString("base64") } }));
    if (job.image) parts.push({ inlineData: { mimeType: "image/png", data: job.image.toString("base64") } });
  } else {
    if (job.mask) text += "\nThe second picture is a mask: change only where it is transparent.";
    if (job.reference) text += `\nThe ${job.mask ? "third" : job.image ? "second" : "first"} picture is a reference for the style and content.`;
    parts.push({ text });
    for (const img of [job.image, job.mask, job.reference]) if (img) parts.push({ inlineData: { mimeType: "image/png", data: img.toString("base64") } });
  }
  const aspect = job.aspectRatio ?? aspectOf(job.size);
  const imageConfig = { ...(aspect ? { aspectRatio: aspect } : {}), ...(takesImageSize(model) ? { imageSize: "2K" } : {}) };
  let res: Response;
  try {
    res = await fetchFn(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": o.key },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) } }),
      signal: job.signal,
    });
  } catch (err) {
    if (job.signal.aborted) throw job.signal.reason instanceof AiError ? job.signal.reason : new AiError("cancelled", "Cancelled.");
    throw classify(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    let message = `Gemini answered ${res.status}`;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 || res.status === 403) throw new AiError("signed-out", "The Gemini key was refused. Check it in Settings › AI.");
    throw classify(message);
  }
  const body = (await res.json()) as { candidates?: { finishReason?: string; content?: { parts?: { inlineData?: { data?: string; mimeType?: string }; text?: string }[] } }[]; promptFeedback?: { blockReason?: string } };
  if (body.promptFeedback?.blockReason) throw new AiError("refused", `Gemini refused the request (${body.promptFeedback.blockReason}).`);
  const out = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  const answer = out?.inlineData?.data ? answerOf(Buffer.from(out.inlineData.data, "base64"), model) : null;
  if (!answer) {
    const said = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join(" ").trim();
    const reason = body.candidates?.[0]?.finishReason;
    throw new AiError(reason === "SAFETY" || reason === "PROHIBITED_CONTENT" ? "refused" : "bad-output", said ? `Gemini sent no picture: ${said.slice(0, 300)}` : "Gemini sent no picture.");
  }
  return answer;
}
