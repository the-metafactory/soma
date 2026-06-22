/**
 * Post-install smoke of the frozen grok hook command.
 *
 * Grok's hook platform is fail-open: a hook command that
 * cannot launch is not an error — the tool call is silently allowed,
 * disabling Soma's only Windows policy gate. Install validates the bun
 * path INGREDIENT before it is frozen; this module proves the frozen
 * PRODUCT — the exact registered command string, read back from the
 * `soma-lifecycle.json` the projection wrote (single producer: the
 * installed file IS the source, nothing is re-derived by hand) — by
 * spawning it with a benign Shell input and requiring the documented
 * allow shape. One spawn end-to-end proves the interpreter path, the
 * module path, the colocated config load, and the verb dispatch.
 *
 * Runs on apply paths only: `planSomaForGrokInstall` is a pure plan
 * and never executes post-projection steps.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Matches GROK_HOOK_TIMEOUT_SECONDS (the registration's own timeout):
// generous enough that transient spawn load (the AC-2 class) does not
// flake an install, tight enough that a hung hook still aborts it.
const GROK_HOOK_SMOKE_TIMEOUT_MS = 30_000;

function smokeFailure(command: string, detail: string): Error {
  return new Error(
    [
      "soma install grok: the installed hook command failed its post-install smoke test.",
      "",
      `  command: ${command}`,
      `  failure: ${detail}`,
      "",
      "Grok's hook platform is fail-open: if this command cannot launch and allow a",
      "benign call, the live policy gate would be silently disabled. The install is",
      "NOT complete. Fix the cause (usually the bun interpreter path) and re-run",
      "`soma install grok` / `soma reproject grok` under a native Windows shell, or",
      "set SOMA_BUN_PATH to the absolute native path of bun.exe.",
    ].join("\n"),
  );
}

/** The registered PreToolUse command, read from the installed registration. */
export async function readInstalledGrokPreToolUseCommand(substrateHome: string): Promise<string> {
  const registrationPath = join(substrateHome, "hooks", "soma-lifecycle.json");
  const content = await readFile(registrationPath, "utf8");
  const parsed = JSON.parse(content) as {
    hooks?: { PreToolUse?: { hooks?: { command?: unknown }[] }[] };
  };
  const command = parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw smokeFailure(registrationPath, "no PreToolUse command found in the hook registration");
  }
  return command;
}

/**
 * Spawn the exact frozen PreToolUse command with a benign Shell input
 * (`Get-Date`) and require `{"decision":"allow"}` + exit 0. Throws an
 * install-blocking error with the command and its output otherwise.
 */
export async function smokeTestInstalledGrokHookCommand(substrateHome: string): Promise<void> {
  const command = await readInstalledGrokPreToolUseCommand(substrateHome);
  // The single-space split mirrors grok's own bare-exec spawn:
  // bareExecSafeHookToken guarantees no token contains whitespace, so
  // the joined string round-trips losslessly.
  const argv = command.split(" ");
  if (argv.length < 3) {
    throw smokeFailure(command, `expected the 3-token bare-exec shape, got ${argv.length} token(s)`);
  }

  const payload = JSON.stringify({
    hookEventName: "pre_tool_use",
    sessionId: "soma-grok-install-smoke",
    toolName: "Shell",
    toolInput: { command: "Get-Date", description: "soma install grok post-install smoke probe" },
    cwd: substrateHome,
  });

  const result = spawnSync(argv[0]!, argv.slice(1), {
    input: payload,
    encoding: "utf8",
    timeout: GROK_HOOK_SMOKE_TIMEOUT_MS,
    windowsHide: true,
  });

  if (result.error) {
    throw smokeFailure(command, `spawn failed: ${String(result.error)}`);
  }
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (result.status !== 0) {
    throw smokeFailure(
      command,
      `exit ${result.status}${stdout ? `; stdout: ${stdout}` : ""}${stderr ? `; stderr: ${stderr}` : ""}`,
    );
  }
  let decision: unknown;
  try {
    decision = (JSON.parse(stdout) as { decision?: unknown }).decision;
  } catch {
    throw smokeFailure(command, `stdout is not the documented JSON contract: ${stdout || "(empty)"}`);
  }
  if (decision !== "allow") {
    throw smokeFailure(command, `expected {"decision":"allow"} for a benign probe, got: ${stdout}`);
  }
}
