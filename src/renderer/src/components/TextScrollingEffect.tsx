import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(ScrollTrigger, SplitText);

/**
 * TextScrollingEffect - Scroll-based line reveal animation
 *
 * Wraps content and applies GSAP SplitText line animation.
 * Lines slide up from below with opacity fade as user scrolls.
 *
 * @param children - Content to animate (can contain p, h1-h6, li, blockquote, etc.)
 * @param className - Optional additional classes
 */
export default function TextScrollingEffect({
  children,
  className = "",
  disabled = false,
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (disabled || !containerRef.current) return;

      // Select all text elements within the container
      const textElements = containerRef.current.querySelectorAll(
        "p, h1, h2, h3, h4, h5, h6, li, blockquote"
      );

      const splitInstances: { revert: () => void }[] = [];

      textElements.forEach((text) => {
        const split = SplitText.create(text, {
          type: "lines",
          linesClass: "line-reveal",
          autoSplit: true,
          onSplit: (instance) => {
            return gsap.from(instance.lines, {
              yPercent: 120,
              opacity: 0,
              stagger: 0.05,
              ease: "power2.out",
              scrollTrigger: {
                trigger: text,
                start: "top 95%",
                end: "top 40%",
                scrub: 1,
              },
            });
          },
        });
        splitInstances.push(split);
      });

      return () => {
        splitInstances.forEach((split) => {
          try {
            split.revert();
          } catch {
            /* already gone */
          }
        });
      };
    },
    { scope: containerRef, dependencies: [disabled, children] }
  );

  // `.line-reveal` stili globals.css'te tanımlı (her instance için <style> basmamak adına).
  return (
    <div ref={containerRef} className={className}>
      {children}
    </div>
  );
}
