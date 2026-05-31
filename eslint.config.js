// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".worktrees/**",
      ".tmp-tests/**",
      ".claude/**",
      ".codex/**",
      ".pi/**",
      "eslint.config.js",
      "MEMORY/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  {
    files: ["src/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/prefer-nullish-coalescing": "off",
    },
  },

  // Substrate-adapter boundary: per-substrate directories are private. Each
  // substrate may deep-import only within its own dir; everyone else must go
  // through the substrate barrel (`./codex`, `./pi-dev`) or the top-level
  // `./adapters` barrel. shared/ is internal to the adapter layer — only
  // adapter code may deep-import it.
  //
  // Implementation note: ESLint flat config does NOT compose `rules` across
  // multiple matching config blocks — the last block's rule definition wins.
  // We therefore scope each rule block by `files:` (not `ignores:`) so that
  // each src/ file is matched by exactly one block, with its own pattern list.
  //
  // Pattern shapes:
  //   - `**/adapters/<sub>/**` matches "./adapters/<sub>/..." from outside adapters/
  //   - `../<sub>/**`           matches sibling import from inside adapters/
  // These two together cover every legal import specifier shape in the repo.
  {
    files: ["src/adapters/codex/**/*.{ts,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/adapters/pi-dev/**", "../pi-dev/**", "../../pi-dev/**", "../../../pi-dev/**"],
              message: "codex must not deep-import pi-dev internals — go through the pi-dev barrel (./adapters/pi-dev).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/adapters/pi-dev/**/*.{ts,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/adapters/codex/**", "../codex/**", "../../codex/**", "../../../codex/**"],
              message: "pi-dev must not deep-import codex internals — go through the codex barrel (./adapters/codex).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,mjs}"],
    ignores: ["src/adapters/codex/**", "src/adapters/pi-dev/**", "src/adapters/shared/**", "src/install-spec-registry.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/adapters/codex/**",
                "**/adapters/pi-dev/**",
                "**/adapters/shared/**",
                "./adapters/codex/**",
                "./adapters/pi-dev/**",
                "./adapters/shared/**",
                "../adapters/codex/**",
                "../adapters/pi-dev/**",
                "../adapters/shared/**",
              ],
              message:
                "Import from the substrate barrel (./adapters/codex, ./adapters/pi-dev, ./adapters/shared) — deep imports erode the adapter boundary.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["test/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
);
