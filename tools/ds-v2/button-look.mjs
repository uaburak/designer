// The Button's colours per Variant × State (Color tokens): shared by its build (step 6) and its fixes.
export function look({ Variant: v, State: st }) {
  const off = st === "Disabled";
  const press = st === "Pressed" || st === "Selected";
  const hover = st === "Hover";
  switch (v) {
    case "Primary":
      return off ? { bg: "bg/disabled", fg: "text/oncolor", icon: "icon/oncolor" } : { bg: hover || press ? "bg/brand-hover" : "bg/brand", fg: press ? "text/onbrand-secondary" : "text/onbrand", icon: "icon/onbrand" };
    case "Destructive":
      return off ? { bg: "bg/disabled", fg: "text/oncolor", icon: "icon/oncolor" } : { bg: hover || press ? "bg/danger-hover" : "bg/danger", fg: "text/oncolor", icon: "icon/oncolor" };
    case "Secondary":
      if (off) return { stroke: "border/default", fg: "text/disabled", icon: "icon/disabled" };
      if (st === "Selected") return { bg: "bg/selected", stroke: "border/default", fg: "text/brand", icon: "icon/brand" };
      return { bg: hover ? "bg/hover" : press ? "bg/transparent-pressed" : null, stroke: "border/default", fg: "text/default", icon: "icon/default" };
    case "Destructive secondary":
      if (off) return { stroke: "border/default", fg: "text/disabled", icon: "icon/disabled" };
      return { bg: hover || press ? "bg/danger-tertiary" : null, stroke: press ? "border/danger-strong" : "border/danger", fg: "text/danger", icon: "icon/danger" };
    case "Ghost":
      if (off) return { fg: "text/disabled", icon: "icon/disabled" };
      if (st === "Selected") return { bg: "bg/selected", fg: "text/brand", icon: "icon/brand" };
      return { bg: hover ? "bg/hover" : press ? "bg/transparent-pressed" : null, fg: "text/default", icon: "icon/default" };
  }
  throw new Error(v);
}
