import type { ComponentManifest } from "../../../src/components";

/** The manifest every fixture tree under test/fixtures/boundaries/ is checked against. */
export const fixtureManifest: ComponentManifest = {
  core: { files: ["src/paths"], mayImport: ["legacy"] },
  memory: { files: ["src/memory", "src/memory-*"], mayImport: ["core", "legacy"] },
  flows: { files: ["src/writeback"], mayImport: ["core", "memory", "legacy"] },
  substrates: {
    files: ["src/adapters/**"],
    mayImport: ["core", "legacy"],
    units: {
      codex: { files: ["src/adapters/codex/**", "src/adapters/codex"] },
      "pi-dev": { files: ["src/adapters/pi-dev/**", "src/adapters/pi-dev"] },
    },
  },
  legacy: { files: ["src/types", "src/index"], mayImport: ["core", "memory", "flows", "substrates"] },
};

/** The same manifest once `memory` is relocated and declares a public entry. */
export const publicMemoryManifest: ComponentManifest = {
  ...fixtureManifest,
  memory: { ...fixtureManifest.memory, publicEntries: ["src/memory"] },
};
