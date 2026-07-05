import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { createPaths, type SomaPaths } from "../src/index";

test("createPaths defaults under a home directory", () => {
  const homeDir = "/tmp/soma-paths-home";
  const paths = createPaths({ homeDir });
  const root = join(resolve(homeDir), ".soma");

  expect(paths.root()).toBe(root);
  expect(paths.memory()).toBe(join(root, "memory"));
  expect(paths.skills()).toBe(join(root, "skills"));
});

test("createPaths accepts explicit somaHome and resolves core shared paths", () => {
  const root = resolve("/tmp/custom-soma");
  const paths = createPaths({ somaHome: root });

  expect(paths.root()).toBe(root);
  expect(paths.identity()).toBe(join(root, "identity"));
  expect(paths.learning()).toBe(join(root, "memory", "LEARNING"));
  expect(paths.signals()).toBe(join(root, "memory", "LEARNING", "SIGNALS"));
  expect(paths.wisdom()).toBe(join(root, "memory", "WISDOM"));
  expect(paths.relationship()).toBe(join(root, "memory", "RELATIONSHIP"));
  expect(paths.state()).toBe(join(root, "memory", "STATE"));
  expect(paths.work()).toBe(join(root, "memory", "WORK"));
});

test("createPaths resolves migrated tool files", () => {
  const root = "/tmp/soma-tool-paths";
  const paths = createPaths(root);

  expect(paths.ratings()).toBe(`${root}/memory/LEARNING/SIGNALS/ratings.jsonl`);
  expect(paths.opinions()).toBe(`${root}/identity/opinions.md`);
  expect(paths.story()).toBe(`${root}/identity/our-story.md`);
  expect(paths.events()).toBe(`${root}/memory/STATE/events.jsonl`);
});

test("generic resolver stays inside somaHome", () => {
  const root = "/tmp/soma-resolve";
  const paths = createPaths(root);

  expect(paths.resolve("memory", "WISDOM", "FRAMES", "development.md")).toBe(
    `${root}/memory/WISDOM/FRAMES/development.md`,
  );
  expect(() => paths.resolve("memory", "..", "..", "escape.md")).toThrow("escapes root");
  expect(() => paths.resolve("/tmp/outside.md")).toThrow("escapes root");
});

test("path resolver does not vary by caller", () => {
  const root = "/tmp/shared-soma";
  const codexCaller = createPaths({ somaHome: root });
  const piCaller = createPaths({ somaHome: root });

  expect(codexCaller.ratings()).toBe(piCaller.ratings());
  expect(codexCaller.root()).toBe(resolve(root));
});

test("SomaPaths type is importable by migrated tools", () => {
  const paths: SomaPaths = createPaths("/tmp/soma-types");
  expect(paths.ratings()).toContain("ratings.jsonl");
});

// soma#407: the note subsystem's store layout (semantic/procedural/episodic/
// archive/promoted/knowledge) is now named on SomaPaths — asserted here at the
// seam, not by literal string in each memory-*.ts caller.
test("SomaPaths names every store the note subsystem reads/writes", () => {
  const root = "/tmp/soma-note-stores";
  const paths = createPaths(root);

  expect(paths.knowledge()).toBe(join(root, "memory", "KNOWLEDGE"));
  expect(paths.semantic()).toBe(join(root, "memory", "semantic"));
  expect(paths.procedural()).toBe(join(root, "memory", "procedural"));
  expect(paths.archive()).toBe(join(root, "memory", "archive"));
  expect(paths.archive("episodic", "sessions", "2026-07")).toBe(
    join(root, "memory", "archive", "episodic", "sessions", "2026-07"),
  );
});

test("SomaPaths.episodic names the sessions/actions/digests dirs and accepts nested segments", () => {
  const root = "/tmp/soma-episodic";
  const paths = createPaths(root);

  expect(paths.episodic("sessions")).toBe(join(root, "memory", "episodic", "sessions"));
  expect(paths.episodic("actions")).toBe(join(root, "memory", "episodic", "actions"));
  expect(paths.episodic("digests")).toBe(join(root, "memory", "episodic", "digests"));
  expect(paths.episodic("sessions", "2026-07", "abc.md")).toBe(
    join(root, "memory", "episodic", "sessions", "2026-07", "abc.md"),
  );
});

test("SomaPaths.promoted maps every promotion store to its PROMOTED dir", () => {
  const root = "/tmp/soma-promoted";
  const paths = createPaths(root);

  expect(paths.promoted("learning")).toBe(join(root, "memory", "LEARNING", "PROMOTED"));
  expect(paths.promoted("knowledge")).toBe(join(root, "memory", "KNOWLEDGE", "PROMOTED"));
  expect(paths.promoted("relationship")).toBe(join(root, "memory", "RELATIONSHIP", "PROMOTED"));
  expect(paths.promoted("work")).toBe(join(root, "memory", "WORK", "PROMOTED"));
});

test("SomaPaths.state accepts nested segments alongside the existing zero-arg form", () => {
  const root = "/tmp/soma-state-segments";
  const paths = createPaths(root);

  expect(paths.state()).toBe(join(root, "memory", "STATE"));
  expect(paths.state("imports", "backfill", ".manifest.json")).toBe(
    join(root, "memory", "STATE", "imports", "backfill", ".manifest.json"),
  );
  expect(paths.events()).toBe(paths.state("events.jsonl"));
});

test("store accessors refuse to escape the Soma root", () => {
  const root = "/tmp/soma-store-escape";
  const paths = createPaths(root);

  // `archive()` prepends 2 segments ("memory","archive"); 3 levels of ".."
  // walks past the root itself.
  expect(() => paths.archive("..", "..", "..", "escape.md")).toThrow("escapes root");
  // `episodic("sessions", …)` prepends 3 segments; 4 levels of ".." escapes.
  expect(() => paths.episodic("sessions", "..", "..", "..", "..", "escape.md")).toThrow("escapes root");
  // `state()` prepends 2 segments ("memory","STATE"); 3 levels of ".." escapes.
  expect(() => paths.state("..", "..", "..", "escape.json")).toThrow("escapes root");
});
