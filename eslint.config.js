import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "playwright-report/", "test-results/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  {
    // The host parses every stdout line as a JSON-RPC request; logs go to stderr.
    files: ["src/worker/**"],
    rules: { "no-console": ["error", { allow: ["error"] }] },
  },
);
