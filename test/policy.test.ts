import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { bootstrapSomaHome, checkSomaPolicy, somaMemoryEventsPath } from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-policy-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("allows public writes without private Soma markers", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      substrate: "codex",
      action: "write",
      destinationPath: join(homeDir, "work/public/README.md"),
      content: "Generic public project notes.",
    });

    expect(result.decision).toBe("allow");
    expect(result.findings).toEqual([]);
  });
});

test("denies private Soma marker writes to public destinations", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      substrate: "codex",
      action: "write",
      destinationPath: join(homeDir, "work/public/README.md"),
      content: `Do not copy ${somaHome}/memory/RELATIONSHIP/private.md into public docs.`,
    });
    const events = await readFile(somaMemoryEventsPath(somaHome), "utf8");

    expect(result.decision).toBe("deny");
    expect(result.findings[0]).toMatchObject({
      kind: "private-marker",
    });
    expect(events).toContain("policy.check");
    expect(events).toContain("deny");
  });
});

test("allows private Soma marker writes inside private Soma destinations", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: join(somaHome, "memory/WORK/private-note.md"),
      content: `${somaHome}/memory/RELATIONSHIP/private.md`,
    });

    expect(result.decision).toBe("allow");
  });
});

test("denies private source paths to public destinations", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await checkSomaPolicy({
      homeDir,
      action: "write",
      destinationPath: join(homeDir, "work/public/summary.md"),
      sourcePath: join(somaHome, "profile/imports/claude/DA_IDENTITY.md"),
      content: "Summarized identity.",
    });

    expect(result.decision).toBe("deny");
    expect(result.findings[0]).toMatchObject({
      kind: "private-source",
    });
  });
});
