import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appendSomaMemoryEvent } from "./memory";
import { createPaths } from "./paths";
import { hasSomaPolicyPrivateMarker, somaPolicyPrivateMarkers } from "./policy";
import { inference } from "./tools/inference";
import type {
  RuntimePolicyCommandInspectionConfig,
  RuntimePolicyConfigChange,
  RuntimePolicyModelInspectorConfig,
  RuntimePolicyModelRule,
  RuntimePolicyPermissionConfig,
  RuntimePolicyPermissionRequest,
  RuntimePolicyDecision,
  RuntimePolicyFinding,
  RuntimePolicyInspectAudit,
  RuntimePolicyInspectOptions,
  RuntimePolicyInspectResult,
  RuntimePolicySurface,
} from "./types";

const PROMPT_INSPECTOR_ID = "soma-deterministic-prompt-v0";
const COMMAND_INSPECTOR_ID = "soma-deterministic-command-v0";
const CONFIG_INSPECTOR_ID = "soma-deterministic-config-v0";
const PERMISSION_INSPECTOR_ID = "soma-deterministic-permission-v0";
const MODEL_INSPECTOR_ID = "soma-model-backed-runtime-policy-v0";
const INPUT_INSPECTOR_ID = "soma-runtime-input-v0";

const DEFAULT_OUTBOUND_TOOLS = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "lftp",
  "fetch",
  "aria2c",
  "http",
  "https",
  "xh",
] as const;

const DEFAULT_CREDENTIAL_PATH_PATTERNS = [
  "(^|/)\\.env(\\.|$|/)?",
  "(^|/)id_(rsa|dsa|ecdsa|ed25519)$",
  "\\.(pem|p12|pfx|key)$",
  "(^|/)\\.aws/credentials$",
  "(^|/)\\.docker/config\\.json$",
  "(^|/)\\.kube/config$",
  "(^|/)credentials(\\.json)?$",
  "private[_-]?key",
] as const;

const DEFAULT_PERMISSION_SENSITIVE_PATH_PATTERNS = [
  "(^|/)\\.env(\\.|$|/)?",
  "(^|/)\\.ssh($|/)",
  "(^|/)\\.aws/credentials$",
  "(^|/)\\.docker/config\\.json$",
  "(^|/)\\.kube/config$",
  "(^|/)id_(rsa|dsa|ecdsa|ed25519)$",
  "\\.(pem|p12|pfx|key)$",
] as const;

const INLINE_INTERPRETER_PATTERN = /\b(?:python|python3|node|ruby|perl|bun)\s+-(?:c|e)\b/u;

/**
 * Signal, not presence.
 *
 * These heuristics used to fire on the mere APPEARANCE of a keyword, which
 * cannot distinguish talking ABOUT security from ASKING to defeat it. Measured
 * on real security-engineering prose, 4 of 10 legitimate sentences tripped
 * `security-disable-request` — including "I did not bypass the hook", "never
 * disable the guard", and "do not remove the policy check". That profile is
 * self-defeating: it fires hardest on sentences stating the CORRECT stance, so
 * the more carefully the work is done, the more it is blocked.
 *
 * Two narrowings, applied together:
 *   - POLARITY: a negator shortly before the verb inverts the meaning.
 *   - FORM: only the bare imperative/infinitive is a request. Inflected forms
 *     ("disables", "was disabled", "the disabled branch", "bypassing") are
 *     descriptions of a system, not instructions to the assistant.
 *
 * Both keep every attack phrasing flagged — see the regression tests.
 */
const NEGATION_WINDOW = 40;
const NEGATOR_PATTERN =
  /\b(?:not|never|n't|without|refus\w*|declin\w*|avoid\w*|cannot|instead of|rather than)\b/u;

/** True when `verb` at `index` is negated by something shortly before it. */
function isNegated(text: string, index: number): boolean {
  return NEGATOR_PATTERN.test(text.slice(Math.max(0, index - NEGATION_WINDOW), index));
}

/**
 * A blank line ends the thought. Proximity is a proxy for "these words are
 * about each other", and that proxy dies at a paragraph break: two adjacent
 * blocks can be about entirely different things.
 *
 * The case that forced this: soma's own `CONTEXT.md` ends a paragraph with the
 * noun "…hides bypass paths." and opens the next section with the heading
 * "## Inbound security config". Sixty characters apart, zero relationship — and
 * the resulting `security-disable-request` denied every prompt carrying that
 * file, which is how sage's Architecture and ContextDrift lenses came to fail on
 * every review round for months while reporting it as a model contract
 * deviation.
 *
 * A single newline is NOT a boundary: prose wraps, and "please bypass\nthe
 * security guard" is one sentence and one request.
 */
const BLOCK_BOUNDARY = /\n[ \t]*\n/u;

/**
 * Match `verbPattern` (bare forms only) followed by `targetPattern` within
 * `window` chars **of the same block**, rejecting negated occurrences. Returns
 * false when the phrase is a description or a refusal rather than a request.
 */
function hasUnnegatedRequest(
  normalized: string,
  verbPattern: RegExp,
  targetPattern: RegExp,
  window = 60,
): boolean {
  const verb = new RegExp(verbPattern.source, "gu");
  for (let m = verb.exec(normalized); m !== null; m = verb.exec(normalized)) {
    if (isNegated(normalized, m.index)) continue;
    const lookahead = normalized.slice(m.index, m.index + m[0].length + window);
    const boundary = lookahead.search(BLOCK_BOUNDARY);
    const sameBlock = boundary === -1 ? lookahead : lookahead.slice(0, boundary);
    if (targetPattern.test(sameBlock)) return true;
  }
  return false;
}

const COMMON_SECURITY_CONFIG_KEYS = [
  "hooks",
  "permissions",
  "env",
  "mcpServers",
  "runtimePolicy",
  "policy",
  "tools",
  "extensions",
] as const;

const SUBSTRATE_SECURITY_CONFIG_KEYS = {
  codex: ["hooks", "hooksJson", "config.hooks", "tools", "sandbox", "network", "approvalPolicy"],
  "claude-code": ["hooks", "permissions", "mcpServers", "env"],
  "pi-dev": ["extensions", "toolGuard", "policyCheck", "runtimePolicy"],
  cursor: ["rules", "mcpServers", "tools"],
  // Grok config surfaces that are security-relevant to inspect: the
  // user-level hooks tree plus the `~/.grok/config.toml` tables Grok
  // actually honors. U9 (policy enforcement) refines these against the
  // live config schema; this is data, not an enforcement claim.
  grok: ["hooks", "mcp_servers", "permission", "plugins"],
  // DSH config surfaces that are security-relevant to inspect: the profile's
  // plugin-bundle composition (package.json `dsh.profile.bundles`), the
  // cordis patch layers that can insert/disable rows, and the client-plugin
  // service injection. This is data, not an enforcement claim.
  dsh: ["bundles", "cordis.patch", "plugins", "inject", "permissions"],
  "anthropic-cowork": [],
  cortex: ["dispatcher", "artifactIngress", "taskRouting", "capabilities"],
  custom: [],
} as const;

export function runtimePolicyTraceRoot(options: Pick<RuntimePolicyInspectOptions, "homeDir" | "somaHome"> = {}): string {
  return createPaths(options).resolve("memory", "SECURITY", "runtime-policy");
}

function inputHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function finding(kind: string, severity: RuntimePolicyFinding["severity"], detail: string, inspector: string, decision?: RuntimePolicyFinding["decision"]): RuntimePolicyFinding {
  return { kind, severity, detail, inspector, ...(decision ? { decision } : {}) };
}

function inspectPrompt(prompt: string): RuntimePolicyFinding[] {
  const findings: RuntimePolicyFinding[] = [];
  const normalized = prompt.toLowerCase();

  if (
    hasUnnegatedRequest(
      normalized,
      /\b(?:disable|turn off|bypass|remove)\b/u,
      /\b(?:soma\s+)?(?:security|policy|guard|hook)s?\b/u,
    )
  ) {
    findings.push(finding("security-disable-request", "high", "Prompt asks to disable or bypass Soma runtime policy.", PROMPT_INSPECTOR_ID));
  }
  if (/\b(ignore|override)\s+(all\s+)?(previous|prior|system|developer)\s+instructions\b/u.test(normalized)) {
    findings.push(finding("instruction-override", "high", "Prompt attempts to override higher-priority instructions.", PROMPT_INSPECTOR_ID));
  }
  if (
    hasUnnegatedRequest(
      normalized,
      /\b(?:reveal|print|dump|exfiltrate|leak|steal)\b/u,
      /\b(?:private memory|secret|token|credential|private key)s?\b/u,
    )
  ) {
    findings.push(finding("data-exfiltration-intent", "high", "Prompt requests private memory or credential disclosure.", PROMPT_INSPECTOR_ID));
  }
  if (/\b(jailbreak|do anything now|roleplay as|pretend to be unrestricted)\b/u.test(normalized)) {
    findings.push(finding("jailbreak-language", "medium", "Prompt contains ambiguous jailbreak language.", PROMPT_INSPECTOR_ID));
  }

  return findings;
}

function commandFromToolCall(options: RuntimePolicyInspectOptions): string | undefined {
  const input = options.toolCall?.input;
  if (!input) return undefined;
  const candidate = input.command ?? input.cmd ?? input.script;
  return typeof candidate === "string" ? candidate : undefined;
}

function cleanShellToken(token: string): string {
  // Bounded token cleanup for policy signals, not full shell syntax. This may
  // simplify process-substitution tokens; docs keep that outside guarantees.
  return token.replace(/^[<>"']+|[>"']+$/g, "");
}

function tokenizeCommand(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|&&|\|\||[|;<>]{1,2}|[^\s|;<>]+/gu)]
    .map((match) => cleanShellToken(match[1] || match[2] || match[0]))
    .filter(Boolean);
}

function isShellOperator(token: string): boolean {
  return token === "&&" || token === "||" || token === "|" || token === ";";
}

function shellSegments(tokens: string[]): { tokens: string[]; operatorAfter?: string }[] {
  const segments: { tokens: string[]; operatorAfter?: string }[] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (isShellOperator(token)) {
      if (current.length > 0) segments.push({ tokens: current, operatorAfter: token });
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push({ tokens: current });
  return segments;
}

function shellCommandName(token: string | undefined): string {
  return (token ?? "").split("/").pop()?.toLowerCase() ?? "";
}

function skipCommandPrefixes(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token) || ["command", "exec", "time", "nice", "nohup"].includes(token)) {
      index += 1;
      continue;
    }
    if (token === "sudo") {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith("-")) index += 1;
      continue;
    }
    if (token === "env") {
      index += 1;
      while (index < tokens.length && (tokens[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(tokens[index]))) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

// A heredoc body is DATA fed to a command's stdin — but only when the consumer
// can be NAMED as a data sink. The classification is an allow-list of sinks, not
// a deny-list of interpreters: a deny-list has to be complete to be safe, and
// `ssh host <<EOF`, `docker exec -i c sh <<EOF`, `awk -f - <<EOF`,
// `/usr/bin/python3.11 <<EOF` and `psql <<EOF` all execute their bodies while
// looking nothing like `bash`. Forgetting a sink costs a false positive;
// forgetting an executor costs a missed egress. So an unrecognised consumer
// keeps its body scanned, and this list stays easy to extend on evidence.
const HEREDOC_DATA_SINKS = new Set([
  "cat",
  "tee",
  "gh",
  "glab",
  "git",
  "jq",
  "wc",
  "head",
  "tail",
  "sort",
  "uniq",
  "column",
  "fold",
  "pbcopy",
  "mail",
  "mailx",
]);

/** A heredoc redirect found on one line. */
interface HeredocOpener {
  index: number;
  delimiter: string;
  /** `<<-` strips leading TABS — only tabs, only for this form — from the terminator. */
  stripTabs: boolean;
  /**
   * `<<'EOF'` / `<<"EOF"` rather than `<<EOF`. Only a QUOTED delimiter makes the
   * body literal. With an unquoted one the shell expands it, so `$(printenv)` in
   * the body really runs — which is why an unquoted body is never treated as data.
   */
  quoted: boolean;
}

/**
 * Find the first `<<` on this line that is genuinely a heredoc redirect.
 *
 * Two things disqualify a `<<`, and missing either one was a fail-open defect:
 *
 * - **inside a quote span.** `echo "see <<EOF for details"` is prose. Treating it
 *   as an opener started a phantom, never-terminated heredoc that blanked every
 *   following line — so a real dump after it stopped being scanned at all. This
 *   scan runs before quote-stripping (it has to; the delimiter of a quoted
 *   heredoc is itself a quoted literal), which is exactly why it must do its own
 *   quote tracking.
 * - **`<<<`.** A here-string has no body and no terminator.
 *
 * Backslash escapes inside a quote span are not modelled, and the error runs both
 * ways: an escaped quote can end a span early (reporting an opener that is really
 * prose) or open a spurious span that swallows a real `<<` (missing an opener).
 * The missing direction is safe on its own — the body stays scanned. The
 * reporting direction is made safe by the data-body test below, which requires a
 * quoted delimiter and an all-sink pipeline before anything is blanked.
 */
function findHeredocOpener(line: string): HeredocOpener | null {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== "<" || line[index + 1] !== "<") continue;
    if (line[index + 2] === "<") {
      index += 2; // here-string: no body, no terminator.
      continue;
    }
    const match = /^(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/u.exec(line.slice(index + 2));
    if (!match) continue;
    return { index, delimiter: match[3], stripTabs: match[1] === "-", quoted: match[2] !== "" };
  }
  return null;
}

/** First word of a pipeline stage, as a bare command name. */
function stageCommandName(stage: string): string {
  const words = stage.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "";
  return shellCommandName(words[skipCommandPrefixes(words)]);
}

/**
 * True when this heredoc's body is inert data for every command that will see it.
 *
 * Three conditions, and dropping any one of them was a live fail-open defect:
 *
 * 1. **The delimiter is quoted.** `<<EOF` (unquoted) makes the shell expand the
 *    body, so `gh issue create --body-file - <<EOF` with a `$(printenv)` inside it
 *    runs the substitution. Only `<<'EOF'` / `<<"EOF"` is literal text.
 * 2. **The owning command is a sink.** Resolved by slicing at `opener.index`, not
 *    at the first `<<` in the line: in `echo "a << b" | bash <<'EOF'` the first
 *    `<<` sits inside a quoted argument and yields `echo` instead of `bash`.
 * 3. **Every downstream pipeline stage is a sink too.** `cat <<'EOF' | bash` has a
 *    sink for an owner and an interpreter for a consumer, and the body is executed.
 *    Only pipes carry the body onward — `;`, `&&` and `||` begin a command that
 *    never sees it, and demanding sink-ness of those would refuse
 *    `cat <<'EOF' > f ; curl -d @f url`, which is the shape #540 is about.
 */
function heredocBodyIsData(line: string, opener: HeredocOpener): boolean {
  if (!opener.quoted) return false;

  const ownerStage = line.slice(0, opener.index).split(/\|\||&&|[|;&]/u).pop() ?? "";
  if (!HEREDOC_DATA_SINKS.has(stageCommandName(ownerStage))) return false;

  // Split the tail on single pipes only; `||` is a boolean operator, not a pipe.
  // Element 0 is the remainder of the owner's own stage, already judged above.
  const downstream = line.slice(opener.index).split(/(?<!\|)\|(?!\|)/u).slice(1);
  return downstream.every((stage) => HEREDOC_DATA_SINKS.has(stageCommandName(stage)));
}

/**
 * True when `line` terminates `open`.
 *
 * Bash accepts the delimiter only on a line of its own — unindented, with nothing
 * after it. `<<-` relaxes the leading part for tabs alone, never spaces. Accepting
 * a trimmed line instead ends the body early on `  EOF` or on `EOF   `, and the
 * prose after it re-enters command-position scanning — reintroducing the #540
 * false positive that this pass exists to remove. Only a trailing `\r` is
 * tolerated, for CRLF input.
 */
function isHeredocTerminator(line: string, open: HeredocOpener): boolean {
  const candidate = (open.stripTabs ? line.replace(/^\t+/u, "") : line).replace(/\r$/u, "");
  return candidate === open.delimiter;
}

/**
 * Blank the bodies of heredocs consumed by a known data sink, so prose fed to
 * `cat`/`gh`/`git` stops being read as command position (#540): an issue body
 * whose text wrapped onto a line beginning with "export" or "set" scored
 * `env-egress` at `critical`, and a markdown code span in a `git commit -F -`
 * message did the same through the backtick anchor.
 *
 * Everything else keeps its body, because an unrecognised consumer may execute it.
 * An unterminated heredoc on a data sink blanks to end of input — once a body is
 * open the shell consumes the remaining lines as body too.
 */
function stripDataHeredocBodies(command: string): string {
  if (!command.includes("<<")) return command;
  const lines = command.split("\n");
  const out: string[] = [];
  let open: HeredocOpener | null = null;

  for (const line of lines) {
    if (open) {
      const terminates = isHeredocTerminator(line, open);
      out.push(terminates ? line : "");
      if (terminates) open = null;
      continue;
    }

    out.push(line);
    const opener = findHeredocOpener(line);
    if (opener && heredocBodyIsData(line, opener)) open = opener;
  }

  return out.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matchesPattern(value: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, "iu").test(value);
  } catch (_err) {
    // Keep invalid operator-supplied patterns deterministic and non-throwing.
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
}

function commandConfig(options: RuntimePolicyInspectOptions): RuntimePolicyCommandInspectionConfig {
  return options.runtimePolicy?.command ?? {};
}

function configuredOutboundTools(config: RuntimePolicyCommandInspectionConfig): string[] {
  return Array.from(new Set([...DEFAULT_OUTBOUND_TOOLS, ...(config.outboundTools ?? [])].map((tool) => tool.toLowerCase())));
}

function commandHasOutboundIntent(command: string, config: RuntimePolicyCommandInspectionConfig): boolean {
  // Config is per inspection, so the regex is intentionally built from the
  // current Soma-owned command config rather than cached globally.
  const toolPattern = new RegExp(`\\b(?:${configuredOutboundTools(config).map(escapeRegExp).join("|")})\\b`, "iu");
  return toolPattern.test(command) || /https?:\/\//iu.test(command);
}

function segmentHasOutboundIntent(segment: string[], config: RuntimePolicyCommandInspectionConfig): boolean {
  const commandIndex = skipCommandPrefixes(segment);
  const command = shellCommandName(segment[commandIndex]);
  if (configuredOutboundTools(config).includes(command)) return true;
  return segment.some((token) => /^https?:\/\//iu.test(token));
}

function normalizePathLikeToken(token: string): string {
  const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
  return value.replace(/^@/u, "");
}

function tokenMatchesAnyPattern(token: string, patterns: readonly string[]): boolean {
  const normalized = normalizePathLikeToken(token);
  return patterns.some((pattern) => matchesPattern(normalized, pattern));
}

function isCredentialPathToken(token: string, config: RuntimePolicyCommandInspectionConfig): boolean {
  return tokenMatchesAnyPattern(token, [...DEFAULT_CREDENTIAL_PATH_PATTERNS, ...(config.credentialPathPatterns ?? [])]);
}

function isPrivatePathToken(token: string, options: RuntimePolicyInspectOptions, somaHome: string, config: RuntimePolicyCommandInspectionConfig): boolean {
  const normalized = normalizePathLikeToken(token);
  if (tokenMatchesAnyPattern(normalized, config.privatePathPatterns ?? [])) return true;
  return somaPolicyPrivateMarkers(somaHome, options.homeDir, [...(options.runtimePolicy?.privateRoots ?? [])]).some((marker) => hasSomaPolicyPrivateMarker(normalized, marker));
}

function inspectConfiguredPatternRules(command: string, config: RuntimePolicyCommandInspectionConfig): RuntimePolicyFinding[] {
  return (config.patternRules ?? [])
    .filter((rule) => matchesPattern(command, rule.pattern))
    .map((rule) => finding(rule.kind, rule.severity ?? (rule.decision === "deny" ? "high" : rule.decision === "ask" ? "medium" : "low"), rule.detail, COMMAND_INSPECTOR_ID, rule.decision));
}

function inspectSegmentedCommand(command: string, options: RuntimePolicyInspectOptions, somaHome: string, config: RuntimePolicyCommandInspectionConfig): RuntimePolicyFinding[] {
  const findings: RuntimePolicyFinding[] = [];
  const segments = shellSegments(tokenizeCommand(command));
  let pipedPrivateSource = false;
  let pipedCredentialSource = false;

  for (const segment of segments) {
    const hasPrivatePath = segment.tokens.some((token) => isPrivatePathToken(token, options, somaHome, config));
    const hasCredentialPath = segment.tokens.some((token) => isCredentialPathToken(token, config));
    const hasOutbound = segmentHasOutboundIntent(segment.tokens, config);

    if ((hasPrivatePath || pipedPrivateSource) && hasOutbound) {
      findings.push(finding("private-path-egress", "critical", "Command appears to send private Soma path content to an outbound destination.", COMMAND_INSPECTOR_ID));
    }
    if ((hasCredentialPath || pipedCredentialSource) && hasOutbound) {
      findings.push(finding("credential-file-egress", "critical", "Command appears to send credential-file content to an outbound destination.", COMMAND_INSPECTOR_ID));
    }

    // Only pipes propagate source context. Command separators and boolean
    // operators reset it to avoid pretending we do full shell data-flow.
    pipedPrivateSource = segment.operatorAfter === "|" && (pipedPrivateSource || hasPrivatePath);
    pipedCredentialSource = segment.operatorAfter === "|" && (pipedCredentialSource || hasCredentialPath);
  }

  return findings;
}

function inspectToolCall(options: RuntimePolicyInspectOptions): RuntimePolicyFinding[] {
  if (!options.toolCall || typeof options.toolCall.toolName !== "string") {
    return [finding("malformed-tool-call", "critical", "Tool-call inspection requires a toolName.", INPUT_INSPECTOR_ID)];
  }

  const toolName = options.toolCall.toolName.toLowerCase();
  if (!/\b(bash|shell|exec_command)\b/u.test(toolName)) return [];

  const command = commandFromToolCall(options);
  if (!command) return [];

  const findings: RuntimePolicyFinding[] = [];
  const somaHome = createPaths(options).root();
  const config = commandConfig(options);
  const normalized = command.toLowerCase();
  const hasOutboundIntent = commandHasOutboundIntent(command, config);
  // `printenv`/`env`/`export`/`set` are COMMANDS — they only dump the
  // environment in command position (start, or after | ; && || $( ` newline).
  // Matching the bare word anywhere flagged ordinary English: a Discord post
  // containing "the same set" or "we export the data" scored as env-egress.
  // Quoted literals are stripped first, because a command name inside quotes is
  // an argument being passed, never a command being run. Data-heredoc bodies go
  // before that (#540) — the delimiter of a `<<'EOF'` heredoc is itself a quoted
  // literal, so quote-stripping first would erase the marker the body-scan needs.
  const unquoted = stripDataHeredocBodies(normalized).replace(/'[^']*'/gu, " '' ").replace(/"[^"]*"/gu, ' "" ');
  const hasEnvDump = /(?:^|[|;&]|\$\(|`|\n)\s*(?:printenv|env|export|set)\b/u.test(unquoted);
  // A credential term is only egress when a VALUE is attached to it
  // (`token=…`, `"password":…`, `api_key: …`). Naming the word is not egress —
  // "the credential-egress policy blocked it" and a fixture path named
  // `/tmp/x/secret/y` both used to trip this. Quoted content is still scanned,
  // because a real payload (`curl -d '{"password":"…"}'`) lives inside quotes.
  //
  // Two shapes attach a VALUE to a credential term, and both count:
  //   1. an assignment / key   — `token=…`, `"password":…`, `api_key: …`
  //   2. a variable reference  — `$SECRET_TOKEN`, `${API_KEY}`, `%TOKEN%`
  // Shape 2 is not optional: `echo $SECRET_TOKEN | rclone rcat remote:x` is
  // real egress and the existing regression test rightly demands it be caught.
  // Prose says "secret"; neither shape appears in prose.
  const CREDENTIAL_TERM = String.raw`(?:secret|token|credential|api[_-]?key|private[_ -]?key|password)s?`;
  const hasCredentialTerm =
    new RegExp(String.raw`\b${CREDENTIAL_TERM}\b["']?\s*[:=]`, "u").test(normalized) ||
    new RegExp(String.raw`[$%]\{?[a-z0-9_]*${CREDENTIAL_TERM}[a-z0-9_]*\}?`, "u").test(normalized);

  findings.push(...inspectConfiguredPatternRules(command, config));
  findings.push(...inspectSegmentedCommand(command, options, somaHome, config));
  const hasCredentialFileEgress = findings.some((item) => item.kind === "credential-file-egress");

  if (hasEnvDump && hasOutboundIntent && !hasCredentialFileEgress) {
    findings.push(finding("env-egress", "critical", "Command appears to send environment data to an outbound destination.", COMMAND_INSPECTOR_ID));
  }
  if (hasCredentialTerm && hasOutboundIntent && !hasCredentialFileEgress) {
    findings.push(finding("credential-egress", "critical", "Command appears to send credential-like data to an outbound destination.", COMMAND_INSPECTOR_ID));
  }
  if (/\b(curl|wget)\b[^|]{0,200}\|\s*(?:sh|bash|zsh|fish|python|ruby|perl|node|bun)\b/u.test(normalized)) {
    findings.push(finding("pipe-to-shell", "medium", "Command pipes remotely fetched content into an interpreter.", COMMAND_INSPECTOR_ID));
  }
  if (INLINE_INTERPRETER_PATTERN.test(normalized)) {
    const inlineDecision = config.inlineInterpreterDecision ?? "alert";
    findings.push(finding("inline-interpreter", inlineDecision === "deny" ? "high" : inlineDecision === "ask" ? "medium" : "low", "Command executes inline interpreter code.", COMMAND_INSPECTOR_ID, inlineDecision));
  }

  return findings;
}

function stableSummary(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSummary).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSummary(record[key])}`).join(",")}}`;
}

function flattenConfigKeys(value: Record<string, unknown> | undefined, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  if (!value) return result;

  for (const key of Object.keys(value).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const item = value[key];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const nested = flattenConfigKeys(item as Record<string, unknown>, path);
      if (nested.size > 0) {
        for (const [nestedKey, nestedValue] of nested) result.set(nestedKey, nestedValue);
      } else {
        result.set(path, stableSummary(item));
      }
    } else {
      result.set(path, stableSummary(item));
    }
  }

  return result;
}

function securityRelevantConfigKeys(options: RuntimePolicyInspectOptions, change: RuntimePolicyConfigChange): string[] {
  const substrate = options.substrate ?? "custom";
  return Array.from(new Set([...COMMON_SECURITY_CONFIG_KEYS, ...SUBSTRATE_SECURITY_CONFIG_KEYS[substrate], ...(change.securityRelevantKeys ?? [])]));
}

function isSecurityRelevantConfigKey(key: string, relevantKeys: readonly string[]): boolean {
  return relevantKeys.some((candidate) => key === candidate || key.startsWith(`${candidate}.`));
}

function inspectConfigChange(options: RuntimePolicyInspectOptions): RuntimePolicyFinding[] {
  const change = options.configChange;
  if (!change || typeof change.configSurface !== "string" || change.configSurface.length === 0) {
    return [finding("malformed-config-change", "critical", "Config-change inspection requires a configSurface.", INPUT_INSPECTOR_ID)];
  }

  if (change.error?.kind === "unreadable") {
    return [finding("config-unreadable", "high", `Could not read ${change.configSurface}: ${change.error.detail ?? "unreadable"}.`, CONFIG_INSPECTOR_ID, "alert")];
  }
  if (change.error?.kind === "malformed") {
    return [finding("config-malformed", "high", `Could not parse ${change.configSurface}: ${change.error.detail ?? "malformed"}.`, CONFIG_INSPECTOR_ID, "alert")];
  }

  const before = flattenConfigKeys(change.before);
  const after = flattenConfigKeys(change.after);
  const relevantKeys = securityRelevantConfigKeys(options, change);
  const findings: RuntimePolicyFinding[] = [];

  for (const key of Array.from(new Set([...before.keys(), ...after.keys()])).sort()) {
    if (!isSecurityRelevantConfigKey(key, relevantKeys)) continue;
    const beforeValue = before.get(key);
    const afterValue = after.get(key);
    if (beforeValue === afterValue) continue;

    const state = beforeValue === undefined ? "added" : afterValue === undefined ? "removed" : "changed";
    findings.push(
      finding(
        `config-security-key-${state}`,
        "medium",
        `Security-relevant config key ${key} ${state} on ${change.configSurface}.`,
        CONFIG_INSPECTOR_ID,
        "alert",
      ),
    );
  }

  return findings;
}

function permissionConfig(options: RuntimePolicyInspectOptions): RuntimePolicyPermissionConfig {
  return options.runtimePolicy?.permission ?? {};
}

function normalizePermissionPath(path: string, homeDir: string): string {
  const expanded = path === "~" ? homeDir : path.startsWith("~/") ? join(homeDir, path.slice(2)) : path;
  return resolve(expanded);
}

function isSameOrInsidePath(target: string, root: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function permissionApprovalCacheHit(request: RuntimePolicyPermissionRequest, config: RuntimePolicyPermissionConfig, homeDir: string, now: Date): boolean {
  if (!request.cacheKey) return false;

  return (config.approvalCache ?? []).some((entry) => {
    if (entry.cacheKey !== request.cacheKey || entry.action !== request.action) return false;
    if (entry.expiresAt) {
      const expiresAt = Date.parse(entry.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return false;
    }
    if (!entry.targetPath) return true;
    if (!request.targetPath) return false;
    return normalizePermissionPath(entry.targetPath, homeDir) === normalizePermissionPath(request.targetPath, homeDir);
  });
}

function permissionTrustedRootAllows(request: RuntimePolicyPermissionRequest, config: RuntimePolicyPermissionConfig, homeDir: string): boolean {
  if (!request.targetPath) return false;
  const target = normalizePermissionPath(request.targetPath, homeDir);

  return (config.trustedRoots ?? []).some((root) => {
    if (!root.actions.includes(request.action)) return false;
    return isSameOrInsidePath(target, normalizePermissionPath(root.path, homeDir));
  });
}

function permissionTargetsSensitivePath(request: RuntimePolicyPermissionRequest, options: RuntimePolicyInspectOptions, somaHome: string): boolean {
  if (!request.targetPath) return false;

  const targetPath = request.targetPath;
  if (DEFAULT_PERMISSION_SENSITIVE_PATH_PATTERNS.some((pattern) => matchesPattern(targetPath, pattern))) return true;

  return somaPolicyPrivateMarkers(somaHome, options.homeDir, [...(options.runtimePolicy?.privateRoots ?? [])]).some((marker) =>
    hasSomaPolicyPrivateMarker(targetPath, marker),
  );
}

function approvalUnavailableFinding(): RuntimePolicyFinding {
  return finding(
    "permission-approval-unavailable",
    "medium",
    "Permission request needs principal approval, but this substrate cannot synchronously ask.",
    PERMISSION_INSPECTOR_ID,
    "alert",
  );
}

function approvalRequiredFinding(): RuntimePolicyFinding {
  return finding("permission-approval-required", "medium", "Permission request requires explicit principal approval.", PERMISSION_INSPECTOR_ID, "ask");
}

function sensitivePathFinding(supportsAsk: boolean): RuntimePolicyFinding {
  return finding(
    "permission-sensitive-path",
    "high",
    "Permission request targets a sensitive or private path.",
    PERMISSION_INSPECTOR_ID,
    supportsAsk ? "ask" : "alert",
  );
}

function inspectPermissionRequest(options: RuntimePolicyInspectOptions, somaHome: string): RuntimePolicyFinding[] {
  const request = options.permissionRequest;
  if (!request || typeof request.requestId !== "string" || request.requestId.length === 0) {
    return [finding("malformed-permission-request", "critical", "Permission-request inspection requires a requestId.", INPUT_INSPECTOR_ID)];
  }

  const config = permissionConfig(options);
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  const now = new Date(options.timestamp ?? Date.now());
  const supportsAsk = request.substrateSupportsAsk !== false;
  const sensitivePath = permissionTargetsSensitivePath(request, options, somaHome);

  if (!sensitivePath && permissionApprovalCacheHit(request, config, homeDir, now)) return [];
  if (!sensitivePath && permissionTrustedRootAllows(request, config, homeDir)) return [];

  const findings: RuntimePolicyFinding[] = [];
  if (sensitivePath) findings.push(sensitivePathFinding(supportsAsk));
  findings.push(supportsAsk ? approvalRequiredFinding() : approvalUnavailableFinding());
  return findings;
}

interface ModelPolicyResponseFinding {
  ruleId?: unknown;
  decision?: unknown;
  severity?: unknown;
  detail?: unknown;
}

interface ModelPolicyResponse {
  findings?: unknown;
}

function modelConfig(options: RuntimePolicyInspectOptions): RuntimePolicyModelInspectorConfig {
  return options.runtimePolicy?.model ?? {};
}

function modelRulesForSurface(config: RuntimePolicyModelInspectorConfig, surface: RuntimePolicySurface): RuntimePolicyModelRule[] {
  return (config.rules ?? []).filter((rule) => !rule.surfaces || rule.surfaces.includes(surface));
}

function modelFailureFinding(kind: string, detail: string): RuntimePolicyFinding {
  return finding(kind, "medium", detail, MODEL_INSPECTOR_ID, "alert");
}

function runtimePolicyModelPrompt(options: RuntimePolicyInspectOptions, rules: readonly RuntimePolicyModelRule[]): string {
  const inputRef = inspectedInputRef(options);
  const payload = {
    surface: options.surface,
    prompt: options.surface === "prompt" ? options.prompt : undefined,
    toolCall: options.surface === "tool_call" ? options.toolCall : undefined,
    permissionRequest: options.surface === "permission_request" ? options.permissionRequest : undefined,
    configChange: options.surface === "config_change"
      ? {
        configSurface: options.configChange?.configSurface,
        changedKeys: changedConfigKeys(options.configChange),
        error: options.configChange?.error?.kind,
      }
      : undefined,
    inputRef,
  };

  return [
    "You are a Soma runtime policy evaluator.",
    "Evaluate only the listed principal-authored runtime policy rules.",
    "Return JSON only: {\"findings\":[{\"ruleId\":\"...\",\"decision\":\"alert|ask|allow\",\"severity\":\"low|medium|high\",\"detail\":\"one sentence\"}]}",
    "Do not return deny. Deterministic policy owns deny decisions.",
    "",
    "Rules:",
    JSON.stringify(rules, null, 2),
    "",
    "Runtime input:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function isModelDecision(value: unknown): value is "allow" | "alert" | "ask" {
  return value === "allow" || value === "alert" || value === "ask";
}

function isModelSeverity(value: unknown): value is RuntimePolicyFinding["severity"] {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function modelFindingFromResponse(item: ModelPolicyResponseFinding, rulesById: Map<string, RuntimePolicyModelRule>): RuntimePolicyFinding | undefined {
  if (typeof item.ruleId !== "string" || !rulesById.has(item.ruleId)) return undefined;
  if (!isModelDecision(item.decision)) return undefined;
  if (item.decision === "allow") return undefined;
  const rule = rulesById.get(item.ruleId);
  const decision = item.decision === "ask" && rule?.decision !== "alert" ? "ask" : "alert";
  const severity = isModelSeverity(item.severity) ? item.severity : rule?.severity ?? (decision === "ask" ? "medium" : "low");
  const detail = typeof item.detail === "string" && item.detail.trim().length > 0
    ? item.detail.trim()
    : `Model-backed runtime policy rule ${item.ruleId} matched.`;

  return finding("model-policy-rule", severity, detail, MODEL_INSPECTOR_ID, decision);
}

function parseModelPolicyResponse(response: unknown, rules: readonly RuntimePolicyModelRule[]): RuntimePolicyFinding[] | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const findings = (response as ModelPolicyResponse).findings;
  if (!Array.isArray(findings)) return undefined;

  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const parsed: RuntimePolicyFinding[] = [];
  for (const item of findings) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const modelFinding = modelFindingFromResponse(item as ModelPolicyResponseFinding, rulesById);
    if (!modelFinding && (item as ModelPolicyResponseFinding).decision !== "allow") return undefined;
    if (modelFinding) parsed.push(modelFinding);
  }
  return parsed;
}

async function inspectModelBackedPolicy(options: RuntimePolicyInspectOptions): Promise<RuntimePolicyFinding[]> {
  const config = modelConfig(options);
  if (config.enabled !== true) return [];

  const rules = modelRulesForSurface(config, options.surface);
  if (rules.length === 0) return [];
  if (!options.modelInspectorBackend) {
    return [modelFailureFinding("model-inspector-unavailable", "Model-backed runtime policy is enabled, but no inference backend was provided.")];
  }

  try {
    const result = await inference<ModelPolicyResponse>(runtimePolicyModelPrompt(options, rules), {
      backend: options.modelInspectorBackend,
      json: true,
      level: config.level ?? "fast",
      timeoutMs: config.timeoutMs ?? 3_000,
      homeDir: options.homeDir,
      somaHome: options.somaHome,
    });
    const findings = parseModelPolicyResponse(result.json, rules);
    return findings ?? [modelFailureFinding("model-inspector-malformed-response", "Model-backed runtime policy returned malformed findings.")];
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/time(?:d)?\s*out|timeout/iu.test(detail)) {
      return [modelFailureFinding("model-inspector-timeout", `Model-backed runtime policy timed out: ${detail}`)];
    }
    if (/json|parse/iu.test(detail)) {
      return [modelFailureFinding("model-inspector-parse-error", `Model-backed runtime policy returned unparsable output: ${detail}`)];
    }
    return [modelFailureFinding("model-inspector-error", `Model-backed runtime policy failed: ${detail}`)];
  }
}

function decisionForFindings(findings: RuntimePolicyFinding[]): RuntimePolicyDecision {
  if (findings.some((item) => item.decision === "deny")) return "deny";
  // Critical command findings deny by severity; prompt-integrity findings deny
  // by kind because they are high-confidence policy bypass/exfiltration intents.
  if (findings.some((item) => item.severity === "critical" || item.kind === "security-disable-request" || item.kind === "instruction-override" || item.kind === "data-exfiltration-intent")) {
    return "deny";
  }
  if (findings.some((item) => item.decision === "ask")) return "ask";
  if (findings.some((item) => item.kind === "pipe-to-shell")) return "ask";
  if (findings.some((item) => item.decision === "alert")) return "alert";
  if (findings.length > 0) return "alert";
  return "allow";
}

function reasonForDecision(decision: RuntimePolicyDecision, findings: RuntimePolicyFinding[]): string {
  if (decision === "allow") return "No deterministic runtime-policy findings.";
  const kinds = findings.map((item) => item.kind).join(", ");
  if (decision === "deny") return `Runtime policy denied this action: ${kinds}.`;
  if (decision === "ask") return `Runtime policy requires principal approval: ${kinds}.`;
  return `Runtime policy advisory alert: ${kinds}.`;
}

function eventRecordAllowed(record: RuntimePolicyInspectOptions["record"], decision: RuntimePolicyDecision): boolean {
  const mode = record ?? "all";
  return mode === "all" || (mode === "deny" && decision !== "allow");
}

function inspectFindings(options: RuntimePolicyInspectOptions, somaHome: string): RuntimePolicyFinding[] {
  if (options.surface === "prompt") {
    if (typeof options.prompt !== "string") {
      return [finding("malformed-prompt", "critical", "Prompt inspection requires prompt text.", INPUT_INSPECTOR_ID)];
    }
    return inspectPrompt(options.prompt);
  }

  if (options.surface === "tool_call") return inspectToolCall(options);
  if (options.surface === "permission_request") return inspectPermissionRequest(options, somaHome);
  if (options.surface === "config_change") return inspectConfigChange(options);

  return [];
}

async function inspectAllFindings(options: RuntimePolicyInspectOptions, somaHome: string): Promise<RuntimePolicyFinding[]> {
  const deterministicFindings = inspectFindings(options, somaHome);
  if (decisionForFindings(deterministicFindings) === "deny") return deterministicFindings;
  return [...deterministicFindings, ...await inspectModelBackedPolicy(options)];
}

function changedConfigKeys(change: RuntimePolicyConfigChange | undefined): string[] {
  if (!change) return [];
  const before = flattenConfigKeys(change.before);
  const after = flattenConfigKeys(change.after);
  return Array.from(new Set([...before.keys(), ...after.keys()]))
    .filter((key) => before.get(key) !== after.get(key))
    .sort();
}

function inspectedInputRef(options: RuntimePolicyInspectOptions): {
  kind: string;
  hash?: string;
  toolName?: string;
  requestId?: string;
  action?: string;
  cacheKey?: string;
  targetHash?: string;
  configSurface?: string;
  changedKeys?: string[];
  error?: string;
} {
  if (options.surface === "prompt") {
    return {
      kind: "prompt",
      hash: inputHash(options.prompt ?? ""),
    };
  }

  if (options.surface === "tool_call") {
    const command = commandFromToolCall(options);
    return {
      kind: "tool_call",
      toolName: options.toolCall?.toolName,
      hash: command ? inputHash(command) : undefined,
    };
  }

  if (options.surface === "config_change") {
    return {
      kind: "config_change",
      configSurface: options.configChange?.configSurface,
      changedKeys: changedConfigKeys(options.configChange),
      error: options.configChange?.error?.kind,
    };
  }

  if (options.surface === "permission_request") {
    return {
      kind: "permission_request",
      requestId: options.permissionRequest?.requestId,
      action: options.permissionRequest?.action,
      cacheKey: options.permissionRequest?.cacheKey,
      targetHash: options.permissionRequest?.targetPath ? inputHash(options.permissionRequest.targetPath) : undefined,
    };
  }

  return { kind: options.surface };
}

async function writeRuntimePolicyTrace(result: RuntimePolicyInspectResult, options: RuntimePolicyInspectOptions): Promise<string> {
  const traceRoot = runtimePolicyTraceRoot({ somaHome: result.somaHome });
  const timestamp = options.timestamp ?? new Date().toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/gu, "-");
  const inputRef = inspectedInputRef(options);
  const tracePath = join(traceRoot, `${safeTimestamp}-${result.surface}-${(inputRef.hash ?? "no-input").slice(0, 16)}.json`);
  const payload = {
    timestamp,
    surface: result.surface,
    decision: result.decision,
    reason: result.reason,
    findings: result.findings,
    inputRef,
  };

  await mkdir(dirname(tracePath), { recursive: true });
  await writeFile(tracePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return tracePath;
}

async function auditRuntimePolicy(result: RuntimePolicyInspectResult, options: RuntimePolicyInspectOptions): Promise<RuntimePolicyInspectAudit | undefined> {
  if (!eventRecordAllowed(options.record, result.decision)) return undefined;

  const tracePath = await writeRuntimePolicyTrace(result, options);
  const event = await appendSomaMemoryEvent(result.somaHome, {
    timestamp: options.timestamp,
    substrate: options.substrate ?? "custom",
    kind: "runtime_policy.inspect",
    summary: `${result.decision}: ${result.reason}`,
    artifactPaths: [tracePath],
    metadata: {
      surface: result.surface,
      decision: result.decision,
      findings: result.findings,
      inputRef: inspectedInputRef(options),
    },
  });

  return { event, tracePath };
}

export async function inspectRuntimePolicy(options: RuntimePolicyInspectOptions): Promise<RuntimePolicyInspectResult> {
  const somaHome = createPaths(options).root();
  const surface = options.surface;
  const findings = await inspectAllFindings(options, somaHome);
  const decision = decisionForFindings(findings);
  const result: RuntimePolicyInspectResult = {
    somaHome,
    surface,
    decision,
    reason: reasonForDecision(decision, findings),
    findings,
  };
  const audit = await auditRuntimePolicy(result, options);

  return audit ? { ...result, audit } : result;
}

export const RUNTIME_POLICY_SURFACES: readonly RuntimePolicySurface[] = [
  "prompt",
  "tool_call",
  "permission_request",
  "config_change",
  "governance_event",
];
