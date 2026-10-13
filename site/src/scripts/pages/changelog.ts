// /changelog: every release from /api/releases, its notes rendered from Markdown.
import { initPage } from "../common";
import { escapeHtml, renderMarkdown } from "../markdown";
import { formatDate, loadReleases, type Release } from "../releases";

initPage();

function releaseHtml(r: Release, newest: boolean): string {
  const id = `v${r.version.replace(/[^\w]+/g, "-")}`;
  const platforms = [r.files.mac && "macOS", r.files.windows && "Windows"].filter(Boolean).join(" and ");
  const notes = r.notes.trim() ? renderMarkdown(r.notes) : "<p>No notes for this release.</p>";
  return `<article class="release" id="${escapeHtml(id)}">
  <header>
    <h2><a href="#${escapeHtml(id)}">Wecra ${escapeHtml(r.version)}</a>${newest ? '<span class="badge">Latest</span>' : ""}</h2>
    <p class="release-meta"><time datetime="${escapeHtml(r.date)}">${escapeHtml(formatDate(r.date))}</time>${platforms ? ` · ${platforms}` : ""}</p>
  </header>
  <div class="notes">${notes}</div>
</article>`;
}

async function render() {
  const box = document.querySelector<HTMLElement>("[data-releases]");
  if (!box) return;
  const releases = await loadReleases();
  box.removeAttribute("aria-busy");
  if (!releases) {
    box.innerHTML = '<p class="state">The releases could not be loaded. Try again in a moment.</p>';
    return;
  }
  if (!releases.length) {
    box.innerHTML = '<p class="state">No releases yet. The first one is on its way.</p>';
    return;
  }
  box.innerHTML = releases.map((r, i) => releaseHtml(r, i === 0)).join("");
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

void render();
