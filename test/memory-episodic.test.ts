import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  parseMemoryNote,
  somaMemoryEventsPath,
  writeMemoryAction,
  writeSessionDigest,
} from "../src/index";
import {
  extractDigestBodyFromTranscript,
  writeSessionDigestFromTranscript,
} from "../src/adapters/claude-code/session-digest";
import { parseMemoryArgs, runMemoryCli } from "../src/cli/memory";

/** Build a JSONL transcript from a list of {user}/{assistant tool} lines. */
function transcript(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
function userLine(content: unknown, extra: object = {}): object {
  return { type: "user", message: { role: "user", content }, ...extra };
}
function assistantTool(name: string): object {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name }] } };
}
const SEVEN_PROMPTS = transcript([
  userLine("add a login endpoint"),
  assistantTool("Edit"),
  userLine("<command-name>/clear</command-name>"), // noise — filtered
  userLine([{ type: "tool_result", content: "x" }]), // tool result — filtered
  userLine("now add tests"),
  userLine("fix the bug", { isSidechain: true }), // sub-agent line — skipped
  userLine("handle the null case"),
  assistantTool("Bash"),
  userLine("run the linter"),
  userLine("commit and push"),
  userLine("update the changelog"),
]);

const NOW = new Date("2026-07-04T10:00:00.000Z");
const SESSION = "0afea4e4-967d-4a38-a855-0d12ac63c2f3";
const DIGEST_BODY = Array.from({ length: 10 }, (_, i) => `- line ${i + 1} of the session digest`).join("\n");

async function withTempSoma<T>(fn: (somaHome: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-episodic-"));
  const somaHome = join(dir, ".soma");
  try {
    return await fn(somaHome);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function countEvents(somaHome: string): Promise<number> {
  const content = await readFile(somaMemoryEventsPath(somaHome), "utf8").catch(() => "");
  return content.trim() === "" ? 0 : content.trim().split("\n").length;
}

// --- digest ------------------------------------------------------------------

test("writeSessionDigest writes an episodic assistant note under sessions/YYYY-MM", async () => {
  await withTempSoma(async (somaHome) => {
    const result = await writeSessionDigest({ somaHome, now: NOW, sessionId: SESSION, body: DIGEST_BODY });

    expect(result.created).toBe(true);
    expect(result.note.type).toBe("episodic");
    expect(result.note.trust).toBe("assistant");
    expect(result.note.id.startsWith("20260704-")).toBe(true);
    expect(result.path).toContain(join("memory", "episodic", "sessions", "2026-07"));

    const onDisk = parseMemoryNote(await readFile(result.path, "utf8"));
    expect(onDisk.id).toBe(result.note.id);
    expect(onDisk.body).toBe(DIGEST_BODY);
    expect(await countEvents(somaHome)).toBe(1);
  });
});

test("a digest body outside 8–15 non-empty lines is rejected", async () => {
  await withTempSoma(async (somaHome) => {
    const seven = Array.from({ length: 7 }, (_, i) => `line ${i}`).join("\n");
    const sixteen = Array.from({ length: 16 }, (_, i) => `line ${i}`).join("\n");
    await expect(writeSessionDigest({ somaHome, now: NOW, sessionId: SESSION, body: seven })).rejects.toThrow(/8–15/);
    await expect(writeSessionDigest({ somaHome, now: NOW, sessionId: SESSION, body: sixteen })).rejects.toThrow(/8–15/);
  });
});

test("a second digest for the same session no-ops with an event (exactly-one gate)", async () => {
  await withTempSoma(async (somaHome) => {
    const first = await writeSessionDigest({ somaHome, now: NOW, sessionId: SESSION, body: DIGEST_BODY });
    expect(first.created).toBe(true);

    const otherBody = Array.from({ length: 9 }, (_, i) => `- different line ${i}`).join("\n");
    const second = await writeSessionDigest({ somaHome, now: NOW, sessionId: SESSION, body: otherBody });
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);

    // the on-disk digest is unchanged (the first body survives)
    const onDisk = parseMemoryNote(await readFile(first.path, "utf8"));
    expect(onDisk.body).toBe(DIGEST_BODY);
    // one write event + one duplicate event
    expect(await countEvents(somaHome)).toBe(2);
  });
});

test("a session id with no slug-able characters still gets a hash-based id", async () => {
  await withTempSoma(async (somaHome) => {
    const result = await writeSessionDigest({ somaHome, now: NOW, sessionId: "!!!", body: DIGEST_BODY });
    expect(result.created).toBe(true);
    expect(result.note.id).toMatch(/^20260704-[0-9a-f]{8}$/); // date + hash only
  });
});

test("the same session digested on a LATER date is still recognized as a duplicate", async () => {
  await withTempSoma(async (somaHome) => {
    const first = await writeSessionDigest({ somaHome, now: NOW, sessionId: SESSION, body: DIGEST_BODY });
    expect(first.created).toBe(true);
    // a different UTC date — the gate must be date-independent
    const later = new Date("2026-09-15T10:00:00.000Z");
    const second = await writeSessionDigest({ somaHome, now: later, sessionId: SESSION, body: DIGEST_BODY });
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
  });
});

test("two distinct session ids that share a truncation prefix get separate digests (hash guard)", async () => {
  await withTempSoma(async (somaHome) => {
    // 32+ char prefixes identical; the appended full-id hash keeps them distinct
    const a = "session-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1";
    const b = "session-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-2";
    const first = await writeSessionDigest({ somaHome, now: NOW, sessionId: a, body: DIGEST_BODY });
    const second = await writeSessionDigest({ somaHome, now: NOW, sessionId: b, body: DIGEST_BODY });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true); // NOT a false duplicate
    expect(second.path).not.toBe(first.path);
  });
});

test("the duplicate scan fails CLOSED on an unreadable sessions path (no silent duplicate)", async () => {
  await withTempSoma(async (somaHome) => {
    // Put a FILE where the sessions directory should be → readdir throws ENOTDIR
    // (not ENOENT). The gate must refuse rather than treat it as "no digest yet".
    const sessions = join(somaHome, "memory", "episodic", "sessions");
    await mkdir(join(somaHome, "memory", "episodic"), { recursive: true });
    await writeFile(sessions, "not a directory", "utf8");
    await expect(writeSessionDigest({ somaHome, now: NOW, sessionId: SESSION, body: DIGEST_BODY })).rejects.toThrow(
      /could not scan session digests/,
    );
  });
});

// --- action ------------------------------------------------------------------

test("writeMemoryAction logs a plannedAction→approval→outcome note; session goes in the body, not project", async () => {
  await withTempSoma(async (somaHome) => {
    const result = await writeMemoryAction({
      somaHome,
      now: NOW,
      slug: "deploy-reporter",
      sessionId: SESSION,
      plannedAction: "Deploy the reporter service to production",
      approval: "approved",
      outcome: "Deployed; smoke test green",
    });

    expect(result.note.type).toBe("episodic");
    expect(result.note.id).toBe("20260704-deploy-reporter");
    // sessionId is recorded in the body, NOT project (project stays for real scope)
    expect(result.note.project).toBeNull();
    expect(result.path).toContain(join("memory", "episodic", "actions", "2026-07"));
    expect(result.note.body).toContain("**Planned action:** Deploy the reporter service to production");
    expect(result.note.body).toContain("**Approval:** approved");
    expect(result.note.body).toContain("**Outcome:** Deployed; smoke test green");
    expect(result.note.body).toContain(`**Session:** ${SESSION}`);
  });
});

test("an action with no outcome records a not-yet placeholder", async () => {
  await withTempSoma(async (somaHome) => {
    const result = await writeMemoryAction({ somaHome, now: NOW, slug: "pending-thing", plannedAction: "do a thing", approval: "proposed" });
    expect(result.note.body).toContain("**Outcome:** (not yet recorded)");
  });
});

test("a duplicate action id is refused (never overwrites)", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryAction({ somaHome, now: NOW, slug: "dup", plannedAction: "first", approval: "auto" });
    await expect(writeMemoryAction({ somaHome, now: NOW, slug: "dup", plannedAction: "second", approval: "auto" })).rejects.toThrow(
      /already exists/,
    );
  });
});

test("an invalid approval is rejected", async () => {
  await withTempSoma(async (somaHome) => {
    await expect(
      // @ts-expect-error — exercising the runtime guard with a bad approval
      writeMemoryAction({ somaHome, now: NOW, slug: "x", plannedAction: "y", approval: "maybe" }),
    ).rejects.toThrow(/approval must be/);
  });
});

// --- CLI ---------------------------------------------------------------------

test("parseMemoryArgs digest requires --session and --body", () => {
  expect(() => parseMemoryArgs(["memory", "digest", "--session", "s"])).toThrow(/--body/);
  expect(() => parseMemoryArgs(["memory", "digest", "--body", "b"])).toThrow(/--session/);
});

test("parseMemoryArgs action requires slug/planned-action/approval and validates approval", () => {
  expect(() => parseMemoryArgs(["memory", "action", "--slug", "s", "--planned-action", "i"])).toThrow(/--approval/);
  expect(() => parseMemoryArgs(["memory", "action", "--slug", "s", "--planned-action", "i", "--approval", "nope"])).toThrow(
    /--approval must be/,
  );
});

test("runMemoryCli digest reports written then no-op on a repeat", async () => {
  await withTempSoma(async (somaHome) => {
    const first = await runMemoryCli(
      parseMemoryArgs(["memory", "digest", "--session", SESSION, "--body", DIGEST_BODY, "--soma-home", somaHome]),
    );
    expect(first).toContain("Soma memory digest written");
    const second = await runMemoryCli(
      parseMemoryArgs(["memory", "digest", "--session", SESSION, "--body", DIGEST_BODY, "--soma-home", somaHome]),
    );
    expect(second).toContain("already exists (no-op)");
  });
});

test("runMemoryCli action logs an entry", async () => {
  await withTempSoma(async (somaHome) => {
    const out = await runMemoryCli(
      parseMemoryArgs([
        "memory", "action", "--slug", "ship-it", "--planned-action", "ship the feature", "--approval", "approved", "--soma-home", somaHome,
      ]),
    );
    expect(out).toContain("Soma memory action logged");
    // the CLI uses the real clock, so assert on the date-independent slug
    expect(out).toMatch(/id: \d{8}-ship-it/);
  });
});

// --- SessionEnd deterministic fallback (M5b) ---------------------------------

test("extractDigestBodyFromTranscript builds 8–15 lines from genuine prompts, filtering noise", () => {
  const body = extractDigestBodyFromTranscript(SEVEN_PROMPTS);
  expect(body).toBeDefined();
  const lines = body!.split("\n");
  expect(lines.length).toBeGreaterThanOrEqual(8);
  expect(lines.length).toBeLessThanOrEqual(15);
  expect(lines[0]).toContain("6 principal prompts"); // sidechain + command + tool_result excluded
  // prompt text is quoted + labeled (injection-safe), not a bare instruction line
  expect(body).toContain(`- principal prompt: "add a login endpoint"`);
  expect(body).toContain("- tools: "); // rollup line
  expect(body).not.toContain("/clear"); // command noise filtered
  expect(body).not.toContain("fix the bug"); // sidechain skipped
});

test("a fallback digest carries tool:claude-session-end provenance (not assistant conversation)", async () => {
  await withTempSoma((somaHome) =>
    withTranscriptFile(SEVEN_PROMPTS, async (tp) => {
      const result = await writeSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: SESSION, transcriptPath: tp });
      expect(result.digest!.note.provenance).toBe("tool:claude-session-end");
    }),
  );
});

test("extractDigestBodyFromTranscript returns undefined when too few genuine prompts", () => {
  const thin = transcript([userLine("only one real prompt"), assistantTool("Read")]);
  expect(extractDigestBodyFromTranscript(thin)).toBeUndefined();
});

test("extractDigestBodyFromTranscript samples head+tail when there are many prompts", () => {
  const many = transcript(Array.from({ length: 30 }, (_, i) => userLine(`prompt number ${i}`)));
  const body = extractDigestBodyFromTranscript(many)!;
  expect(body.split("\n").length).toBeLessThanOrEqual(15);
  expect(body).toContain("more prompts");
});

/** Write `content` to a temp .jsonl file, run `fn(path)`, then clean up. */
async function withTranscriptFile<T>(content: string, fn: (transcriptPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-tx-"));
  try {
    const tp = join(dir, "t.jsonl");
    await writeFile(tp, content, "utf8");
    return await fn(tp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writeSessionDigestFromTranscript writes a digest marked hook: session-end", async () => {
  await withTempSoma((somaHome) =>
    withTranscriptFile(SEVEN_PROMPTS, async (tp) => {
      const result = await writeSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: SESSION, transcriptPath: tp });
      expect(result.outcome).toBe("written");
      expect(result.digest!.note.hook).toBe("session-end");
      const onDisk = parseMemoryNote(await readFile(result.digest!.path, "utf8"));
      expect(onDisk.hook).toBe("session-end");
    }),
  );
});

test("a sub-agent invocation is suppressed and writes nothing (ADR 0014)", async () => {
  await withTempSoma((somaHome) =>
    withTranscriptFile(SEVEN_PROMPTS, async (tp) => {
      const result = await writeSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: SESSION, transcriptPath: tp, agentId: "agt-1" });
      expect(result.outcome).toBe("suppressed");
      expect(result.digest).toBeUndefined();
    }),
  );
});

test("forceSubagent suppresses even when forcePrimary is also set (precedence)", async () => {
  await withTempSoma((somaHome) =>
    withTranscriptFile(SEVEN_PROMPTS, async (tp) => {
      const result = await writeSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: SESSION, transcriptPath: tp, forcePrimary: true, forceSubagent: true });
      expect(result.outcome).toBe("suppressed");
    }),
  );
});

test("forcePrimary overrides sub-agent suppression", async () => {
  await withTempSoma((somaHome) =>
    withTranscriptFile(SEVEN_PROMPTS, async (tp) => {
      const result = await writeSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: SESSION, transcriptPath: tp, agentId: "agt-1", forcePrimary: true });
      expect(result.outcome).toBe("written");
    }),
  );
});

test("the fallback no-ops when an assistant-authored digest already exists", async () => {
  await withTempSoma((somaHome) =>
    withTranscriptFile(SEVEN_PROMPTS, async (tp) => {
      await writeSessionDigest({ somaHome, now: NOW, sessionId: SESSION, body: DIGEST_BODY }); // assistant-authored, no hook:
      const result = await writeSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: SESSION, transcriptPath: tp });
      expect(result.outcome).toBe("duplicate");
    }),
  );
});

test("an unreadable transcript reports 'unreadable' (distinct from a thin session) and never throws", async () => {
  await withTempSoma(async (somaHome) => {
    const result = await writeSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: SESSION, transcriptPath: "/no/such/transcript.jsonl" });
    expect(result.outcome).toBe("unreadable");
  });
});

test("parseMemoryArgs digest accepts --transcript and rejects --body + --transcript together", () => {
  const parsed = parseMemoryArgs(["memory", "digest", "--session", "s", "--transcript", "/t.jsonl"]);
  expect(parsed.options).toMatchObject({ mode: "transcript" });
  expect(() => parseMemoryArgs(["memory", "digest", "--session", "s", "--body", "b", "--transcript", "/t.jsonl"])).toThrow(/exactly one/);
});
