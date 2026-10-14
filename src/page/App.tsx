import { useEffect, useState } from "react";
import { type BridgeContext, connectBridge } from "./bridge";

export function App() {
  const [context, setContext] = useState<BridgeContext | null>(null);

  useEffect(
    () =>
      connectBridge(window.parent, window, {
        onContext: setContext,
        onTheme: (theme) => {
          const root = document.documentElement;
          root.style.colorScheme = theme.appearance;
          for (const [name, value] of Object.entries(theme.cssVars)) {
            root.style.setProperty(name, value);
          }
        },
      }),
    [],
  );

  return (
    <main>
      <h1>Board</h1>
      <p data-testid="bridge-status">
        {context
          ? `Connected to ${context.pluginId}/${context.pageId} (bridge v${context.bridgeVersion}${context.readOnly ? ", read-only" : ""})`
          : "Waiting for the dashboard..."}
      </p>
    </main>
  );
}
