import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  // docs/research holds reference material (sample decoders), not app code; generated codecs and the engine's Emscripten glue aren't linted.
  // .claude/worktrees: other agents' checkouts (git-excluded), linted in their own trees.
  globalIgnores(["out/**", "dist/**", "node_modules/**", "docs/**", "**/*.generated.ts", "src/renderer/src/engine/wasm/**", "engine/build/**", ".claude/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["src/renderer/public/**/*.js"],
    languageOptions: { globals: globals.browser, sourceType: "script" },
  },
  {
    // Node scripts — their page.evaluate() callbacks run in the window, hence the browser's names too.
    files: ["scripts/**/*.{mjs,cjs}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["scripts/**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["src/main/**/*.ts", "src/preload/**/*.ts", "*.ts", "*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
]);
