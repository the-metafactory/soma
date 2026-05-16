import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-cli-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("cli dry-runs codex install without writing files", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli(["install", "codex", "--home-dir", homeDir]);

    expect(output).toContain("mode: dry-run");
    expect(output).toContain(join(homeDir, ".soma/profile/assistant.md"));
    expect(output).toContain(join(homeDir, ".codex/rules/soma.rules"));
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();
    await expect(stat(join(homeDir, ".codex"))).rejects.toThrow();
  });
});

test("cli shows no-argument usage as normal help", async () => {
  const output = await runSomaCli([]);

  expect(output).toContain("Usage:");
  expect(output).toContain("soma install <codex|pi-dev>");

  const result = spawnSync(process.execPath, ["run", "soma"], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage:");
  expect(result.stderr).not.toContain("error: script");
});

test("cli supports explicit main help as normal help", async () => {
  const output = await runSomaCli(["--help"]);

  expect(output).toContain("Usage:");
  expect(output).toContain("soma install <codex|pi-dev>");

  const result = spawnSync(process.execPath, ["run", "soma", "--help"], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage:");
  expect(result.stderr).not.toContain("Unknown command: --help");
  expect(result.stderr).not.toContain("error: script");
});

test("cli supports command-group help as normal help", async () => {
  await expect(runSomaCli(["algorithm", "--help"])).resolves.toContain("Usage: soma algorithm");
  await expect(runSomaCli(["--help", "algorithm"])).resolves.toContain("Usage: soma algorithm");
  await expect(runSomaCli(["memory", "--help"])).resolves.toContain("Usage: soma memory");
  await expect(runSomaCli(["feedback", "--help"])).resolves.toContain("Usage: soma feedback capture");
  await expect(runSomaCli(["policy", "--help"])).resolves.toContain("Usage: soma policy check");
  await expect(runSomaCli(["lifecycle", "--help"])).resolves.toContain("Usage: soma lifecycle");
  await expect(runSomaCli(["install", "--help"])).resolves.toContain("Usage: soma install");
  await expect(runSomaCli(["import", "--help"])).resolves.toContain("Usage: soma import");
});

test("cli supports concrete subcommand help as read-only normal help", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli(["algorithm", "new", "--help", "--home-dir", homeDir]);
    const prefixOutput = await runSomaCli(["--help", "algorithm", "new", "--home-dir", homeDir]);

    expect(output).toContain("Usage: soma algorithm new");
    expect(prefixOutput).toContain("Usage: soma algorithm new");
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();
  });

  await expect(runSomaCli(["algorithm", "batch", "--help"])).resolves.toContain("Usage: soma algorithm batch");
  await expect(runSomaCli(["memory", "search", "--help"])).resolves.toContain("Usage: soma memory search");
  await expect(runSomaCli(["policy", "check", "--help"])).resolves.toContain("Usage: soma policy check");
  await expect(runSomaCli(["install", "codex", "--help"])).resolves.toContain("Usage: soma install");
  await expect(runSomaCli(["import", "pai", "--help"])).resolves.toContain("Usage: soma import pai");
});

test("cli reports unknown top-level command with suggestion", async () => {
  await expect(runSomaCli(["inatall", "codex", "--apply"])).rejects.toThrow("Unknown command: inatall");
  await expect(runSomaCli(["inatall", "codex", "--apply"])).rejects.toThrow("Did you mean: install?");
  await expect(runSomaCli(["inatall", "--help"])).rejects.toThrow("Unknown command: inatall");

  const result = spawnSync(process.execPath, ["run", "soma", "inatall", "codex", "--apply"], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unknown command: inatall");
  expect(result.stderr).toContain("Did you mean: install?");
  expect(result.stderr).toContain("Usage:");
});

test("cli creates persisted Algorithm runs", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli([
      "algorithm",
      "new",
      "--home-dir",
      homeDir,
      "--prompt",
      "Port TheAlgorithm",
      "--intent",
      "Make Algorithm deterministic.",
      "--current-state",
      "Algorithm is declarative.",
      "--goal",
      "Harness exists.",
      "--criterion",
      "C1:Harness state is written.",
    ]);

    expect(output).toContain("Soma Algorithm run created");
    expect(output).toContain("phase: observe");
    const path = output
      .split("\n")
      .find((line) => line.startsWith("path: "))
      ?.slice("path: ".length);

    expect(path?.startsWith(join(homeDir, ".soma/memory/WORK/algorithm-runs"))).toBe(true);
    const persisted = await readFile(path ?? "", "utf8");
    expect(persisted).toContain('"schemaVersion": 2');
    expect(persisted).toContain('"content": "Harness exists."');
  });
});

test("cli reports missing Algorithm new fields", async () => {
  await expect(
    runSomaCli([
      "algorithm",
      "new",
      "--prompt",
      "Need a run",
      "--intent",
      "Create useful state.",
      "--current-state",
      "No run exists.",
      "--criterion",
      "C1:Run exists.",
    ]),
  ).rejects.toThrow("missing required option(s): --goal");
});

test("cli routes Anti criteria to antiCriteria", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli([
      "algorithm",
      "new",
      "--home-dir",
      homeDir,
      "--prompt",
      "Identify a surprising telos-aligned consulting outcome.",
      "--intent",
      "Find a non-obvious outcome.",
      "--current-state",
      "Prior run found client sovereignty.",
      "--goal",
      "A deeper compounding outcome is identified and verified.",
      "--criterion",
      "C1:Outcome is distinct from ordinary business success.",
      "--criterion",
      "Anti:Do not reduce the outcome to a learning loop.",
    ]);
    const path = output
      .split("\n")
      .find((line) => line.startsWith("path: "))
      ?.slice("path: ".length);
    const content = await readFile(path ?? "", "utf8");

    expect(content).toContain('"antiCriteria"');
    expect(content).toContain('"id": "Anti"');
    expect(content).toContain('"text": "Do not reduce the outcome to a learning loop."');
  });
});

test("cli classifies Algorithm prompt effort", async () => {
  const output = await runSomaCli([
    "algorithm",
    "classify",
    "--prompt",
    "Port a multi-file PAI adapter into Soma",
  ]);

  expect(output).toContain("mode: algorithm");
  expect(output).toContain("effort: E3");
  expect(output).toContain("source: auto");
});

test("cli drives Algorithm runs through gated mutations", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli([
      "algorithm",
      "new",
      "--home-dir",
      homeDir,
      "--id",
      "cli-run",
      "--prompt",
      "Use the harness",
      "--intent",
      "Drive work through gates.",
      "--current-state",
      "Only create exists.",
      "--goal",
      "Run reaches learn phase.",
      "--criterion",
      "C1:Mutation commands work.",
    ]);

    await expect(readFile(join(homeDir, ".soma/memory/STATE/algorithm-work-index.json"), "utf8")).resolves.toContain("cli-run");

    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);
    await runSomaCli(["algorithm", "capabilities", "--home-dir", homeDir, "--id", "cli-run", "--capability", "FeedbackMemoryConsult"]);
    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);
    await runSomaCli(["algorithm", "plan", "--home-dir", homeDir, "--id", "cli-run", "--step", "P1:C1:Exercise mutation commands."]);
    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);
    await runSomaCli(["algorithm", "change", "--home-dir", homeDir, "--id", "cli-run", "--text", "Added CLI mutation commands."]);
    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);
    await runSomaCli(["algorithm", "step", "--home-dir", homeDir, "--id", "cli-run", "--step-id", "P1", "--status", "done", "--evidence", "Step command persisted state."]);
    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);
    await runSomaCli([
      "algorithm",
      "verify",
      "--home-dir",
      homeDir,
      "--id",
      "cli-run",
      "--criterion-id",
      "C1",
      "--status",
      "passed",
      "--evidence",
      "CLI commands advanced through gates.",
    ]);
    const output = await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "cli-run"]);

    expect(output).toContain("phase: learn");
    expect(output).toContain("[passed] C1");
  });
});

test("cli batches routine Algorithm run mutations", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli([
      "algorithm",
      "new",
      "--home-dir",
      homeDir,
      "--id",
      "batch-run",
      "--prompt",
      "Use batch harness",
      "--intent",
      "Record routine evidence with one command.",
      "--current-state",
      "Mutation commands are separate.",
      "--goal",
      "Batch command records decision, change, and step evidence.",
      "--criterion",
      "C1:Batch command works.",
    ]);
    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "batch-run"]);
    await runSomaCli(["algorithm", "capabilities", "--home-dir", homeDir, "--id", "batch-run", "--capability", "FeedbackMemoryConsult"]);
    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "batch-run"]);
    await runSomaCli(["algorithm", "plan", "--home-dir", homeDir, "--id", "batch-run", "--step", "P1:C1:Exercise batch command."]);
    await runSomaCli(["algorithm", "advance", "--home-dir", homeDir, "--id", "batch-run"]);

    const output = await runSomaCli([
      "algorithm",
      "batch",
      "--home-dir",
      homeDir,
      "--id",
      "batch-run",
      "--op",
      "decision:Use one command for routine evidence.",
      "--op",
      "change:Added batch command.",
      "--op",
      "step:P1:done:Batch operation persisted step evidence.",
    ]);

    expect(output).toContain("[done] P1");
    expect(output).toContain("phase: build");
    await expect(readFile(join(homeDir, ".soma/memory/WORK/algorithm-runs/batch-run.json"), "utf8")).resolves.toContain(
      "Use one command for routine evidence.",
    );
  });
});

test("cli handles lifecycle events", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli(["install", "codex", "--apply", "--home-dir", homeDir]);
    const output = await runSomaCli([
      "lifecycle",
      "session-start",
      "--home-dir",
      homeDir,
      "--substrate",
      "codex",
      "--session-id",
      "cli-session",
    ]);

    expect(output).toContain("Soma lifecycle event handled");
    expect(output).toContain("event: session_start");
    expect(output).toContain("# Soma Startup Context");
    await expect(readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8")).resolves.toContain("lifecycle.session_start");
  });
});

test("cli searches Soma memory", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli(["install", "codex", "--apply", "--home-dir", homeDir]);
    await mkdir(join(homeDir, ".soma/memory/LEARNING/consulting"), { recursive: true });
    await writeFile(
      join(homeDir, ".soma/memory/LEARNING/consulting/agency.md"),
      "Measure consulting success by transferred autonomy, not dependency.\n",
      "utf8",
    );

    const output = await runSomaCli([
      "memory",
      "search",
      "--home-dir",
      homeDir,
      "--query",
      "transferred autonomy consulting",
    ]);

    expect(output).toContain("Soma memory search");
    expect(output).toContain("agency.md:1");
    expect(output).toContain("transferred autonomy");
  });
});

test("cli captures feedback candidates", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli(["install", "codex", "--apply", "--home-dir", homeDir]);

    const output = await runSomaCli([
      "feedback",
      "capture",
      "--home-dir",
      homeDir,
      "--substrate",
      "codex",
      "--source",
      "test",
      "--text",
      "you missed the arc-manifest",
    ]);

    expect(output).toContain("Soma feedback capture");
    expect(output).toContain("captured: yes");
    expect(output).toContain("kind: missed-surface");
    await expect(readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8")).resolves.toContain("feedback.candidate");
  });
});

test("cli warns when explicit feedback excerpt storage is enabled", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli(["install", "codex", "--apply", "--home-dir", homeDir]);

    const output = await runSomaCli([
      "feedback",
      "capture",
      "--home-dir",
      homeDir,
      "--text",
      "you missed the arc-manifest",
      "--store-excerpt",
    ]);

    expect(output).toContain("warning: --store-excerpt persists a best-effort redacted excerpt");
  });
});

test("cli rejects mixed feedback text inputs", async () => {
  await expect(runSomaCli(["feedback", "capture", "--text", "you missed this", "--stdin"])).rejects.toThrow("either --text or --stdin");
});

test("cli promotes Algorithm run memory", async () => {
  await withTempHome(async (homeDir) => {
    await runSomaCli([
      "algorithm",
      "new",
      "--home-dir",
      homeDir,
      "--id",
      "promote-run",
      "--prompt",
      "Promote this lesson",
      "--intent",
      "Make a reusable memory note.",
      "--current-state",
      "Lesson is only in work state.",
      "--goal",
      "Lesson is promoted into learning memory.",
      "--criterion",
      "C1:Promotion file exists.",
    ]);
    await runSomaCli([
      "algorithm",
      "verify",
      "--home-dir",
      homeDir,
      "--id",
      "promote-run",
      "--criterion-id",
      "C1",
      "--status",
      "passed",
      "--evidence",
      "Promotion file criteria verified.",
    ]);
    const output = await runSomaCli([
      "memory",
      "promote",
      "--home-dir",
      homeDir,
      "--substrate",
      "codex",
      "--from-run",
      "promote-run",
      "--store",
      "learning",
      "--title",
      "Promotion CLI lesson",
      "--lesson",
      "Promoted memories should be concise and searchable.",
      "--applies-when",
      "Recall when closing Algorithm runs.",
    ]);

    expect(output).toContain("Soma memory promotion created");
    expect(output).toContain("memory/LEARNING/PROMOTED/promotion-cli-lesson-promote-run.md");
    await expect(readFile(join(homeDir, ".soma/memory/LEARNING/PROMOTED/promotion-cli-lesson-promote-run.md"), "utf8")).resolves.toContain(
      "Promoted memories should be concise and searchable.",
    );
  });
});

test("cli checks private source policy", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli([
      "policy",
      "check",
      "--home-dir",
      homeDir,
      "--substrate",
      "codex",
      "--action",
      "write",
      "--destination",
      join(homeDir, "work/public.md"),
      "--content",
      `${join(homeDir, ".soma/memory/RELATIONSHIP/private.md")} should not be public.`,
    ]);

    expect(output).toContain("Soma policy check");
    expect(output).toContain("decision: deny");
    expect(output).toContain("private-marker");
  });
});

test("cli can emit policy checks as JSON without recording", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli([
      "policy",
      "check",
      "--home-dir",
      homeDir,
      "--action",
      "write",
      "--destination",
      join(homeDir, "work/public.md"),
      "--content",
      "Generic content.",
      "--record",
      "none",
      "--json",
    ]);
    const result = JSON.parse(output) as { decision: string; event?: unknown };

    expect(result.decision).toBe("allow");
    expect(result.event).toBeUndefined();
  });
});

test("cli rejects missing policy content env", async () => {
  await withTempHome(async (homeDir) => {
    await expect(
      runSomaCli([
        "policy",
        "check",
        "--home-dir",
        homeDir,
        "--action",
        "write",
        "--destination",
        join(homeDir, "work/public.md"),
        "--content-env",
        "SOMA_MISSING_POLICY_CONTENT",
      ]),
    ).rejects.toThrow("--content-env SOMA_MISSING_POLICY_CONTENT is not set.");
  });
});

test("cli rejects malformed policy targets env", async () => {
  await withTempHome(async (homeDir) => {
    process.env.SOMA_BAD_POLICY_TARGETS = "{";
    try {
      await expect(
        runSomaCli([
          "policy",
          "check",
          "--home-dir",
          homeDir,
          "--action",
          "write",
          "--targets-env",
          "SOMA_BAD_POLICY_TARGETS",
        ]),
      ).rejects.toThrow("--targets-env SOMA_BAD_POLICY_TARGETS must contain valid JSON targets.");
    } finally {
      delete process.env.SOMA_BAD_POLICY_TARGETS;
    }
  });
});

test("cli rejects non-array policy targets env", async () => {
  await withTempHome(async (homeDir) => {
    process.env.SOMA_BAD_POLICY_TARGETS = "{}";
    try {
      await expect(
        runSomaCli([
          "policy",
          "check",
          "--home-dir",
          homeDir,
          "--action",
          "write",
          "--targets-env",
          "SOMA_BAD_POLICY_TARGETS",
        ]),
      ).rejects.toThrow("--targets-env SOMA_BAD_POLICY_TARGETS must contain an array of targets with string filePath values and optional string content/sourcePath values.");
    } finally {
      delete process.env.SOMA_BAD_POLICY_TARGETS;
    }
  });
});

test("cli rejects malformed policy target fields", async () => {
  await withTempHome(async (homeDir) => {
    process.env.SOMA_BAD_POLICY_TARGETS = JSON.stringify([{ filePath: join(homeDir, "work/public.md"), content: {} }]);
    try {
      await expect(
        runSomaCli([
          "policy",
          "check",
          "--home-dir",
          homeDir,
          "--action",
          "write",
          "--targets-env",
          "SOMA_BAD_POLICY_TARGETS",
        ]),
      ).rejects.toThrow("--targets-env SOMA_BAD_POLICY_TARGETS must contain an array of targets with string filePath values and optional string content/sourcePath values.");
    } finally {
      delete process.env.SOMA_BAD_POLICY_TARGETS;
    }
  });
});

test("cli applies codex install only with explicit apply flag", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli(["install", "codex", "--apply", "--home-dir", homeDir]);

    expect(output).toContain("Soma install applied");
    expect(output).toContain(`somaHome: ${join(homeDir, ".soma")}`);
    expect(output).toContain(`substrateHome: ${join(homeDir, ".codex")}`);
    await expect(readFile(join(homeDir, ".soma/profile/assistant.md"), "utf8")).resolves.toContain("Name: soma");
    await expect(readFile(join(homeDir, ".codex/rules/soma.rules"), "utf8")).resolves.toContain("Soma default availability");
  });
});

test("cli dry-runs and applies pi.dev install", async () => {
  await withTempHome(async (homeDir) => {
    const dryRun = await runSomaCli(["install", "pi-dev", "--home-dir", homeDir]);

    expect(dryRun).toContain("substrate: pi-dev");
    expect(dryRun).toContain(join(homeDir, ".pi/agent/extensions/soma.ts"));
    expect(dryRun).toContain(join(homeDir, ".pi/agent/skills/soma/SKILL.md"));
    await expect(stat(join(homeDir, ".pi"))).rejects.toThrow();

    const output = await runSomaCli(["install", "pi-dev", "--apply", "--home-dir", homeDir]);

    expect(output).toContain("Soma install applied");
    expect(output).toContain(`substrate: pi-dev`);
    await expect(readFile(join(homeDir, ".pi/agent/extensions/soma.ts"), "utf8")).resolves.toContain("soma_context");
    await expect(readFile(join(homeDir, ".pi/agent/skills/soma/SKILL.md"), "utf8")).resolves.toContain("name: soma");
  });
});

test("cli rejects unsupported commands", async () => {
  await expect(runSomaCli(["install", "claude-code"])).rejects.toThrow("Usage:");
});
