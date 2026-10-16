import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { type BridgeContext, type BridgeTheme, connectBridge } from "./bridge";
import "./board.css";
import mono400 from "@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2?inline";
import sans400 from "@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff2?inline";
import sans500 from "@fontsource/geist-sans/files/geist-sans-latin-500-normal.woff2?inline";
import sans600 from "@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff2?inline";

const root = createRoot(document.getElementById("root")!);
let context: BridgeContext | null = null;
let selected: string | null = null;
const render = () =>
  root.render(
    <StrictMode>
      <App bridge={bridge} context={context} selected={selected} />
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

// The dashboard's fonts. The page's CSP has no font-src, so a data: URL in
// @font-face is blocked; a FontFace built from bytes fetches nothing.
for (const [family, weight, url] of [
  ["Geist Sans", "400", sans400],
  ["Geist Sans", "500", sans500],
  ["Geist Sans", "600", sans600],
  ["Geist Mono", "400", mono400],
]) {
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
  const face = new FontFace(family, bytes, { weight });
  document.fonts.add(face);
  face.load().catch((e: Error) => console.error(`[kanban] font ${family} ${weight}: ${e.message}`));
}

// Connected here rather than in an effect: the dashboard accepts one `ready`
// per frame, and StrictMode runs effects twice.
const bridge = connectBridge(window.parent, location.hash.slice(1), {
  onContext: (next) => {
    context = next;
    render();
  },
  onTheme: applyTheme,
  onSelection: (next) => {
    selected = next;
    render();
  },
});
render();
