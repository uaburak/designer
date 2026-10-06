import { Icon, ICON_NAMES } from "../icons/Icon";
import { Comp, Section } from "./parts";
import styles from "./Gallery.module.css";

/** Every registry icon at its box size, in the primary and secondary icon tones. */
export function IconsSection() {
  return (
    <Section id="icons" title={`Icons (${ICON_NAMES.length})`}>
      {(["icon", "icon-secondary"] as const).map((tone) => (
        <Comp key={tone} name={`Icons in --figma-color-${tone}`}>
          <div className={styles.icons} style={{ ["--tone" as string]: `var(--figma-color-${tone})` }}>
            {ICON_NAMES.map((n) => (
              <div key={n} className={styles.iconCell} style={{ color: `var(--figma-color-${tone})` }} data-gallery-id={`Icon/${n}/${tone}`}>
                <Icon name={n} />
                <span className={styles.iconName}>{n}</span>
              </div>
            ))}
          </div>
        </Comp>
      ))}
    </Section>
  );
}
