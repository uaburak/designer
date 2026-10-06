// The engine playground on its own (`npm run engine:dev`): no shell, no Firebase.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import Playground from "../Playground";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Playground />
  </StrictMode>
);
