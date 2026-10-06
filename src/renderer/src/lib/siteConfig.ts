/**
 * Site-wide feature flags & configuration.
 * Smooth scroll efektini açmak/kapatmak için bu dosyadaki
 * SMOOTH_SCROLL_ENABLED değerini değiştirmen yeterli.
 */
const siteConfig = {
  /** true  → Lenis smooth scroll aktif
   *  false → Native (anlık) scroll kullanılır */
  SMOOTH_SCROLL_ENABLED: false,
} as const;

export default siteConfig;

/** The site's address: what relative links in its metadata (canonical, Open Graph images, the sitemap) are resolved against. */
export const SITE_URL = "https://burakkoc.net";
