import { expect, test } from "bun:test";
import { portableProjectionInput } from "./fixtures";
import { projectPiDevHome } from "../src/adapters/pi-dev/adapter";

/**
 * soma#475: entering a message in Pi.dev froze for 2-6s because
 * `before_agent_start` ran two blocking `spawnSync` calls — a full session-start
 * lifecycle plus `soma algorithm classify`.
 *
 * These tests pin the message path as subprocess-free. PR #476 (closed) is the
 * cautionary tale: it shipped a generated extension that did not even parse, so
 * the transpile assertion below is deliberately paired with behavioural ones.
 */

function extension(): string {
  const projection = projectPiDevHome(portableProjectionInput, "/tmp/soma-home");

  return projection.files.find((file) => file.path === "agent/extensions/soma.ts")?.content ?? "";
}

/** Slices one `pi.on("<event>", ...)` handler body out of the generated source. */
function handlerBody(source: string, event: string): string {
  const start = source.indexOf(`pi.on("${event}"`);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.indexOf("\tpi.on(");
  const end = next === -1 ? rest.indexOf("\tpi.registerTool(") : next;

  return end === -1 ? rest : rest.slice(0, end);
}

test("generated pi.dev extension parses", () => {
  expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(extension())).not.toThrow();
});

test("no synchronous child process calls remain anywhere in the extension", () => {
  const source = extension();

  // Comments legitimately mention the old approach; code must not use it.
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  expect(code).not.toContain("spawnSync");
  expect(source).not.toContain('import { execFile, spawn, spawnSync }');
});

test("before_agent_start spawns no subprocess — the message path is local only", () => {
  const body = handlerBody(extension(), "before_agent_start");

  expect(body).not.toContain("runSomaLifecycleAsync");
  expect(body).not.toContain("refreshStartupContext");
  expect(body).not.toContain("execFileAsync");
  expect(body).not.toContain("runSomaCommand");
  // Classification is a plain local call now, not a cached value from a prior turn.
  expect(body).toContain("renderPromptClassificationContext(prompt)");
  expect(body).toContain("cachedStartupContext");
});

test("classification is computed for the current prompt, not deferred a turn", () => {
  const source = extension();

  // The projected classifier is present and called directly.
  expect(source).toContain("function classifyAlgorithmPrompt(");
  expect(source).toContain("const classification = classifyAlgorithmPrompt(prompt);");

  // A turn_end classification cache would reintroduce the off-by-one that made
  // every message carry the PREVIOUS message's mode. It must not come back.
  expect(source).not.toContain("cachedClassification");
  expect(source).not.toContain('pi.on("turn_end"');
  expect(source).not.toContain('"classify"');
});

test("promisified execFile success is not tested via result.status", () => {
  const code = extension()
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // promisify(execFile) resolves { stdout, stderr }; `status` is always
  // undefined, so `result.status === 0` silently disables its caller.
  expect(code).not.toContain("result.status");
});

test("work index refreshes are deferred and coalesced", () => {
  const source = extension();

  expect(source).toContain("let workIndexInFlight = false;");
  expect(source).toContain("let workIndexPending = false;");
  expect(source).toContain("function scheduleWorkIndexRefresh()");
  expect(source).toContain("setImmediate(");

  for (const event of ["tool_execution_end", "agent_end", "session_before_compact"]) {
    expect(handlerBody(source, event)).toContain("scheduleWorkIndexRefresh()");
  }
});

test("session_shutdown awaits session-end capture", () => {
  const body = handlerBody(extension(), "session_shutdown");

  // Fire-and-forget loses the record: shutdown kills the child mid-write.
  expect(body).toContain("await captureSessionEnd(sessionId(ctx))");
  expect(extension()).toContain("async function captureSessionEnd(");
});

test("startup context is cached once at session_start and reused", () => {
  const source = extension();

  expect(source).toContain('let cachedStartupContext = "";');
  expect(handlerBody(source, "session_start")).toContain("cachedStartupContext = await refreshStartupContext(sessionId(ctx));");
});
