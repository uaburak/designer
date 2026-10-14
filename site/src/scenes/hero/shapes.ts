// The poster's shapes (generated with the poster's markup in index.html: keep them in step). Geometry in local units
// (≈100 across), drawn at `size` px per unit on a 788 px card; homes are fractions of the card, landscape and portrait.
export type ShapeKind = "drag" | "pen" | "curve";
export interface ShapeDef { id: string; name: string; icon: "16.vector" | "16.ellipse" | "16.star" | "16.rectangle"; kind: ShapeKind; size: number; r: number; L: [number, number]; P: [number, number]; pts?: [number, number][]; box: [number, number, number, number] }
export const SHAPES: ShapeDef[] = [
  {"id": "pent", "name": "Pentagon", "icon": "16.vector", "kind": "pen", "size": 1.25, "r": 48, "L": [0.7, 0.3], "P": [0.3, 0.14], "box": [-47.6, -50.0, 95.2, 90.5], "pts": [[0.0, -50.0], [47.6, -15.5], [29.4, 40.5], [-29.4, 40.5], [-47.6, -15.5]]},
  {"id": "circ", "name": "Ellipse", "icon": "16.ellipse", "kind": "drag", "size": 1.05, "r": 50, "L": [0.86, 0.62], "P": [0.76, 0.3], "box": [-50, -50, 100, 100]},
  {"id": "star", "name": "Star", "icon": "16.star", "kind": "drag", "size": 0.95, "r": 42, "L": [0.6, 0.7], "P": [0.26, 0.4], "box": [-47.6, -50.0, 95.2, 90.5], "pts": [[0.0, -50.0], [12.9, -17.8], [47.6, -15.5], [20.9, 6.8], [29.4, 40.5], [0.0, 22.0], [-29.4, 40.5], [-20.9, 6.8], [-47.6, -15.5], [-12.9, -17.8]]},
  {"id": "wave", "name": "Wave", "icon": "16.vector", "kind": "curve", "size": 0.95, "r": 40, "L": [0.76, 0.86], "P": [0.55, 0.47], "box": [-100, -40, 200, 80]},
  {"id": "rsq", "name": "Rectangle", "icon": "16.rectangle", "kind": "drag", "size": 0.8, "r": 45, "L": [0.9, 0.24], "P": [0.8, 0.08], "box": [-45, -45, 90, 90]},
  {"id": "tri", "name": "Triangle", "icon": "16.vector", "kind": "pen", "size": 0.9, "r": 40, "L": [0.74, 0.55], "P": [0.52, 0.24], "box": [-48, -50, 96, 88], "pts": [[0, -50], [48, 38], [-48, 38]]},
  {"id": "pill", "name": "Pill", "icon": "16.rectangle", "kind": "drag", "size": 0.85, "r": 40, "L": [0.58, 0.12], "P": [0.5, 0.04], "box": [-70, -26, 140, 52]},
  {"id": "ring", "name": "Ring", "icon": "16.ellipse", "kind": "drag", "size": 0.9, "r": 50, "L": [0.95, 0.44], "P": [0.86, 0.47], "box": [-50, -50, 100, 100]},
  {"id": "dot", "name": "Ellipse 2", "icon": "16.ellipse", "kind": "drag", "size": 0.5, "r": 50, "L": [0.5, 0.3], "P": [0.12, 0.3], "box": [-50, -50, 100, 100]},
  {"id": "squig", "name": "Squiggle", "icon": "16.vector", "kind": "curve", "size": 0.8, "r": 36, "L": [0.4, 0.16], "P": [0.7, 0.18], "box": [-80, -30, 160, 60]},
  {"id": "dia", "name": "Diamond", "icon": "16.vector", "kind": "pen", "size": 0.7, "r": 38, "L": [0.8, 0.08], "P": [0.1, 0.08], "box": [-40, -50, 80, 100], "pts": [[0, -50], [40, 0], [0, 50], [-40, 0]]},
];
