// Inject with javascript_tool. Figma's panel text lives in <i18n-text> (display: contents), so text nodes are measured with Ranges.
window.__dump2 = (root) => {
  const R = root.getBoundingClientRect(); const out = [];
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n; const rr = (r) => `${Math.round(r.x - R.x)},${Math.round(r.y - R.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  while ((n = tw.nextNode())) {
    if (n.nodeType === 3) {
      const t = n.textContent.trim(); if (!t) continue;
      const rg = document.createRange(); rg.selectNodeContents(n); const r = rg.getBoundingClientRect(); if (!r.width) continue;
      let p = n.parentElement; while (p && getComputedStyle(p).display === 'contents') p = p.parentElement;
      const cs = getComputedStyle(p); out.push(`${rr(r)} "${t}" ${cs.fontSize}/${cs.fontWeight} ${cs.color}`); continue;
    }
    const el = n; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden') continue;
    const label = el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.getAttribute('placeholder');
    const bg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? ` bg=${cs.backgroundColor}` : '';
    const br = cs.borderRadius !== '0px' ? ` r=${cs.borderRadius}` : '';
    if (el.tagName === 'INPUT') out.push(`${rr(r)} input =${el.value}${label ? ` [${label}]` : ''}${bg}${br}`);
    else if (label) out.push(`${rr(r)} ${el.getAttribute('role') || el.tagName.toLowerCase()} [${label}]${bg}${br}`);
    else if (bg && r.width < 400) out.push(`${rr(r)} ${el.tagName.toLowerCase()}${bg}${br}`);
  }
  return out.join('\n');
};
// Containers
window.__right = () => document.querySelector('[class*="properties_panel--scrollOuterContainer"]');
window.__left = () => { const h = [...document.querySelectorAll('*')].find(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() === 'Pages')); let p = h; while (p && !(p.getBoundingClientRect().height > 700)) p = p.parentElement; return p; };
// Any open menu / popover / dialog: the topmost element with role=menu|dialog|listbox
window.__popups = () => [...document.querySelectorAll('[role=menu],[role=dialog],[role=listbox],[data-testid*=popover],[class*="popover"],[class*="menu--"]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 40; });
window.__cap = async (name, wait = 400) => { await new Promise(r => setTimeout(r, wait)); window.__caps = window.__caps || {}; const pops = __popups(); window.__caps[name] = 'RIGHT\n' + (__right() ? __dump2(__right()) : '') + '\nLEFT\n' + (__left() ? __dump2(__left()) : '') + (pops.length ? '\nPOPUPS\n' + pops.map(p => { const r = p.getBoundingClientRect(); return `@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}\n` + __dump2(p); }).join('\n---\n') : ''); return name + ': ' + window.__caps[name].length; };
