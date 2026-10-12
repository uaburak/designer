/**
 * A development knob: `DESIGNER_FAKE_LATENCY_MS=<ms>` delays every request the store sends to the server by that
 * much, as a round trip to the Worker and D1 from far away does (300–1000 ms from Turkey to D1 in Frankfurt) —
 * `wrangler dev` with a local D1 answers in a few milliseconds and hides what Home feels like live. Unset, 0 or not a
 * number: requests go as they are (capped at 10 s).
 */
export function withFakeLatency(fetch: typeof globalThis.fetch, ms: unknown): typeof globalThis.fetch {
  const delay = typeof ms === "string" || typeof ms === "number" ? Math.min(Math.floor(Number(ms)), 10_000) : 0;
  if (!Number.isFinite(delay) || delay <= 0) return fetch;
  return async (...args: Parameters<typeof globalThis.fetch>) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return fetch(...args);
  };
}
