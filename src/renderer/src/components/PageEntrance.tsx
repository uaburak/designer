import { useRef } from "react";
import { ScrollTrigger } from "gsap/ScrollTrigger";

interface PageEntranceProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onAnimationEnd"> {
  children: React.ReactNode;
  /** e.g. `data-project-radius` from projectThemeAttrs */
  "data-project-radius"?: "";
  /** The site's design variables apply inside it (see DesignVariablesStyle) */
  "data-design-scope"?: "";
}

/**
 * PageEntrance wraps pages to provide a premium, smooth zoom-in and fade-in
 * transition from small to large when mounting the route.
 *
 * Animasyon saf CSS (`.page-entrance`, globals.css) — JS state/rAF gerektirmez,
 * bu yüzden arka plan sekmesinde de takılıp kalmaz ve ekstra render tetiklemez.
 * Animasyon bitince `transform` tamamen kalkar; aksi halde transform'lu ata
 * element, içindeki `position: fixed` öğeler için containing block oluşturur ve
 * sabit sidebar/header sayfayla birlikte kayar.
 */
export default function PageEntrance({ children, className = "", ...rest }: PageEntranceProps) {
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={ref}
      {...rest}
      className={`page-entrance ${className}`}
      onAnimationEnd={(e) => {
        // Sadece kendi animasyonumuz (çocuklardan bubble edenler değil)
        if (e.target !== ref.current) return;
        // Ölçümler scale(0.92) altındayken alınmış olabilir → tetikleyicileri tazele.
        ScrollTrigger.refresh();
      }}
    >
      {children}
    </div>
  );
}
