import { Fragment, ReactNode } from "react";

/**
 * Minimal inline formatting for project copy:
 *   **kalın**           → <strong>
 *   [etiket](https://…) → <a>
 *
 * Anything else renders as plain text, so existing content is unaffected.
 * Only http(s), mailto and site-relative links are rendered as anchors;
 * other schemes (e.g. javascript:) fall back to their label.
 */

const TOKEN = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

const LINK_CLASS = "font-normal text-[var(--text-title)] underline decoration-[var(--project-accent,var(--border-hover))] underline-offset-4 transition-colors duration-200 hover:decoration-[var(--project-accent,var(--text-title))]";

/** A link to follow: the web's (http, https), an email — or a path of the site's own ("/cv"; not "//elsewhere" nor "/\\elsewhere", which leave it). */
export function isSafeHref(href: string) {
  return /^(https?:\/\/|mailto:|\/(?![/\\]))/i.test(href.trim());
}

/** Links drawn as links (`links`, the default) — or only as their look (a link inside another, the editor's canvas): no anchor to follow. */
export function renderRichText(text: string, { links = true }: { links?: boolean } = {}): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(<Fragment key={key++}>{text.slice(last, start)}</Fragment>);

    const [, bold, label, href] = match;
    if (bold !== undefined) {
      nodes.push(
        <strong key={key++} className="font-medium text-[var(--text-title)]">
          {bold}
        </strong>
      );
    } else if (isSafeHref(href) && !links) {
      nodes.push(
        <span key={key++} className={LINK_CLASS}>
          {label}
        </span>
      );
    } else if (isSafeHref(href)) {
      const external = /^https?:\/\//i.test(href);
      nodes.push(
        <a
          key={key++}
          href={href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className={LINK_CLASS}
        >
          {label}
        </a>
      );
    } else {
      nodes.push(<Fragment key={key++}>{label}</Fragment>);
    }
    last = start + match[0].length;
  }

  if (last < text.length) nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return nodes;
}

