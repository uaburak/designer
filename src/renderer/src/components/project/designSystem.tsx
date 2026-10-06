import type { ReactNode } from "react";
import type { DesignVariable, TextStyle } from "@/types/design";
import { DesignVariablesContext, useDesignVariables, variablesCss } from "./designVariables";
import { TextStylesContext, textStylesCss, useTextStyles } from "./textStyles";
import { MOTION_CSS } from "./interactions";

/**
 * The site's design system — its variables and text styles — for
 * everything rendered inside: the project page, the editor's canvas.
 */
export interface SiteDesign {
  variables: DesignVariable[];
  textStyles: TextStyle[];
}

/** Takes all of them — the starting ones included. */
export function DesignSystemProvider({ variables, textStyles, children }: SiteDesign & { children: ReactNode }) {
  return (
    <DesignVariablesContext.Provider value={variables}>
      <TextStylesContext.Provider value={textStyles}>{children}</TextStylesContext.Provider>
    </DesignVariablesContext.Provider>
  );
}

/** Puts the variables, the text styles and the prototypes' animations on the page: render it inside the element carrying `data-design-scope`. */
export function DesignSystemStyle() {
  const variables = useDesignVariables();
  const textStyles = useTextStyles();
  return <style>{`${variablesCss(variables)}\n${textStylesCss(textStyles, variables)}\n${MOTION_CSS}`}</style>;
}
