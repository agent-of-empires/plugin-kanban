import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { type BridgeContext, type BridgeTheme, connectBridge } from "./bridge";
import "./board.css";

const root = createRoot(document.getElementById("root")!);
const render = (context: BridgeContext | null) =>
  root.render(
    <StrictMode>
      <App bridge={bridge} context={context} />
    </StrictMode>,
  );

// Variables from the previous theme, removed when a new theme omits them.
let applied: string[] = [];
function applyTheme(theme: BridgeTheme) {
  const style = document.documentElement.style;
  style.colorScheme = theme.appearance;
  for (const name of applied) if (!(name in theme.cssVars)) style.removeProperty(name);
  for (const [name, value] of Object.entries(theme.cssVars)) style.setProperty(name, String(value));
  applied = Object.keys(theme.cssVars);
}

// Connected here rather than in an effect: the dashboard accepts one `ready`
// per frame, and StrictMode runs effects twice.
const bridge = connectBridge(window.parent, location.hash.slice(1), { onContext: render, onTheme: applyTheme });
render(null);
