import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseWritebackArgs, runWritebackCli } from "../src/cli/writeback";
import { applySomaWriteback, bootstrapSomaHome, readVsa, scaffoldVsa, setActiveVsa } from "../src/index";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "soma-writeback-"));
}

describe("applySomaWriteback", () => {
  test("#147: appends memory events only through the writeback gate", async () => {
    const homeDir = await tempHome();
    const somaHome = join(homeDir, ".soma");

    const result = await applySomaWriteback({
      somaHome,
      substrate: "codex",
      timestamp: "2026-05-21T10:00:00.000Z",
      operation: {
        kind: "memory-event",
        event: {
          kind: "result.captured",
          summary: "Captured result promoted into writeback inbox.",
          artifactPaths: ["session/1.jsonl"],
          metadata: { source: "test" },
        },
      },
    });

    expect(result.decision).toBe("applied");
    expect(result.merge).toBe("append-only");
    expect(result.writes).toEqual([join(somaHome, "memory/STATE/events.jsonl")]);

    const events = await readFile(join(somaHome, "memory/STATE/events.jsonl"), "utf8");
    expect(events).toContain('"kind":"result.captured"');
    expect(events).toContain('"substrate":"codex"');
    expect(events).toContain('"source":"test"');
  });

  test("#147: refuses unsupported durable writeback compartments", async () => {
    const homeDir = await tempHome();

    await expect(
      applySomaWriteback({
        somaHome: join(homeDir, ".soma"),
        substrate: "codex",
        operation: {
          kind: "durable-memory",
          store: "KNOWLEDGE",
          relativePath: "facts/example.md",
        },
      }),
    ).rejects.toThrow("Unsupported writeback store KNOWLEDGE");
  });

  test("#147: merges VSA log entries through active-VSA append semantics", async () => {
    const homeDir = await tempHome();
    const somaHome = join(homeDir, ".soma");
    await bootstrapSomaHome({ homeDir });
    await scaffoldVsa({ homeDir, slug: "demo", goal: "G", effort: "E4", timestamp: "2026-05-21T09:00:00.000Z" });
    await setActiveVsa("demo", { homeDir });

    const result = await applySomaWriteback({
      somaHome,
      substrate: "codex",
      timestamp: "2026-05-21T10:00:00.000Z",
      operation: {
        kind: "vsa-log",
        entries: {
          decisions: [{ text: "Use append-only VSA writeback" }],
          changelogEntries: [{ text: "Added writeback merge gate" }],
          verificationEntries: [{ text: "Gate test passed" }],
        },
      },
    });

    expect(result.decision).toBe("applied");
    expect(result.merge).toBe("vsa-log-append");
    expect(result.writes.some((path) => path.endsWith("vsa/demo.md"))).toBe(true);
    expect(result.writes.some((path) => path.endsWith("memory/STATE/events.jsonl"))).toBe(true);

    const isa = await readVsa("demo", { homeDir });
    expect(isa.sections.find((s) => s.name === "Decisions")?.content).toContain("Use append-only VSA writeback");
    expect(isa.sections.find((s) => s.name === "Changelog")?.content).toContain("Added writeback merge gate");
    expect(isa.sections.find((s) => s.name === "Verification")?.content).toContain("Gate test passed");
  });

  test("#147: refuses VSA writeback to a non-active slug", async () => {
    const homeDir = await tempHome();
    await bootstrapSomaHome({ homeDir });
    await scaffoldVsa({ homeDir, slug: "active", goal: "G", effort: "E1" });
    await scaffoldVsa({ homeDir, slug: "other", goal: "G", effort: "E1" });
    await setActiveVsa("active", { homeDir });

    await expect(
      applySomaWriteback({
        somaHome: join(homeDir, ".soma"),
        substrate: "codex",
        operation: {
          kind: "vsa-log",
          slug: "other",
          entries: { decisions: [{ text: "Wrong target" }] },
        },
      }),
    ).rejects.toThrow("does not match active VSA");
  });

  test("#147: refuses explicit VSA writeback when no active VSA is set", async () => {
    const homeDir = await tempHome();
    await bootstrapSomaHome({ homeDir });
    await scaffoldVsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });

    await expect(
      applySomaWriteback({
        somaHome: join(homeDir, ".soma"),
        substrate: "codex",
        operation: {
          kind: "vsa-log",
          slug: "demo",
          entries: { decisions: [{ text: "No active target" }] },
        },
      }),
    ).rejects.toThrow("requires an active VSA");
  });
});

describe("writeback queue CLI", () => {
  test("#236: drains large queues in bounded batches and clears checkpoint state", async () => {
    const homeDir = await tempHome();
    const somaHome = join(homeDir, ".soma");
    const queueFile = join(homeDir, "writeback-queue.jsonl");
    const queuedEvents = Array.from({ length: 501 }, (_, index) => ({
      kind: "writeback.queue.test",
      summary: `Queued writeback ${index}`,
    }));
    await writeFile(queueFile, `${queuedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const output = await runWritebackCli(parseWritebackArgs([
      "writeback",
      "events",
      "--soma-home",
      somaHome,
      "--queue-file",
      queueFile,
      "--substrate",
      "claude-code",
    ]));

    expect(output).toContain("events: 501");
    const events = await readFile(join(somaHome, "memory/STATE/events.jsonl"), "utf8");
    expect(events.trim().split("\n")).toHaveLength(501);
    await expect(stat(queueFile)).rejects.toThrow();
    await expect(stat(`${queueFile}.checkpoint`)).rejects.toThrow();
  });

  test("#236: removes the claimed retry queue after a successful drain", async () => {
    const homeDir = await tempHome();
    const somaHome = join(homeDir, ".soma");
    const baseQueueFile = join(homeDir, "writeback-queue.jsonl");
    const checkpointFile = `${baseQueueFile}.checkpoint`;
    const retryQueueFile = join(homeDir, "writeback-queue.jsonl.retry");
    await writeFile(
      retryQueueFile,
      `${JSON.stringify({ kind: "writeback.queue.retry", summary: "Retry queue event" })}\n`,
      "utf8",
    );

    const output = await runWritebackCli(parseWritebackArgs([
      "writeback",
      "events",
      "--soma-home",
      somaHome,
      "--queue-file",
      retryQueueFile,
      "--checkpoint-file",
      checkpointFile,
      "--substrate",
      "claude-code",
    ]));

    expect(output).toContain("events: 1");
    const events = await readFile(join(somaHome, "memory/STATE/events.jsonl"), "utf8");
    expect(events).toContain('"kind":"writeback.queue.retry"');
    await expect(stat(retryQueueFile)).rejects.toThrow();
    await expect(stat(checkpointFile)).rejects.toThrow();
  });

  test("#236: missing queue file is refused instead of reported as drained", async () => {
    const homeDir = await tempHome();
    const somaHome = join(homeDir, ".soma");
    const queueFile = join(homeDir, "missing-writeback-queue.jsonl");

    await expect(
      runWritebackCli(parseWritebackArgs([
        "writeback",
        "events",
        "--soma-home",
        somaHome,
        "--queue-file",
        queueFile,
        "--substrate",
        "claude-code",
      ])),
    ).rejects.toThrow("Queued writeback file does not exist");
  });

  test("#236: blank queue lines are refused to keep checkpoint accounting unambiguous", async () => {
    const homeDir = await tempHome();
    const somaHome = join(homeDir, ".soma");
    const queueFile = join(homeDir, "blank-writeback-queue.jsonl");
    await writeFile(queueFile, "\n", "utf8");

    await expect(
      runWritebackCli(parseWritebackArgs([
        "writeback",
        "events",
        "--soma-home",
        somaHome,
        "--queue-file",
        queueFile,
        "--substrate",
        "claude-code",
      ])),
    ).rejects.toThrow("Queued writeback event line must not be blank");
  });
});
