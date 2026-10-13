// /download: both platforms, each with the newest file's version, size and date; this visitor's OS first.
import { initPage, offerLine } from "../common";
import { detectPlatform, loadReleases, offerFor, type Platform } from "../releases";

initPage();

async function fill() {
  const mine = detectPlatform(navigator as Navigator & { userAgentData?: { platform?: string } });
  if (mine) {
    const card = document.querySelector<HTMLElement>(`[data-platform-card="${mine}"]`);
    card?.setAttribute("data-mine", "");
    card?.parentElement?.prepend(card);
  }
  const releases = await loadReleases();
  for (const os of ["mac", "windows"] as Platform[]) {
    const meta = document.querySelector<HTMLElement>(`[data-offer="${os}"]`);
    const button = document.querySelector<HTMLAnchorElement>(`[data-get="${os}"]`);
    const offer = releases ? offerFor(releases, os) : null;
    if (meta) meta.textContent = offer ? offerLine(offer) : "Coming soon";
    if (button && !offer) {
      button.removeAttribute("href");
      button.setAttribute("aria-disabled", "true");
      button.tabIndex = -1;
      button.classList.replace("btn-primary", "btn-secondary");
    } else if (button && mine && os !== mine) button.classList.replace("btn-primary", "btn-secondary");
  }
}

void fill();
