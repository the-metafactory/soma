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
