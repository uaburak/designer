import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { shell } from "electron";
import { FIREBASE_CONFIG } from "../shared/firebaseConfig";
import type { GoogleCredential } from "../shared/api";

/**
 * Google sign-in, in the system's browser. Google refuses to sign in inside
 * an app's own web view, and Firebase's popup needs a page on an authorized
 * domain — `localhost` is one. So: a one-off server on this computer serves a
 * small page at http://localhost:<port>; the browser signs in there with
 * Firebase's popup and posts the Google credential back to it (with this
 * sign-in's random `state`); the app signs in to Firebase with it
 * (signInWithCredential). The server answers this one sign-in only, then
 * closes — on its own after ten minutes.
 */

const TIMEOUT_MS = 10 * 60_000;

let current: { cancel: () => void } | null = null;

export function cancelSignIn() {
  current?.cancel();
}

/** Did the browser bring this sign-in's state back (compared in constant time)? */
function sameState(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function signInWithGoogle(): Promise<GoogleCredential> {
  cancelSignIn();
  return new Promise<GoogleCredential>((resolve, reject) => {
    const state = randomBytes(24).toString("hex");
    let done = false;
    const finish = (error: Error | null, credential?: GoogleCredential) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      current = null;
      // The page's last request answered first.
      setTimeout(() => server.close(), 1000);
      if (error) reject(error);
      else resolve(credential!);
    };
    const timer = setTimeout(() => finish(new Error("The sign-in timed out — try again.")), TIMEOUT_MS);
    current = { cancel: () => finish(new Error("cancelled")) };

    const send = (res: ServerResponse, status: number, type: string, body: string) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      res.end(body);
    };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        if (!sameState(url.searchParams.get("state") ?? "", state)) return send(res, 400, "text/plain", "This sign-in link is no longer valid. Start the sign-in again in DesignerV2.");
        return send(res, 200, "text/html; charset=utf-8", page(state));
      }
      if (req.method === "POST" && url.pathname === "/done") {
        try {
          const body = JSON.parse(await readBody(req)) as { state?: string; idToken?: string; accessToken?: string | null };
          if (!body.state || !sameState(body.state, state) || typeof body.idToken !== "string") return send(res, 400, "application/json", '{"ok":false}');
          send(res, 200, "application/json", '{"ok":true}');
          finish(null, { idToken: body.idToken, accessToken: typeof body.accessToken === "string" ? body.accessToken : null });
        } catch {
          send(res, 400, "application/json", '{"ok":false}');
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/failed") {
        try {
          const body = JSON.parse(await readBody(req)) as { state?: string; message?: string };
          if (body.state && sameState(body.state, state)) {
            send(res, 200, "application/json", '{"ok":true}');
            return finish(new Error(typeof body.message === "string" && body.message ? body.message : "The sign-in failed."));
          }
        } catch {
          /* answered below */
        }
        return send(res, 400, "application/json", '{"ok":false}');
      }
      send(res, 404, "text/plain", "Not found");
    });
    server.on("error", (err) => finish(err));
    // Only this computer can reach it.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      void shell.openExternal(`http://localhost:${port}/?state=${state}`).catch((err: Error) => finish(err));
    });
  });
}

/** The browser's page: Firebase's Google popup, then the credential to the app. Firebase from Google's CDN, the app's version. */
function page(state: string) {
  const sdk = `https://www.gstatic.com/firebasejs/${__FIREBASE_VERSION__}`;
  const config = JSON.stringify({ apiKey: FIREBASE_CONFIG.apiKey, authDomain: FIREBASE_CONFIG.authDomain, projectId: FIREBASE_CONFIG.projectId, appId: FIREBASE_CONFIG.appId });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — DesignerV2</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --text: rgba(0,0,0,.9); --muted: rgba(0,0,0,.5); --border: #e6e6e6; --brand: #0d99ff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #2c2c2c; --text: #fff; --muted: rgba(255,255,255,.7); --border: #444; --brand: #0c8ce9; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--text); font: 13px/20px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: 360px; max-width: calc(100vw - 32px); display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; }
  .mark { width: 56px; height: 56px; margin-bottom: 8px; }
  h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--muted); }
  button { margin-top: 12px; height: 40px; width: 100%; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text); font: inherit; font-weight: 550; display: flex; align-items: center; justify-content: center; gap: 10px; cursor: pointer; }
  button:hover { background: rgba(127,127,127,.08); }
  button:disabled { opacity: .5; cursor: default; }
  #status { min-height: 20px; }
  #status.ok { color: #14ae5c; } #status.error { color: #f24822; }
</style>
</head>
<body>
<main>
  <svg class="mark" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0c8ce9"/><stop offset="1" stop-color="#9747ff"/></linearGradient></defs><rect width="48" height="48" rx="12" fill="url(#m)"/><g fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"><path d="M24 11l8.6 12.4-3.6 11H19l-3.6-11z"/><path d="M24 11v10"/><path d="M19 38h10"/></g><circle cx="24" cy="23.2" r="2.2" fill="#fff"/></svg>
  <h1>Sign in to DesignerV2</h1>
  <p>With the Google account that runs burakkoc.net.</p>
  <button id="go" type="button" disabled>
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
    Continue with Google
  </button>
  <p id="status"></p>
</main>
<script type="module">
  const state = ${JSON.stringify(state)};
  const status = document.getElementById("status");
  const go = document.getElementById("go");
  const say = (text, kind) => { status.textContent = text; status.className = kind || ""; };
  const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state, ...body }) });
  try {
    const { initializeApp } = await import("${sdk}/firebase-app.js");
    const { getAuth, GoogleAuthProvider, signInWithPopup, setPersistence, inMemoryPersistence, signOut } = await import("${sdk}/firebase-auth.js");
    const auth = getAuth(initializeApp(${config}));
    // Nothing of the sign-in stays in this browser: the app keeps it.
    await setPersistence(auth, inMemoryPersistence);
    go.disabled = false;
    go.addEventListener("click", async () => {
      go.disabled = true;
      say("Waiting for Google…");
      try {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (!credential || !credential.idToken) throw new Error("Google gave no credential.");
        const res = await post("/done", { idToken: credential.idToken, accessToken: credential.accessToken ?? null });
        if (!res.ok) throw new Error("DesignerV2 didn't take the sign-in — start it again from the app.");
        await signOut(auth);
        say("Signed in. You can close this tab and go back to DesignerV2.", "ok");
        go.hidden = true;
      } catch (err) {
        go.disabled = false;
        const code = err && err.code;
        if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return say("");
        say(code === "auth/popup-blocked" ? "The browser blocked the window — allow pop-ups for this page and try again." : (err && err.message) || String(err), "error");
      }
    });
  } catch (err) {
    say("Couldn't load the sign-in: " + ((err && err.message) || err) + " — check the connection.", "error");
    post("/failed", { message: "Couldn't load the sign-in page's scripts (offline?)." }).catch(() => {});
  }
</script>
</body>
</html>`;
}
