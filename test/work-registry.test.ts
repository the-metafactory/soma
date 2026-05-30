import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "bun:test";
import {
  listSomaWorkRegistryEntries,
  somaWorkRegistryPaths,
  upsertSomaWorkRegistryEntry,
} from "../src";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-work-registry-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("work registry helper writes PAI-aligned shared state without transcripts", async () => {
  await withTempHome(async (homeDir) => {
    const result = await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "session-1",
      sessionName: "ship work registry",
      substrate: "codex",
      task: "Align shared session state",
      phase: "complete",
      progress: "1/1",
      timestamp: "2026-05-26T10:00:00.000Z",
      artifacts: {
        isa: "memory/WORK/ship-work-registry/ISA.md",
      },
    });

    const workPath = join(homeDir, ".soma/memory/STATE/work.json");
    const namesPath = join(homeDir, ".soma/memory/STATE/session-names.json");
    const currentPath = somaWorkRegistryPaths({ homeDir }, "session-1").currentWork!;

    expect(result.files).toEqual([workPath, namesPath, currentPath]);
    const work = JSON.parse(await readFile(workPath, "utf8"));
    const names = JSON.parse(await readFile(namesPath, "utf8"));
    const current = JSON.parse(await readFile(currentPath, "utf8"));

    expect(Object.keys(work.sessions)).toEqual(["ship-work-registry"]);
    expect(work.sessions["ship-work-registry"]).toMatchObject({
      sessionUUID: "session-1",
      sessionName: "ship work registry",
      substrate: "codex",
      task: "Align shared session state",
      phase: "complete",
      progress: "1/1",
      artifacts: {
        isa: "memory/WORK/ship-work-registry/ISA.md",
      },
    });
    expect(names).toEqual({ "session-1": "ship work registry" });
    expect(current).toMatchObject({ slug: "ship-work-registry", sessionUUID: "session-1" });

    const serialized = JSON.stringify(work);
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("result");

    await expect(listSomaWorkRegistryEntries({ homeDir })).resolves.toEqual([
      expect.objectContaining({ sessionUUID: "session-1", sessionName: "ship work registry" }),
    ]);
  });
});

test("work registry upsert replaces stale slug for the same session", async () => {
  await withTempHome(async (homeDir) => {
    await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "session-1",
      sessionName: "first name",
      substrate: "codex",
    });
    await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "session-1",
      sessionName: "renamed session",
      substrate: "codex",
    });

    const work = JSON.parse(await readFile(join(homeDir, ".soma/memory/STATE/work.json"), "utf8"));
    const current = JSON.parse(await readFile(somaWorkRegistryPaths({ homeDir }, "session-1").currentWork!, "utf8"));

    expect(Object.keys(work.sessions)).toEqual(["renamed-session"]);
    expect(current).toMatchObject({ slug: "renamed-session", sessionUUID: "session-1" });
    await expect(listSomaWorkRegistryEntries({ homeDir })).resolves.toEqual([
      expect.objectContaining({ sessionUUID: "session-1", sessionName: "renamed session" }),
    ]);
  });
});

test("work registry upsert disambiguates equal names for different sessions", async () => {
  await withTempHome(async (homeDir) => {
    await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "session-1",
      sessionName: "shared name",
      substrate: "codex",
    });
    await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "session-2",
      sessionName: "shared name",
      substrate: "pi-dev",
    });

    const work = JSON.parse(await readFile(join(homeDir, ".soma/memory/STATE/work.json"), "utf8"));

    expect(Object.keys(work.sessions).sort()).toEqual(["shared-name", "shared-name-session-2"]);
    expect(work.sessions["shared-name"]).toMatchObject({ sessionUUID: "session-1", substrate: "codex" });
    expect(work.sessions["shared-name-session-2"]).toMatchObject({ sessionUUID: "session-2", substrate: "pi-dev" });
  });
});

test("work registry upserts preserve concurrent sessions", async () => {
  await withTempHome(async (homeDir) => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        upsertSomaWorkRegistryEntry({
          homeDir,
          sessionId: `session-${index + 1}`,
          sessionName: `parallel session ${index + 1}`,
          substrate: "codex",
        }),
      ),
    );

    const work = JSON.parse(await readFile(join(homeDir, ".soma/memory/STATE/work.json"), "utf8"));
    expect(Object.keys(work.sessions)).toHaveLength(12);
  });
});

test("work registry current-work filenames resist sanitized session id collisions", async () => {
  await withTempHome(async (homeDir) => {
    const slash = await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "a/b",
      sessionName: "slash",
      substrate: "codex",
    });
    const colon = await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "a:b",
      sessionName: "colon",
      substrate: "codex",
    });

    const slashPointerPath = slash.files.find((file) => file.includes("current-work-"))!;
    const colonPointerPath = colon.files.find((file) => file.includes("current-work-"))!;

    expect(slashPointerPath).not.toBe(colonPointerPath);
    await expect(readFile(slashPointerPath, "utf8")).resolves.toContain('"sessionUUID": "a/b"');
    await expect(readFile(colonPointerPath, "utf8")).resolves.toContain('"sessionUUID": "a:b"');
  });
});

test("work registry current-work filenames bound long session ids", async () => {
  await withTempHome(async (homeDir) => {
    const result = await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "session-".padEnd(400, "x"),
      sessionName: "long session",
      substrate: "codex",
    });

    const pointerPath = result.files.find((file) => file.includes("current-work-"))!;
    expect(basename(pointerPath).length).toBeLessThan(120);
  });
});

test("work registry persists special session ids as data keys", async () => {
  await withTempHome(async (homeDir) => {
    await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "__proto__",
      sessionName: "__proto__",
      substrate: "codex",
    });

    const work = JSON.parse(await readFile(join(homeDir, ".soma/memory/STATE/work.json"), "utf8"));
    const names = JSON.parse(await readFile(join(homeDir, ".soma/memory/STATE/session-names.json"), "utf8"));

    expect(Object.hasOwn(work.sessions, "__proto__")).toBe(true);
    expect(Object.hasOwn(names, "__proto__")).toBe(true);
    expect(work.sessions.__proto__).toMatchObject({ sessionUUID: "__proto__" });
    expect(names.__proto__).toBe("__proto__");
  });
});

test("work registry rejects malformed object shapes", async () => {
  await withTempHome(async (homeDir) => {
    const stateDir = join(homeDir, ".soma/memory/STATE");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "work.json"), "{\"sessions\":[]}\n", "utf8");

    await expect(
      upsertSomaWorkRegistryEntry({
        homeDir,
        sessionId: "session-1",
        sessionName: "malformed registry",
        substrate: "codex",
      }),
    ).rejects.toThrow("sessions must be an object");

    await writeFile(join(stateDir, "work.json"), "{\"sessions\":null}\n", "utf8");
    await expect(listSomaWorkRegistryEntries({ homeDir })).rejects.toThrow("sessions must be an object");
  });
});

test("work registry rejects malformed entry fields", async () => {
  await withTempHome(async (homeDir) => {
    const stateDir = join(homeDir, ".soma/memory/STATE");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "work.json"),
      `${JSON.stringify({
        sessions: {
          bad: {
            task: "Bad registry",
            sessionName: "bad",
            sessionUUID: "session-bad",
            substrate: "codex",
            phase: "complete",
            progress: "1/1",
            started: "2026-05-26T10:00:00.000Z",
            updatedAt: 123,
            artifacts: {},
          },
        },
      })}\n`,
      "utf8",
    );

    await expect(listSomaWorkRegistryEntries({ homeDir })).rejects.toThrow("session entry bad.updatedAt must be a string");
  });
});

test("work registry normalizes artifact pointers and rejects leaks", async () => {
  await withTempHome(async (homeDir) => {
    await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "session-1",
      sessionName: "artifact pointers",
      substrate: "codex",
      artifacts: {
        learning: join(homeDir, ".soma/memory/LEARNING/ALGORITHM/run.md"),
        state: "memory/STATE/algorithm-work-index.json",
      },
    });

    const work = JSON.parse(await readFile(join(homeDir, ".soma/memory/STATE/work.json"), "utf8"));
    expect(work.sessions["artifact-pointers"].artifacts).toEqual({
      learning: "memory/LEARNING/ALGORITHM/run.md",
      state: "memory/STATE/algorithm-work-index.json",
    });

    await expect(
      upsertSomaWorkRegistryEntry({
        homeDir,
        sessionId: "session-2",
        sessionName: "leaky artifact",
        substrate: "codex",
        artifacts: {
          leak: join(homeDir, "outside.md"),
        },
      }),
    ).rejects.toThrow("escapes Soma home");

    await expect(
      upsertSomaWorkRegistryEntry({
        homeDir,
        sessionId: "session-3",
        sessionName: "private artifact",
        substrate: "codex",
        artifacts: {
          profile: "profile.md",
        },
      }),
    ).rejects.toThrow("must stay under memory/");
  });
});
