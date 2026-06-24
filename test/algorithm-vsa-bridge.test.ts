import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  bootstrapSomaHome,
  markVsaVerifiedFromCriteria,
  readVsa,
  recordAlgorithmVsaChange,
  recordAlgorithmVsaDecision,
  scaffoldVsa,
  setActiveVsa,
  somaMemoryEventsPath,
  suggestVsaAtObserve,
  writeVsa,
} from "../src/index";
import { _resetSuggestSessionForTests } from "../src/algorithm-vsa-bridge";
import { updateCriterion } from "../src/vsa-accessors";

async function withSomaHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-alg-vsa-"));
  try {
    await bootstrapSomaHome({ homeDir });
    _resetSuggestSessionForTests();
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function withReadOnlyMemoryState<T>(homeDir: string, fn: () => Promise<T>): Promise<T> {
  const { chmod, mkdir } = await import("node:fs/promises");
  const memDir = join(homeDir, ".soma", "memory", "STATE");
  await mkdir(memDir, { recursive: true }).catch(() => {});
  await chmod(memDir, 0o500);
  try {
    return await fn();
  } finally {
    await chmod(memDir, 0o700);
  }
}

async function readEvents(homeDir: string): Promise<{ kind: string; summary?: string; metadata?: Record<string, unknown> }[]> {
  const raw = await readFile(somaMemoryEventsPath(join(homeDir, ".soma")), "utf8").catch(() => "");
  return raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as { kind: string });
}

test("AC-1: recordAlgorithmVsaDecision appends when active VSA set", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "demo", goal: "G", effort: "E4" });
    await setActiveVsa("demo", { homeDir });
    const result = await recordAlgorithmVsaDecision("Chose path A", { homeDir });
    expect(result.recorded).toBe(true);
    expect(result.slug).toBe("demo");
    const isa = await readVsa("demo", { homeDir });
    expect(isa.sections.find((s) => s.name === "Decisions")?.content).toContain("Chose path A");
  });
});

test("AC-1: recordAlgorithmVsaChange appends to Changelog when active VSA set", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "demo", goal: "G", effort: "E4" });
    await setActiveVsa("demo", { homeDir });
    const result = await recordAlgorithmVsaChange("Refuted by test", { homeDir });
    expect(result.recorded).toBe(true);
    const isa = await readVsa("demo", { homeDir });
    expect(isa.sections.find((s) => s.name === "Changelog")?.content).toContain("Refuted by test");
  });
});

test("AC-2: no-op + no-active-vsa telemetry when active unset", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await recordAlgorithmVsaDecision("Stranded decision", { homeDir });
    expect(result.recorded).toBe(false);
    expect(result.slug).toBeNull();
    const events = await readEvents(homeDir);
    expect(events.some((e) => e.kind === "algorithm.vsa_route.no-active-vsa")).toBe(true);
  });
});

test("AC-3: markVsaVerifiedFromCriteria flips for manually-edited VSA where flag stale", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({
      homeDir,
      slug: "demo",
      goal: "G",
      effort: "E1",
      initialCriteria: [
        { id: "C1", text: "First", status: "open" },
        { id: "C2", text: "Second", status: "open" },
      ],
    });
    // Open criteria → not verified
    const before = await markVsaVerifiedFromCriteria("demo", { homeDir });
    expect(before.verified).toBe(false);
    expect(before.flipped).toBe(false);

    // Pass both criteria — writeVsa's serializer auto-recomputes
    // frontmatter.verified, so verified flips here.
    let isa = await readVsa("demo", { homeDir });
    isa = updateCriterion(isa, "C1", "passed", "ok");
    isa = updateCriterion(isa, "C2", "dropped", undefined);
    await writeVsa("demo", isa, { homeDir });

    // First call sees writeVsa's serializer already flipped → idempotent.
    const afterWrite = await markVsaVerifiedFromCriteria("demo", { homeDir });
    expect(afterWrite.verified).toBe(true);
    expect(afterWrite.flipped).toBe(false);
    const persisted = await readVsa("demo", { homeDir });
    expect(persisted.frontmatter.verified).toBe(true);

    // Stale-flag scenario: manually patch verified=false on disk while
    // criteria are all closed → markVsaVerifiedFromCriteria flips it.
    const vsaPath = join(homeDir, ".soma", "vsa", "demo.md");
    const raw = await readFile(vsaPath, "utf8");
    const stale = raw.replace(/verified: true/, "verified: false");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(vsaPath, stale, "utf8");
    const flipResult = await markVsaVerifiedFromCriteria("demo", { homeDir });
    expect(flipResult.verified).toBe(true);
    expect(flipResult.flipped).toBe(true);
  });
});

test("AC-4: suggestVsaAtObserve emits hint when E3+ multi-step no-active, returns normally", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await suggestVsaAtObserve({ effort: "E3", multiStep: true }, { homeDir });
    expect(result.emitted).toBe(true);
    expect(result.hint).toContain("soma vsa scaffold");
    const events = await readEvents(homeDir);
    expect(events.some((e) => e.kind === "algorithm.vsa_hint.suggested")).toBe(true);
  });
});

test("suggestVsaAtObserve does NOT emit below E3", async () => {
  await withSomaHome(async (homeDir) => {
    const e1 = await suggestVsaAtObserve({ effort: "E1", multiStep: true }, { homeDir });
    expect(e1.emitted).toBe(false);
    expect(e1.reason).toBe("below-threshold");
    const e2 = await suggestVsaAtObserve({ effort: "E2", multiStep: true }, { homeDir });
    expect(e2.emitted).toBe(false);
  });
});

test("suggestVsaAtObserve does NOT emit for single-step E3", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await suggestVsaAtObserve({ effort: "E3", multiStep: false }, { homeDir });
    expect(result.emitted).toBe(false);
    expect(result.reason).toBe("single-step");
  });
});

test("suggestVsaAtObserve does NOT emit when active VSA exists", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });
    await setActiveVsa("demo", { homeDir });
    const result = await suggestVsaAtObserve({ effort: "E4", multiStep: true }, { homeDir });
    expect(result.emitted).toBe(false);
    expect(result.reason).toBe("already-active");
  });
});

test("suggestVsaAtObserve fires at most once per session", async () => {
  await withSomaHome(async (homeDir) => {
    const first = await suggestVsaAtObserve({ effort: "E3", multiStep: true }, { homeDir });
    expect(first.emitted).toBe(true);
    const second = await suggestVsaAtObserve({ effort: "E3", multiStep: true }, { homeDir });
    expect(second.emitted).toBe(false);
    expect(second.reason).toBe("already-emitted");
  });
});

test("suggestVsaAtObserve honors hints.suppressed config", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await suggestVsaAtObserve(
      { effort: "E5", multiStep: true },
      { homeDir, hintConfig: { suppressed: true } },
    );
    expect(result.emitted).toBe(false);
    expect(result.reason).toBe("suppressed-config");
  });
});

test("suggestVsaAtObserve honors SOMA_NO_HINTS env var", async () => {
  await withSomaHome(async (homeDir) => {
    const prev = process.env.SOMA_NO_HINTS;
    process.env.SOMA_NO_HINTS = "1";
    try {
      const result = await suggestVsaAtObserve({ effort: "E5", multiStep: true }, { homeDir });
      expect(result.emitted).toBe(false);
      expect(result.reason).toBe("suppressed-env");
    } finally {
      if (prev === undefined) delete process.env.SOMA_NO_HINTS;
      else process.env.SOMA_NO_HINTS = prev;
    }
  });
});

test("AC-5: no requireVsaAtObserve export exists", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const idx = require("../src/index") as Record<string, unknown>;
  expect(idx.requireVsaAtObserve).toBeUndefined();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bridge = require("../src/algorithm-vsa-bridge") as Record<string, unknown>;
  expect(bridge.requireVsaAtObserve).toBeUndefined();
});

test("AC-7: Algorithm run-shaped end-to-end with no active VSA never throws", async () => {
  await withSomaHome(async (homeDir) => {
    // Simulate Algorithm phases: hint → decisions/changes → verify
    await suggestVsaAtObserve({ effort: "E1", multiStep: false }, { homeDir });
    await recordAlgorithmVsaDecision("decision-without-isa", { homeDir });
    await recordAlgorithmVsaChange("change-without-isa", { homeDir });
    // No throw — all calls returned. AC-7 satisfied.
    expect(true).toBe(true);
  });
});

test("record* functions return normally when telemetry write fails (no-active)", async () => {
  await withSomaHome(async (homeDir) => {
    await withReadOnlyMemoryState(homeDir, async () => {
      const d = await recordAlgorithmVsaDecision("stranded", { homeDir });
      const c = await recordAlgorithmVsaChange("stranded", { homeDir });
      expect(d.recorded).toBe(false);
      expect(d.slug).toBeNull();
      expect(c.recorded).toBe(false);
      expect(c.slug).toBeNull();
    });
  });
});

test("suggestVsaAtObserve returns normally when telemetry write fails", async () => {
  await withSomaHome(async (homeDir) => {
    await withReadOnlyMemoryState(homeDir, async () => {
      const result = await suggestVsaAtObserve(
        { effort: "E4", multiStep: true },
        { homeDir },
      );
      expect(result.emitted).toBe(true);
      expect(result.hint).toContain("soma vsa scaffold");
    });
  });
});

test("AC-6: no-active-vsa telemetry events accumulate", async () => {
  await withSomaHome(async (homeDir) => {
    await recordAlgorithmVsaDecision("a", { homeDir });
    await recordAlgorithmVsaChange("b", { homeDir });
    await recordAlgorithmVsaDecision("c", { homeDir });
    const events = await readEvents(homeDir);
    const tagged = events.filter((e) => e.kind === "algorithm.vsa_route.no-active-vsa");
    expect(tagged.length).toBe(3);
  });
});
