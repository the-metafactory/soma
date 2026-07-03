import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  parseMemoryNote,
  somaMemoryEventsPath,
  writeMemoryAction,
  writeSessionDigest,
} from "../src/index";
import { parseMemoryArgs, runMemoryCli } from "../src/cli/memory";

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
