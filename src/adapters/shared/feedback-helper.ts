import {
  SOMA_FEEDBACK_AUTOMATIC_HOOK_TRIGGER_PATTERN_SOURCE,
  SOMA_FEEDBACK_MACHINE_PROMPT_PREFIXES,
  SOMA_FEEDBACK_STDIN_MAX_BYTES,
} from "../../feedback-contract";

interface FeedbackHookHelperOptions {
  functionName: string;
  exported?: boolean;
  leadingParameters?: string[];
  promptParameter: string;
  promptType?: string;
  // Trailing parameter holding the raw hook input; its `session_id` and
  // `transcript_path` are forwarded when present. The transcript is never read.
  hookInputParameter?: string;
  // JS expression true for a headless (SDK-driven) run; actor becomes `sdk`.
  headlessExpression?: string;
  bunPathExpression: string;
  cwdExpression: string;
  somaHomeExpression: string;
  substrate: string;
  source: string;
  failureComment: string;
}

export function renderFeedbackHookHelper(options: FeedbackHookHelperOptions): string {
  const promptDeclaration = options.promptType ? `${options.promptParameter}: ${options.promptType}` : options.promptParameter;
  const hookInputDeclaration = options.hookInputParameter
    ? [options.promptType ? `${options.hookInputParameter}?: unknown` : options.hookInputParameter]
    : [];
  const parameters = [...(options.leadingParameters ?? []), promptDeclaration, ...hookInputDeclaration].join(", ");
  const hookInputRecordType = options.promptType ? ": Record<string, unknown>" : "";
  // soma#785 Q13: a ranger worker is `automated`, a headless run `sdk`.
  const actorExpression = options.headlessExpression
    ? `process.env.RANGER_JOURNAL_PATH ? "automated" : (${options.headlessExpression}) ? "sdk" : "interactive"`
    : `process.env.RANGER_JOURNAL_PATH ? "automated" : "interactive"`;
  const returnType = options.promptType ? ": void" : "";

  return [
    `const SOMA_FEEDBACK_TRIGGER_PATTERN_SOURCE = ${JSON.stringify(SOMA_FEEDBACK_AUTOMATIC_HOOK_TRIGGER_PATTERN_SOURCE)};`,
    'const SOMA_FEEDBACK_TRIGGER_PATTERN = new RegExp(SOMA_FEEDBACK_TRIGGER_PATTERN_SOURCE, "i");',
    `const SOMA_FEEDBACK_STDIN_MAX_BYTES = ${SOMA_FEEDBACK_STDIN_MAX_BYTES};`,
    `const SOMA_FEEDBACK_MACHINE_PROMPT_PREFIXES = ${JSON.stringify(SOMA_FEEDBACK_MACHINE_PROMPT_PREFIXES)};`,
    "let somaFeedbackCaptureInFlight = false;",
    "",
    `${options.exported ? "export " : ""}function ${options.functionName}(${parameters})${returnType} {`,
    `\tconst rawFeedbackText = typeof ${options.promptParameter} === "string" ? ${options.promptParameter} : "";`,
    "\tconst candidateFeedbackText = rawFeedbackText.length > SOMA_FEEDBACK_STDIN_MAX_BYTES ? rawFeedbackText.slice(0, SOMA_FEEDBACK_STDIN_MAX_BYTES) : rawFeedbackText;",
    "\tif (!candidateFeedbackText.trim() || !SOMA_FEEDBACK_TRIGGER_PATTERN.test(candidateFeedbackText)) return;",
    "\t// Machine-authored prompts (task notifications, pastes) are not the principal's feedback.",
    "\tconst leadingFeedbackText = candidateFeedbackText.trimStart();",
    "\tif (SOMA_FEEDBACK_MACHINE_PROMPT_PREFIXES.some((prefix) => leadingFeedbackText.startsWith(prefix))) return;",
    "\tconst encodedFeedbackText = new TextEncoder().encode(candidateFeedbackText);",
    "\tconst feedbackText = encodedFeedbackText.byteLength > SOMA_FEEDBACK_STDIN_MAX_BYTES ? new TextDecoder().decode(encodedFeedbackText.slice(0, SOMA_FEEDBACK_STDIN_MAX_BYTES)) : candidateFeedbackText;",
    "\tif (somaFeedbackCaptureInFlight) return;",
    "\tconst feedbackInput = feedbackText;",
    "\ttry {",
    "\t\tsomaFeedbackCaptureInFlight = true;",
    `\t\tconst feedbackActor = ${actorExpression};`,
    // 2026-07-10 proxy-drift audit: --no-excerpt made every captured event
    // content-free (promptStored:false, excerptStored:false) — a counter that
    // could never teach anything. Excerpts are best-effort redacted by
    // redactedFeedbackExcerpt (src/feedback.ts); capture without content is
    // cost without signal, so excerpt storage is now the default.
    `\t\tconst feedbackArgs =["run", "soma", "feedback", "capture", "--soma-home", ${options.somaHomeExpression}, "--substrate", ${JSON.stringify(options.substrate)}, "--source", ${JSON.stringify(options.source)}, "--stdin", "--store-excerpt", "--actor", feedbackActor];`,
    ...(options.hookInputParameter
      ? [
          `\t\tconst feedbackHookInput${hookInputRecordType} = ${options.hookInputParameter} && typeof ${options.hookInputParameter} === "object" ? ${options.promptType ? `${options.hookInputParameter} as Record<string, unknown>` : options.hookInputParameter} : {};`,
          '\t\tfor (const [key, flag] of [["session_id", "--session-id"], ["transcript_path", "--transcript-path"]]) {',
          "\t\t\tconst value = feedbackHookInput[key];",
          "\t\t\t// Absent or flag-shaped values are omitted, never sent as empty strings.",
          '\t\t\tif (typeof value === "string" && value.trim().length > 0 && !value.startsWith("-")) feedbackArgs.push(flag, value);',
          "\t\t}",
        ]
      : []),
    `\t\tconst child = spawn(${options.bunPathExpression}, feedbackArgs, {`,
    `\t\t\tcwd: ${options.cwdExpression},`,
    "\t\t\t// soma#73 follow-up, verified on Windows during grok U7: without",
    "\t\t\t// detached:true the capture child dies when the hook parent exits",
    "\t\t\t// before it finishes (the explicit bunPath alone is not enough on",
    "\t\t\t// win32). Same pattern as claude-code's spawnDetached.",
    "\t\t\tdetached: true,",
    '\t\t\tstdio: ["pipe", "ignore", "ignore"]',
    "\t\t});",
    '\t\tchild.stdin?.on("error", () => undefined);',
    "\t\tlet forceTimer;",
    "\t\tlet finished = false;",
    "\t\tconst finish = () => {",
    "\t\t\tif (finished) return;",
    "\t\t\tfinished = true;",
    "\t\t\tclearTimeout(timer);",
    "\t\t\tif (forceTimer) clearTimeout(forceTimer);",
    "\t\t\tsomaFeedbackCaptureInFlight = false;",
    "\t\t};",
    "\t\tconst timer = setTimeout(() => {",
    "\t\t\tforceTimer = setTimeout(finish, 1000);",
    "\t\t\tforceTimer.unref?.();",
    "\t\t\tchild.kill();",
    "\t\t}, 3000);",
    "\t\ttimer.unref?.();",
    '\t\tchild.on("error", finish);',
    '\t\tchild.on("exit", finish);',
    "\t\ttry {",
    "\t\t\tif (!child.stdin?.destroyed) child.stdin?.end(feedbackInput);",
    "\t\t} catch {",
    "\t\t\tchild.kill();",
    "\t\t\tfinish();",
    "\t\t}",
    "\t\tchild.unref();",
    "\t} catch {",
    "\t\tsomaFeedbackCaptureInFlight = false;",
    `\t\t// ${options.failureComment}`,
    "\t}",
    "}",
  ].join("\n");
}

export function renderFeedbackHookModule(options: FeedbackHookHelperOptions): string {
  return [
    'import { spawn } from "node:child_process";',
    'import { clearTimeout, setTimeout } from "node:timers";',
    "",
    renderFeedbackHookHelper({ ...options, exported: true }),
    "",
  ].join("\n");
}
