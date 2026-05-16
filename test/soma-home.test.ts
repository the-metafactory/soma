import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { bootstrapSomaHome, buildCodexHomeProjection, loadSomaHome } from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-bootstrap-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("bootstraps a soma home with starter profile and memory layout", async () => {
  await withTempHome(async (homeDir) => {
    const result = await bootstrapSomaHome({ homeDir });
    const somaHome = join(homeDir, ".soma");

    expect(result.somaHome).toBe(somaHome);
    expect(result.context.profile.assistant.name).toBe("soma");
    expect(result.context.profile.principal.preferredName).toBe("Principal");
    expect(result.context.profile.telos.goals).toContain("Establish Soma as the durable personal assistant home.");
    expect(result.context.profile.memory.learning).toBe(join(somaHome, "memory/LEARNING"));

    await expect(readFile(join(somaHome, "profile/assistant.md"), "utf8")).resolves.toContain("# Assistant");
    const workMemory = await stat(join(somaHome, "memory/WORK"));
    expect(workMemory.isDirectory()).toBe(true);
    await expect(readFile(join(somaHome, "policy/README.md"), "utf8")).resolves.toContain("Soma Policy");
  });
});

test("loads edited soma home profile files into context", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });

    await writeFile(
      join(somaHome, "profile/principal.md"),
      ["# Principal", "", "Name: jc", "Preferred name: JC", "", "## Profile", "", "- timezone: Europe/Zurich"].join("\n"),
      "utf8",
    );

    const context = await loadSomaHome(somaHome);

    expect(context.profile.principal.name).toBe("jc");
    expect(context.profile.principal.preferredName).toBe("JC");
    expect(context.profile.principal.profile).toEqual({
      timezone: "Europe/Zurich",
    });
  });
});

test("bootstrapped soma home feeds codex home projection", async () => {
  await withTempHome(async (homeDir) => {
    const { context, somaHome } = await bootstrapSomaHome({ homeDir });
    const projection = buildCodexHomeProjection(context, { homeDir });

    expect(projection.somaHome).toBe(somaHome);
    expect(projection.bundle.instructions).toContain("Soma source of truth");
    expect(projection.bundle.instructions).toContain("Establish Soma as the durable personal assistant home.");
  });
});

test("bootstrap does not overwrite existing profile files", async () => {
  await withTempHome(async (homeDir) => {
    const first = await bootstrapSomaHome({ homeDir });
    await writeFile(join(first.somaHome, "profile/assistant.md"), "# Assistant\n\nName: custom\n", "utf8");

    const second = await bootstrapSomaHome({ homeDir });

    expect(second.context.profile.assistant.name).toBe("custom");
  });
});

test("AC-1: bootstrap creates ~/.soma/isa/ + .templates/ + INDEX.md + memory/STATE/", async () => {
  const { stat } = await import("node:fs/promises");
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const isaDir = await stat(join(somaHome, "isa"));
    expect(isaDir.isDirectory()).toBe(true);
    const templatesDir = await stat(join(somaHome, "isa", ".templates"));
    expect(templatesDir.isDirectory()).toBe(true);
    const stateDir = await stat(join(somaHome, "memory", "STATE"));
    expect(stateDir.isDirectory()).toBe(true);
    const indexFile = await stat(join(somaHome, "isa", "INDEX.md"));
    expect(indexFile.isFile()).toBe(true);
  });
});

test("AC-6: bootstrap is idempotent for ISA storage layout", async () => {
  const { stat, readFile } = await import("node:fs/promises");
  await withTempHome(async (homeDir) => {
    const first = await bootstrapSomaHome({ homeDir });
    const firstIndex = await readFile(join(first.somaHome, "isa", "INDEX.md"), "utf8");

    // User edits INDEX.md — second bootstrap must not overwrite
    await writeFile(join(first.somaHome, "isa", "INDEX.md"), "# Custom Index\n\nMy entries.\n", "utf8");

    const second = await bootstrapSomaHome({ homeDir });
    const secondIndex = await readFile(join(second.somaHome, "isa", "INDEX.md"), "utf8");

    expect(secondIndex).toBe("# Custom Index\n\nMy entries.\n");
    expect(firstIndex).not.toBe(secondIndex);
    // Directories still present
    expect((await stat(join(second.somaHome, "isa", ".templates"))).isDirectory()).toBe(true);
  });
});

test("AC-3: SomaActiveIsaState type exported with correct shape", () => {
  // Type-only export — verify usable shape via type-checked literal.
  const sample: import("../src/index").SomaActiveIsaState = {
    activeSlug: null,
    runId: null,
    updatedAt: "2026-05-17T00:00:00.000Z",
  };
  expect(sample.activeSlug).toBeNull();
  expect(sample.runId).toBeNull();
  expect(sample.updatedAt).toContain("2026");
});

test("AC-5: SomaContextInput.activeIsa unchanged shape after bootstrap", async () => {
  await withTempHome(async (homeDir) => {
    const { context } = await bootstrapSomaHome({ homeDir });
    // No activeIsa expected on fresh bootstrap — bootstrap doesn't seed one
    expect(context.activeIsa).toBeUndefined();
    // Bootstrap returns the same shape callers always saw
    expect(context.profile).toBeDefined();
  });
});
