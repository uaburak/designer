/**
 * The usage index's shape (`npm run ds:usages` → usages.generated.json, read by the Gallery's Developer page: each ds
 * component's distinct looks and the hand-made controls that look like it). The scanner is tools/ds-usages/scan.ts.
 */

/** Where a usage is: a path from the repository's root and its 1-based line. */
export interface UsageLoc {
  file: string;
  line: number;
}

/** A sample prop's literal value, as written in the source. */
export type SampleValue = string | number | boolean;

/** One distinct combination of a ds component's visual props. */
export interface DsVariant {
  /** The visual props as shown: a literal, "a | b" for a choice of literals, "dynamic", or "✓" (given: a text or icon) */
  props: Record<string, string>;
  /** The literal props of the first usage, to render the sample with */
  sample: Record<string, SampleValue>;
  /** The first literal text it carries (children or label), for the sample */
  text?: string;
  count: number;
  locs: UsageLoc[];
}

/**
 * One visually distinct look of a ds component: its usages collapsed by the props that change how it looks (variant,
 * tone, size, an icon or prefix given, disabled, width style …); text, handlers, data and run-time props left out.
 */
export interface DsLook {
  /** The appearance props: a literal ("large"), "fixed" / "hug" for a width, "✓" for an icon, prefix, suffix or unit given, "dynamic" for a variant or tone chosen at run time */
  props: Record<string, string>;
  /** The literal props of its most used usage, to render the sample with */
  sample: Record<string, SampleValue>;
  text?: string;
  count: number;
  /** How many distinct prop combinations (variants) it collapses */
  variants: number;
  locs: UsageLoc[];
}

export interface DsComponentUsage {
  name: string;
  count: number;
  /** In how many files */
  files: number;
  /** Most used first */
  looks: DsLook[];
}

/** A hand-made control: one tag styled by one CSS module class (or none). */
export interface CustomControl {
  /** button, input, select, textarea, a, or `div[role=button]` */
  tag: string;
  /** input's `type`, when literal */
  type?: string;
  role?: string;
  /** The CSS module it takes its class from (a repository path), null: a literal class or none */
  cssFile: string | null;
  /** The module class (first one when several), or the literal class string */
  className: string | null;
  /** Other module classes added beside it (conditionally or not) */
  extraClasses: string[];
  hasText: boolean;
  hasIcon: boolean;
  /** A sample text and icon name from a usage */
  text?: string;
  icon?: string;
  count: number;
  locs: UsageLoc[];
  /** Its look depends on where it sits (a parent's selector, absolute position, hidden until hover …) */
  needsContext?: string;
  /** The ds component it looks like, and why */
  similarTo?: string;
  similarWhy?: string;
  /** The class's own box (height, width, padding, radius), resolved to px where a token says */
  box?: Record<string, string>;
  /** The `similarTo` component's props that would replace it (variant, size, icon …) */
  suggest?: Record<string, SampleValue>;
  /** The index in that component's `looks` of the look `suggest` already is in the app, if any */
  lookIndex?: number;
}

export interface UsageIndex {
  /** .tsx files scanned */
  files: number;
  ds: DsComponentUsage[];
  custom: CustomControl[];
}
