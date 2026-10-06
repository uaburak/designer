import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/**
 * ScrollReveal - Scrubbed scroll-based reveal animation
 *
 * The animation progress is directly tied to scroll position:
 * scroll halfway → animation plays halfway.
 *
 * @param children - Content to animate
 * @param className - Optional additional classes
 */
export default function ScrollReveal({
  children,
  className = "",
  disabled = false,
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (disabled || !ref.current) return;

      gsap.from(ref.current, {
        opacity: 0,
        y: 48,
        scale: 0.97,
        ease: "power2.out",
        scrollTrigger: {
          trigger: ref.current,
          start: "top 90%",   // element viewport'a %10 girince başla
          end: "top 40%",     // element %60'a gelince bitsin
          scrub: 1.2,         // scroll ile doğrudan bağlantılı (hafif lag)
        },
      });
    },
    { scope: ref, dependencies: [disabled] }
  );

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
