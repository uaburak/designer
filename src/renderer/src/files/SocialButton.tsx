import { Button } from "@/ds";
import { t as tr, useT } from "@/i18n";

/**
 * Home's Social button, between Developer and Design (the owner's 2026-10-24 ask): a new Social file — Figma's Buzz
 * file, its own kind of file that opens in Social (docs/social.md §18).
 */
export function SocialButton({ onClick }: { onClick: () => void }) {
  useT();
  return (
    <Button variant="tinted" size="large" icon="24.social" tooltip={tr("New Social file")} onClick={onClick} data-home-social="">
      {tr("Social")}
    </Button>
  );
}

/** A file card's kind badge: "Social" on a Social file; a Design file carries none (Figma's Home shows no kind on them). */
export const kindBadge = (editorType: string | undefined): string | undefined => (editorType === "buzz" ? tr("Social") : undefined);
