/**
 * The privacy policy and terms of service (docs/multiplayer.md §17): the pages Google's OAuth consent screen links to
 * once the app is in production. Plain and short: what is kept, where, for how long, and how to have it deleted.
 *
 *   GET /privacy · GET /terms
 */
import type { Deps } from "./api";
import { operatorEmails } from "./quota/quota";

const UPDATED = "12 October 2026";

/** The service's public address, as the pages name it (whichever host they were reached at: workers.dev answers too) */
const SITE = "wecra.app";

export function legalPage(path: string, deps: Deps): Response {
  const contact = operatorEmails(deps)[0];
  const mail = `<a href="mailto:${esc(contact)}">${esc(contact)}</a>`;
  const html = path === "/privacy" ? privacy(SITE, mail) : terms(SITE, mail);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Wecra</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:0;padding:32px 16px;color:#1e1e1e;background:#fff}main{max-width:680px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}p,li{margin:0 0 10px}.muted{color:#666;font-size:13px}a{color:#0d70e0}
@media (prefers-color-scheme:dark){body{background:#1e1e1e;color:#eee}.muted{color:#aaa}a{color:#5fa8ff}}</style>
<main>${body}<p class="muted"><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of service</a></p></main></html>`;
}

function privacy(host: string, mail: string): string {
  return page(
    "Privacy policy",
    `<h1>Privacy policy</h1><p class="muted">Wecra (${host}) · last updated ${UPDATED}</p>
<p>Wecra is a design app run by one person, its operator, as a personal project. This page says what the server keeps about you and what happens to it.</p>
<h2>What we keep</h2>
<ul>
<li><b>Your Google account's basics</b>: your name, email address and profile picture, and Google's account id, received when you log in with Google. We ask Google for nothing else (only the <code>openid</code>, <code>email</code> and <code>profile</code> scopes).</li>
<li><b>What you put on the server</b>: files you share or create in an organization (their content, images and thumbnails), comments, developer previews you publish, libraries and fonts you publish, and who you share them with.</li>
<li><b>Your sessions</b>: when and from which device and browser you logged in, and the approximate place Cloudflare derives from your IP address, so you can see and end them in Settings › Security.</li>
<li><b>Usage counts</b>: how much you store and how many uploads, invitations and comments you make, to keep the service within its limits.</li>
</ul>
<p>Files you never share stay on your own computer; the server never sees them.</p>
<h2>Where it is kept</h2>
<p>On Cloudflare (Workers, D1 and Durable Objects), which hosts the server. Organizations that choose the EU data region have their files kept in Cloudflare's EU jurisdiction.</p>
<h2>Who sees it</h2>
<p>The people you share a file, preview or organization with see what you share with them. Anyone with the link sees a developer preview or an embed you publish. The operator can see account details and usage to run the service. We don't sell your data, use it for advertising, or share it with anyone else, except where the law requires it.</p>
<h2>How long</h2>
<p>As long as your account exists, or until you delete the thing itself. Developer previews disappear when they expire.</p>
<h2>Deleting your data</h2>
<p>Delete your account in the app (Settings › Account › Delete account): your account, sessions, tokens, previews, comments and the files you own outside organizations are deleted from the server. Files in an organization belong to the organization and stay with it. You can also ask the operator to delete your data by writing to ${mail}.</p>
<h2>Contact</h2>
<p>${mail}</p>`,
  );
}

function terms(host: string, mail: string): string {
  return page(
    "Terms of service",
    `<h1>Terms of service</h1><p class="muted">Wecra (${host}) · last updated ${UPDATED}</p>
<p>Wecra is a personal, non-commercial project offered free of charge, as is. By logging in you agree to these terms.</p>
<h2>Your content</h2>
<p>What you make and upload stays yours. You give the service only what it needs to keep it and show it to the people you share it with.</p>
<h2>Fair use</h2>
<ul>
<li>Each account has limits on storage, files, uploads, previews, invitations and comments, so the free service keeps working for everyone. The app tells you when you reach one.</li>
<li>Don't upload anything illegal, anything you don't have the right to share, or malware, and don't use the service to harass anyone or to send spam.</li>
<li>Don't try to get around the limits, break the service, or reach other people's data.</li>
</ul>
<p>The operator may suspend or delete accounts that break these terms, and may change the limits or close sign-up at any time.</p>
<h2>No warranty</h2>
<p>The service may be unavailable, lose data or end without notice. Keep your own copies of anything important (your files are always on your own computer too). To the extent the law allows, the operator is not liable for any loss from using it.</p>
<h2>Changes</h2>
<p>These terms may change; the date above says when they last did.</p>
<h2>Contact</h2>
<p>${mail}</p>`,
  );
}
