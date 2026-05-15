import { SOMA_FEEDBACK_HOOK_TRIGGER_PATTERN_SOURCE, SOMA_FEEDBACK_STDIN_MAX_BYTES } from "../feedback-contract";

interface FeedbackHookHelperOptions {
  functionName: string;
  exported?: boolean;
  leadingParameters?: string[];
  promptParameter: string;
  promptType?: string;
  bunPathExpression: string;
  cwdExpression: string;
  somaHomeExpression: string;
  substrate: string;
  source: string;
  failureComment: string;
}

export function renderFeedbackHookHelper(options: FeedbackHookHelperOptions): string {
  const promptDeclaration = options.promptType ? `${options.promptParameter}: ${options.promptType}` : options.promptParameter;
  const parameters = [...(options.leadingParameters ?? []), promptDeclaration].join(", ");
  const returnType = options.promptType ? ": void" : "";

  return [
    `const SOMA_FEEDBACK_TRIGGER_PATTERN_SOURCE = ${JSON.stringify(SOMA_FEEDBACK_HOOK_TRIGGER_PATTERN_SOURCE)};`,
    'const SOMA_FEEDBACK_TRIGGER_PATTERN = new RegExp(SOMA_FEEDBACK_TRIGGER_PATTERN_SOURCE, "i");',
    `const SOMA_FEEDBACK_STDIN_MAX_CHARS = ${SOMA_FEEDBACK_STDIN_MAX_BYTES};`,
    "let somaFeedbackCaptureInFlight = false;",
    "",
    `${options.exported ? "export " : ""}function ${options.functionName}(${parameters})${returnType} {`,
    `\tconst rawFeedbackText = typeof ${options.promptParameter} === "string" ? ${options.promptParameter} : "";`,
    "\tconst feedbackText = rawFeedbackText.length > SOMA_FEEDBACK_STDIN_MAX_CHARS ? rawFeedbackText.slice(0, SOMA_FEEDBACK_STDIN_MAX_CHARS) : rawFeedbackText;",
    "\tif (!feedbackText.trim() || !SOMA_FEEDBACK_TRIGGER_PATTERN.test(feedbackText)) return;",
    "\tif (somaFeedbackCaptureInFlight) return;",
    "\tconst feedbackInput = feedbackText;",
    "\ttry {",
    "\t\tsomaFeedbackCaptureInFlight = true;",
    `\t\tconst child = spawn(${options.bunPathExpression}, ["run", "soma", "feedback", "capture", "--soma-home", ${options.somaHomeExpression}, "--substrate", ${JSON.stringify(options.substrate)}, "--source", ${JSON.stringify(options.source)}, "--stdin", "--no-excerpt"], {`,
    `\t\t\tcwd: ${options.cwdExpression},`,
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
