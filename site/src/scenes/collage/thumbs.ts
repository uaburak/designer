// The files' thumbnails on Home: each a small SVG of the file's first frame on the canvas grey, the way the app's
// previews show the top of page one (docs/data.md, previews). Drawn here, as data URLs, so the scene needs no images.

const svg = (body: string, bg = "#f5f5f5") =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 268 168" preserveAspectRatio="xMidYMid slice"><rect width="268" height="168" fill="${bg}"/>${body}</svg>`)}`;

const lines = (x: number, y: number, ws: number[], fill: string, h = 5, gap = 9) => ws.map((w, i) => `<rect x="${x}" y="${y + i * gap}" width="${w}" height="${h}" rx="2.5" fill="${fill}"/>`).join("");

export const THUMBS = {
  launch: svg(
    `<rect x="34" y="22" width="200" height="128" fill="#fff"/>` +
      `<circle cx="47" cy="34" r="4" fill="#ffa629"/>` +
      lines(46, 52, [70, 54], "#1e1e1e", 8, 12) +
      lines(46, 80, [76, 60], "#b3b3b3", 4, 8) +
      `<rect x="46" y="100" width="34" height="11" rx="3" fill="#1e1e1e"/><rect x="84" y="100" width="34" height="11" rx="3" fill="#ededed"/>` +
      `<rect x="146" y="44" width="76" height="70" rx="6" fill="#ffe7c2"/><circle cx="196" cy="58" r="22" fill="#ffc977"/><rect x="170" y="62" width="30" height="13" rx="6.5" fill="#1e1e1e"/>` +
      `<rect x="46" y="124" width="54" height="18" rx="3" fill="#f3f3f3"/><rect x="104" y="124" width="54" height="18" rx="3" fill="#f3f3f3"/><rect x="162" y="124" width="60" height="18" rx="3" fill="#f3f3f3"/>`,
  ),
  mobile: svg(
    [0, 1, 2]
      .map((i) => {
        const x = 50 + i * 60;
        return `<rect x="${x}" y="24" width="48" height="104" rx="7" fill="${i === 1 ? "#1e1e1e" : "#fff"}"/>` + `<rect x="${x + 6}" y="36" width="36" height="28" rx="4" fill="${["#e5f4ff", "#ffa629", "#dcf3e5"][i]}"/>` + lines(x + 6, 72, [30, 22, 26], i === 1 ? "#5e5e5e" : "#d9d9d9", 3.5, 7) + `<rect x="${x + 6}" y="108" width="36" height="10" rx="5" fill="${i === 1 ? "#fff" : "#0d99ff"}"/>`;
      })
      .join(""),
  ),
  system: svg(
    `<rect x="28" y="22" width="212" height="124" fill="#fff"/>` +
      [0, 1, 2, 3]
        .map((i) => `<rect x="${44 + i * 46}" y="40" width="38" height="14" rx="4" fill="${["#9747ff", "#b383ff", "#e4d2ff", "#1e1e1e"][i]}"/>`)
        .join("") +
      [0, 1, 2, 3, 4, 5].map((i) => `<circle cx="${52 + i * 33}" cy="78" r="9" fill="${["#0d99ff", "#14ae5c", "#ffa629", "#f24822", "#9747ff", "#1e1e1e"][i]}"/>`).join("") +
      `<rect x="44" y="102" width="86" height="28" rx="5" fill="none" stroke="#9747ff" stroke-dasharray="3 2"/><rect x="50" y="109" width="34" height="14" rx="4" fill="#9747ff"/><rect x="90" y="109" width="34" height="14" rx="4" fill="#e4d2ff"/>` +
      `<rect x="140" y="102" width="84" height="28" rx="5" fill="#f5f5f5"/>`,
  ),
  landing: svg(
    `<rect x="30" y="20" width="208" height="130" fill="#0b1a33"/>` + lines(46, 42, [120, 92], "#fff", 9, 14) + lines(46, 76, [104, 80], "#7f93b3", 4, 8) + `<rect x="46" y="98" width="44" height="13" rx="6.5" fill="#0d99ff"/>` + `<circle cx="196" cy="70" r="30" fill="#0d99ff" opacity=".35"/><circle cx="206" cy="62" r="16" fill="#7cc4fa"/>`,
  ),
  icons: svg(
    `<rect x="40" y="20" width="188" height="128" fill="#fff"/>` +
      Array.from({ length: 15 }, (_, i) => {
        const x = 58 + (i % 5) * 34;
        const y = 38 + Math.floor(i / 5) * 34;
        const k = i % 3;
        return k === 0 ? `<circle cx="${x + 8}" cy="${y + 8}" r="7" fill="none" stroke="#1e1e1e" stroke-width="2"/>` : k === 1 ? `<rect x="${x + 1}" y="${y + 1}" width="14" height="14" rx="3" fill="none" stroke="#1e1e1e" stroke-width="2"/>` : `<path d="M${x} ${y + 15}L${x + 8} ${y + 1}L${x + 16} ${y + 15}Z" fill="none" stroke="#1e1e1e" stroke-width="2" stroke-linejoin="round"/>`;
      }).join(""),
  ),
  wireframes: svg(
    `<rect x="30" y="22" width="96" height="124" fill="#fff"/><rect x="142" y="22" width="96" height="124" fill="#fff"/>` +
      [30, 142].map((x) => `<rect x="${x + 10}" y="34" width="76" height="34" fill="#e6e6e6"/>` + lines(x + 10, 78, [60, 70, 44], "#d6d6d6", 5, 10) + `<rect x="${x + 10}" y="116" width="36" height="16" fill="#cfcfcf"/>`).join(""),
  ),
  brand: svg(`<rect x="34" y="22" width="200" height="124" fill="#14ae5c"/><circle cx="134" cy="76" r="26" fill="#fff"/><circle cx="134" cy="76" r="12" fill="#14ae5c"/>` + lines(104, 112, [60], "#dcf3e5", 5)),
  pitch: svg(`<rect x="34" y="22" width="200" height="124" fill="#fff"/>` + lines(52, 44, [110, 80], "#1e1e1e", 9, 14) + `<rect x="52" y="86" width="16" height="40" fill="#ffa629"/><rect x="76" y="70" width="16" height="56" fill="#ffa629"/><rect x="100" y="96" width="16" height="30" fill="#ffcd29"/><rect x="124" y="60" width="16" height="66" fill="#f24822"/>`),
  moodboard: svg(`<rect x="34" y="22" width="96" height="60" fill="#ffc7c2"/><rect x="138" y="22" width="96" height="124" fill="#bde3ff"/><rect x="34" y="90" width="96" height="56" fill="#ffe8a3"/>`),
} as const;
