// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "eslint.config.js",
      "scripts/**",
    ],
  },

  // Base JS recommended
  js.configs.recommended,

  // TypeScript: recommended + type-checked (applied to src/ only)
  ...tseslint.configs.recommendedTypeChecked.map((cfg) => ({
    ...cfg,
    files: ["src/**/*.ts"],
  })),

  // Project-specific rules for src/
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Async correctness (real bugs) ───────────────────────────────
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // ── Import hygiene ───────────────────────────────────────────────
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // ── Noise reduction: downgrade or disable churn-only rules ───────
      // no-explicit-any: warn only — codebase has justified any in adapter layers
      "@typescript-eslint/no-explicit-any": "warn",
      // unsafe rules from recommended-type-checked are noisy without full any-clean pass
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // explicit return types — too noisy for this codebase
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      // unused vars: keep as warn (tsc already catches errors)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // allow require() — not present in this ESM codebase but avoid false positives
      "@typescript-eslint/no-require-imports": "error",
      // restrict-template-expressions can fire on legitimate string coercion
      "@typescript-eslint/restrict-template-expressions": "off",
      // no-base-to-string — off, fires on well-typed code
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
);
