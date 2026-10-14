// Bun inlines `with { type: "text" }` imports as a string; tsc has no notion of
// them. Declared for `.md` only: unlike `.mjs` (see src/adapters/claude-code/hooks.ts),
// no `.md` file is ever imported as a real module, so a blanket type is safe.
declare module "*.md" {
  const text: string;
  export default text;
}
