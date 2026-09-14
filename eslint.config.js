import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "test-results/**", "playwright-report/**", ".wrangler/**", "coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "off",
      // eslint-plugin-react-hooks 7 recommended enables React Compiler rules.
      // Downgraded to warn pending a follow-up pass to fix the flagged sites
      // (setState-in-effect in auth pages, one ref-during-render case).
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
  { files: ["tests/**/*.d.ts"], rules: { "@typescript-eslint/no-empty-object-type": "off" } },
);
