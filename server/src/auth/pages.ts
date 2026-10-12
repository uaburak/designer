/**
 * The Worker's own sign-in pages (docs/multiplayer.md §15.4, §15.3): Figma's login page ("Log in to DesignerV2",
 * Continue with Google, Use single sign-on), the SSO email step, the IdP-initiated bounce ("Continue to DesignerV2"),
 * "Log in to DesignerV2 from the app", and the SSO failure page. Plain HTML served by the Worker in a browser — not
 * the app's chrome (no design-system tokens there); every value interpolated is escaped.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const STYLE = `body{font:13px/1.45 Inter,-apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f5f5;color:#1e1e1e}
main{width:320px;padding:32px;background:#fff;border-radius:13px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:20px;font-weight:600;margin:0 0 20px;text-align:center}p{margin:0 0 16px;color:#5e5e5e}
.btn{display:block;box-sizing:border-box;width:100%;height:40px;line-height:38px;border-radius:6px;border:1px solid #d9d9d9;background:#fff;color:#1e1e1e;font:inherit;font-weight:500;text-align:center;text-decoration:none;cursor:pointer}
.primary{background:#0d99ff;border-color:#0d99ff;color:#fff}.hr{display:flex;align-items:center;gap:8px;margin:16px 0;color:#8c8c8c}.hr:before,.hr:after{content:"";flex:1;border-top:1px solid #e6e6e6}
label{display:block;font-weight:500;margin:0 0 6px}input{box-sizing:border-box;width:100%;height:40px;padding:0 12px;border:1px solid #d9d9d9;border-radius:6px;font:inherit;margin:0 0 12px}
.err{color:#f24822;margin:0 0 12px}.muted{color:#8c8c8c;font-size:12px;text-align:center;margin:16px 0 0}`;

export function html(status: number, title: string, body: string): Response {
  const doc = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><style>${STYLE}</style><body><main>${body}</main></body></html>`;
  return new Response(doc, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });
}

/** `GET /auth/login`: Figma's login page. `st` is the signed app state the next step carries. */
export function loginPage(st: string, opts: { sso?: boolean; error?: string; email?: string } = {}): Response {
  const google = `/auth/login?st=${encodeURIComponent(st)}&method=google`;
  if (opts.sso)
    return html(
      opts.error ? 404 : 200,
      "Log in with SSO",
      `<h1>Log in with SSO</h1>${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
<form method="post" action="/auth/sso"><input type="hidden" name="st" value="${esc(st)}"><label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus value="${esc(opts.email ?? "")}"><button class="btn primary" type="submit">Log in</button></form>
<p class="muted"><a href="/auth/login?st=${encodeURIComponent(st)}">Back</a></p>`,
    );
  return html(
    200,
    "Log in to DesignerV2",
    `<h1>Log in to DesignerV2</h1><a class="btn" href="${esc(google)}">Continue with Google</a><div class="hr">or</div>
<a class="btn" href="/auth/login?st=${encodeURIComponent(st)}&amp;method=sso">Use single sign-on</a>`,
  );
}

/** An IdP-initiated sign-in (decision 3): one click back into a normal SP-initiated flow from the app */
export function bouncePage(appUrl: string, webUrl: string | null): Response {
  return html(
    200,
    "Continue to DesignerV2",
    `<h1>Continue to DesignerV2</h1><p>You signed in with your identity provider. Continue in the app to finish logging in.</p>
<a class="btn primary" href="${esc(appUrl)}">Continue to DesignerV2</a>${webUrl ? `<p class="muted"><a href="${esc(webUrl)}">Continue in the browser</a></p>` : ""}`,
  );
}

/** `GET /saml/:tenantId/start` without the app's state (Figma's start URL typed into a browser) */
export function fromAppPage(appUrl: string, webUrl: string | null): Response {
  return html(
    200,
    "Log in to DesignerV2",
    `<h1>Log in to DesignerV2</h1><p>Log in from the DesignerV2 app to use single sign-on.</p><a class="btn primary" href="${esc(appUrl)}">Open DesignerV2</a>${
      webUrl ? `<p class="muted"><a href="${esc(webUrl)}">Use DesignerV2 in the browser</a></p>` : ""
    }`,
  );
}

/** Any refusal of the ACS (the reason only in the log line) */
export const ssoFailedPage = (text = "Single sign-on didn't work. Try again from DesignerV2.") => html(403, "Single sign-on didn't work", `<h1>Single sign-on didn't work</h1><p>${esc(text)}</p>`);

export const messagePage = (status: number, title: string, text: string) => html(status, title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);

/**
 * `GET|POST /auth/2fa` (docs/governance.md §2.4): the second step of a sign-in once two-factor authentication is on.
 * `mt` is the signed challenge; a recovery code is accepted in the same field.
 */
export function twoFactorPage(mt: string, error?: string, status = 200): Response {
  return html(
    status,
    "Two-factor authentication",
    `<h1>Two-factor authentication</h1>${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/auth/2fa"><input type="hidden" name="mt" value="${esc(mt)}"><label for="code">Enter the 6-digit code from your authenticator app</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="20" required autofocus><button class="btn primary" type="submit">Verify</button></form>
<p class="muted">Lost your device? Enter one of your recovery codes instead.</p>`,
  );
}
