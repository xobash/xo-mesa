import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/**", "src-tauri/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-control-regex": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: Object.fromEntries([
      "process", "console", "Buffer", "URL", "TextEncoder", "TextDecoder", "AbortController",
      "Uint8Array", "ArrayBuffer", "setTimeout", "clearTimeout", "performance", "fetch", "crypto", "window", "document"
    ].map(name => [name, "readonly"])) },
    rules: { "no-undef": "error", "no-unreachable": "error", "no-constant-condition": "error", "no-dupe-keys": "error", "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }], "@typescript-eslint/no-unused-vars": "off" },
  },
);
