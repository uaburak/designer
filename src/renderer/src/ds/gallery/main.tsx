import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Gallery from "../Gallery";

/** A standalone entry for the Gallery (gallery.html, or a scratch page): `<div id="root">`. */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>
);
