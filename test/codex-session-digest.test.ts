import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { parseMemoryNote, runSomaLifecycleSessionEnd } from "../src/index";
import {
  extractCodexDigestBodyFromTranscript,
  writeCodexSessionDigestFromTranscript,
} from "../src/adapters/codex/session-digest";

const NOW = new Date("2026-07-04T10:00:00.000Z");
const SESSION = "codex-session-1";

function transcript(lines: object[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function user(content: unknown, extra: object = {}): object {
  return { type: "user", message: { role: "user", content }, ...extra };
}

function assistantTool(name: string): object {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name }] } };
}

const CODEX_TRANSCRIPT = transcript([
  user("inspect the Codex lifecycle hook"),
  assistantTool("Read"),
  user("<command-name>/clear</command-name>"),
  user([{ type: "tool_result", content: "not principal input" }]),
  user("wire session-end transcript args"),
  user("ignore sidechain", { isSidechain: true }),
  user("add the Codex transcript digest adapter"),
  assistantTool("Edit"),
  user("cover duplicate behavior"),
  user("cover path traversal"),
  user("update docs"),
]);

async function withTempSoma<T>(fn: (paths: { root: string; somaHome: string; transcriptRoot: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "soma-codex-digest-"));
  try {
    const paths = { root, somaHome: join(root, ".soma"), transcriptRoot: join(root, ".codex", "sessions") };
    await mkdir(paths.transcriptRoot, { recursive: true });
    return await fn(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("extractCodexDigestBodyFromTranscript extracts principal prompts and tool rollup", () => {
  const body = extractCodexDigestBodyFromTranscript(CODEX_TRANSCRIPT)!;
  const lines = body.split("\n");

  expect(lines).toHaveLength(8);
  expect(lines[0]).toContain("6 principal prompts");
  expect(body).toContain(`- principal prompt: "inspect the Codex lifecycle hook"`);
  expect(body).toContain("- tools: Editx1, Readx1");
  expect(body).not.toContain("/clear");
  expect(body).not.toContain("tool_result");
  expect(body).not.toContain("ignore sidechain");
});

test("writeCodexSessionDigestFromTranscript writes once and duplicates no-op", async () => {
  await withTempSoma(async ({ somaHome, transcriptRoot }) => {
    const transcriptPath = join(transcriptRoot, `${SESSION}.jsonl`);
    await writeFile(transcriptPath, CODEX_TRANSCRIPT, "utf8");

    const first = await writeCodexSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: SESSION, transcriptPath, transcriptRoot });
    const second = await writeCodexSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: SESSION, transcriptPath, transcriptRoot });
    const onDisk = parseMemoryNote(await readFile(first.digest!.path, "utf8"));

    expect(first.outcome).toBe("written");
    expect(first.digest!.note.provenance).toBe("tool:codex-session-end");
    expect(first.digest!.note.hook).toBe("session-end");
    expect(second.outcome).toBe("duplicate");
    expect(second.digest).toBeUndefined();
    expect(onDisk.provenance).toBe("tool:codex-session-end");
  });
});

test("writeCodexSessionDigestFromTranscript skips short transcripts without error", async () => {
  await withTempSoma(async ({ somaHome, transcriptRoot }) => {
    const transcriptPath = join(transcriptRoot, "thin.jsonl");
    await writeFile(transcriptPath, transcript([user("one prompt"), assistantTool("Read")]), "utf8");

    const result = await writeCodexSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: "thin", transcriptPath, transcriptRoot });

    expect(result.outcome).toBe("skipped");
  });
});

test("writeCodexSessionDigestFromTranscript refuses traversal and final symlinks", async () => {
  await withTempSoma(async ({ root, somaHome, transcriptRoot }) => {
    const outside = join(root, "outside.jsonl");
    const link = join(transcriptRoot, "link.jsonl");
    await writeFile(outside, CODEX_TRANSCRIPT, "utf8");
    await symlink(outside, link);

    const escaped = await writeCodexSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: "escape", transcriptPath: outside, transcriptRoot });
    const linked = await writeCodexSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: "link", transcriptPath: link, transcriptRoot });

    expect(escaped.outcome).toBe("refused");
    expect(linked.outcome).toBe("refused");
  });
});

test("writeCodexSessionDigestFromTranscript refuses nested transcript paths by default", async () => {
  await withTempSoma(async ({ somaHome, transcriptRoot }) => {
    const nestedRoot = join(transcriptRoot, "nested");
    const transcriptPath = join(nestedRoot, "nested.jsonl");
    await mkdir(nestedRoot, { recursive: true });
    await writeFile(transcriptPath, CODEX_TRANSCRIPT, "utf8");

    const result = await writeCodexSessionDigestFromTranscript({ somaHome, now: NOW, sessionId: "nested", transcriptPath, transcriptRoot });

    expect(result.outcome).toBe("refused");
  });
});

test("lifecycle session-end registers Codex fallback and reports digest outcome", async () => {
  await withTempSoma(async ({ root, somaHome, transcriptRoot }) => {
    const transcriptPath = join(transcriptRoot, `${SESSION}.jsonl`);
    await writeFile(transcriptPath, CODEX_TRANSCRIPT, "utf8");

    const result = await runSomaLifecycleSessionEnd({
      homeDir: root,
      somaHome,
      substrate: "codex",
      sessionId: SESSION,
      transcriptPath,
      timestamp: NOW.toISOString(),
    });
    const events = await readFile(join(somaHome, "memory", "STATE", "events.jsonl"), "utf8");

    expect(result.files.some((file) => file.includes(join("memory", "episodic", "sessions")))).toBe(true);
    expect(events).toContain("digest: written");
  });
});
