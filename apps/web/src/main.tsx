import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/orbitron/400.css";
import "@fontsource/orbitron/600.css";
import "@fontsource/rajdhani/300.css";
import "@fontsource/rajdhani/400.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/share-tech-mono/400.css";
import { App } from "./App";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("No se encontró el nodo #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
