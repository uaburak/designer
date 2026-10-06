import { describe, expect, it } from "vitest";
import { place, placeMenu, placeOverTrigger } from "../overlay/position";

const view = { width: 1000, height: 800 };

describe("floating placement", () => {
  it("hangs 6px below, centred", () => {
    expect(place({ left: 100, top: 100, right: 124, bottom: 124 }, { width: 60, height: 24 }, view)).toEqual({ x: 82, y: 130, side: "bottom" });
  });
  it("flips to the other side when there is no room, and stays 8px inside the view", () => {
    const p = place({ left: 0, top: 780, right: 24, bottom: 800 }, { width: 60, height: 24 }, view);
    expect(p.side).toBe("top");
    expect(p.x).toBe(8);
    expect(place({ left: 980, top: 100, right: 1000, bottom: 120 }, { width: 60, height: 24 }, view, "right").side).toBe("left");
  });
  it("aligns to the start or end", () => {
    expect(place({ left: 100, top: 100, right: 200, bottom: 124 }, { width: 60, height: 24 }, view, "bottom", "start").x).toBe(100);
    expect(place({ left: 100, top: 100, right: 200, bottom: 124 }, { width: 60, height: 24 }, view, "bottom", "end").x).toBe(140);
  });
});

describe("menu placement", () => {
  it("opens at the point, moves left and up at the edges", () => {
    expect(placeMenu(100, 100, { width: 200, height: 300 }, view)).toEqual({ x: 100, y: 100 });
    expect(placeMenu(900, 700, { width: 200, height: 300 }, view)).toEqual({ x: 792, y: 492 });
  });
  it("puts a submenu on its item's left when it has no room on the right", () => {
    expect(placeMenu(904, 100, { width: 200, height: 100 }, view, 700)).toEqual({ x: 500, y: 100 });
  });
  it("lays a Select's checked item over its trigger", () => {
    // trigger at y 300 (24 high), checked item 32px into the list (24 high): the list starts 32px above the trigger
    expect(placeOverTrigger({ left: 100, top: 300, right: 188, bottom: 324 }, 32, 24, { width: 120, height: 120 }, view)).toEqual({ x: 80, y: 268 });
    // nothing checked: under the trigger
    expect(placeOverTrigger({ left: 100, top: 300, right: 188, bottom: 324 }, null, 24, { width: 120, height: 120 }, view)).toEqual({ x: 100, y: 328 });
  });
});
