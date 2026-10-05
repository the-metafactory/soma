import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * Secret-bearing config that must not be read raw into the model's context
 * (soma#716). Egress rules cover content LEAVING the machine; this covers the
 * commoner leak — a `cat`, `sed -n`, `grep -n` or Read of a stack config puts
 * its tokens and seeds into the transcript, where the provider sees them and
 * compaction keeps them.
 *
 * End-anchored on purpose, unlike DEFAULT_CREDENTIAL_PATH_PATTERNS: `.envrc`,
 * `env.ts`, `process.env.X` and an nginx `*.conf` are not secrets (#474 is the
 * same mistake on the egress side). `.env.example`/`.sample`/`.template`/`.dist`
 * are committed templates, so they stay readable. A bare directory matches
 * where the whole tree is secret-bearing, so `grep -rn x ~/.config/cortex` is
 * caught as well as a single file. Principals extend this list in
 * `policy/secret-read.json`.
 */
const DEFAULT_SECRET_READ_PATH_PATTERNS = [
  "\\.(creds|nk)$",
  "(^|/)nsc/keys(/|$)",
  "(^|/)\\.config/nats(/?$|/creds(/|$)|/.*\\.(conf|creds|nk)(\\.[^/]*)?$)",
  "(^|/)nats[^/]*\\.conf$",
  "(^|/)\\.config/cortex(/?$|/.*\\.ya?ml(\\.[^/]*)?$)",
  "(^|/)\\.env(\\.(?!example$|sample$|template$|dist$)[^/]+)?$",
  "(^|/)\\.config/glab-cli(/|$)",
] as const;

export const SECRET_READ_CONFIG_RELATIVE_PATH = "policy/secret-read.json";

/** Commands that print file content to stdout — i.e. into the model's context. */
const SECRET_READ_PRINTERS = new Set([
  "cat", "head", "tail", "less", "more", "bat", "batcat", "sed", "awk", "gawk", "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "jq", "yq", "strings", "xxd", "od", "hexdump", "nl", "tac", "cut", "sort", "uniq", "diff", "comm", "paste", "column",
  "base64", "rev", "fold", "pr",
]);

/** rtk wraps printers under its own verbs; map them back to what they print. */
const RTK_PRINTER_ALIASES: Record<string, string> = { read: "cat", json: "jq", log: "cat", smart: "cat", grep: "grep", diff: "diff" };

const GREP_FAMILY = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
// Short flags whose value is the next token (or the rest of the cluster), per
// family: grep's `-T` is initial-tab and ag's `-t` is all-text, neither takes a
// value, so a shared set would swallow `grep -nT TOKEN .env`'s pattern and let
// the file through as if it were one.
const GREP_COMMON_VALUE_FLAGS = ["e", "f", "m", "A", "B", "C"];
const POSIX_GREP_VALUE_FLAGS: ReadonlySet<string> = new Set([...GREP_COMMON_VALUE_FLAGS, "d", "D"]);
const GREP_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  grep: POSIX_GREP_VALUE_FLAGS,
  egrep: POSIX_GREP_VALUE_FLAGS,
  fgrep: POSIX_GREP_VALUE_FLAGS,
  rg: new Set([...GREP_COMMON_VALUE_FLAGS, "d", "g", "t", "T", "M", "j"]),
  ag: new Set([...GREP_COMMON_VALUE_FLAGS, "g", "G"]),
  ack: new Set(GREP_COMMON_VALUE_FLAGS),
};
const GREP_LONG_VALUE_FLAGS = new Set([
  "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--glob", "--iglob", "--type", "--type-not",
  "--include", "--exclude", "--exclude-dir", "--max-columns", "--threads",
]);
// Flags that make a grep print counts or file names, never lines. `-L` is
// grep's files-without-match but rg/ag's follow-symlinks, so it is per family.
const GREP_COUNT_ONLY_SHORT_FLAGS = new Set(["c", "l", "q"]);
const GREP_COUNT_ONLY_LONG_FLAGS = new Set(["--count", "--count-matches", "--files-with-matches", "--files-without-match", "--quiet", "--silent", "--files"]);
const GREP_FILES_WITHOUT_MATCH_FAMILY = new Set(["grep", "egrep", "fgrep", "ack"]);

/**
 * Stages that may sit between a read and its redactor: each has NO option or
 * argument that writes anywhere but stdout. Kept that narrow on purpose:
 * `sort -o f`, `uniq in out`, `yq -i` and jq's `stderr`/`debug` all can, so they
 * are out — a filter that needs per-flag vetting does not belong here.
 */
const REDACT_PIPE_FILTERS = new Set(["head", "tail", "grep", "egrep", "fgrep", "rg", "cut", "tr"]);

/** Tools that print a file's content, and tools that print matching lines. */
const FILE_READ_TOOLS = new Set(["read", "read_file", "view", "view_file", "open_file", "notebookread"]);
const CONTENT_SEARCH_TOOLS = new Set(["grep", "rg", "grep_search", "search_file_content"]);

const SECRET_READ_MAX_DEPTH = 3;

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
 * Three narrowings, applied together:
 *   - POLARITY: a negator shortly before the verb inverts the meaning.
 *   - FORM: only the bare imperative/infinitive is a request. Inflected forms
 *     ("disables", "was disabled", "the disabled branch", "bypassing") are
 *     descriptions of a system, not instructions to the assistant.
 *   - POSITION: a bare verb is a request unless the words before it make it
 *     a description. "Collisions bypass the tamper guard" has a plural subject,
 *     so the bare form is a finite verb in a review finding; "lets an attacker
 *     bypass", "symlinks can bypass" and "allows an attacker to bypass" state
 *     what a system permits. Every clearing signal is something only a
 *     description contains — an inflected verb, a copula, a plural subject
 *     whose noun phrase runs back to a clause start — never something that
 *     could open an imperative ("attempt to", "find a way to", "for these
 *     files bypass"). A verb joined to another word by `-` is part of an
 *     identifier (`remove-observer`, this rule's own name) and is no verb at
 *     all.
 *
 * Each narrowing clears only text that positively reads as a refusal, a
 * description or an identifier; anything it does not recognise keeps
 * firing. The regression tests pin both directions for each witnessed false
 * positive (#472, #544) and for the request shapes review has raised.
 */
const NEGATION_WINDOW = 40;
const NEGATOR_PATTERN =
  /\b(?:not|never|n't|without|refus\w*|declin\w*|avoid\w*|cannot|instead of|rather than)\b/iu;

/** True when `verb` at `index` is negated by something shortly before it. */
function isNegated(text: string, index: number): boolean {
  return NEGATOR_PATTERN.test(text.slice(Math.max(0, index - NEGATION_WINDOW), index));
}

/**
 * Proximity is a proxy for "these words are about each other", and that proxy
 * dies where the thought ends: at a blank line, and at a sentence end.
 *
 * The blank line, because soma's own `CONTEXT.md` ends a paragraph with the
 * noun "…hides bypass paths." and opens the next section with the heading
 * "## Inbound security config". Sixty characters apart, zero relationship — and
 * the resulting `security-disable-request` denied every prompt carrying that
 * file, which is how sage's Architecture and ContextDrift lenses came to fail on
 * every review round for months while reporting it as a model contract
 * deviation.
 *
 * The sentence end, because a terse to-do list ("…remove the hand override.
 * File a bug about the policy inspector…") puts the verb of one item next to
 * the noun of the next (#544). A sentence end is `.`, `!` or `?` followed by
 * whitespace and an uppercase letter, so "e.g. the" and "src/x.ts" do not cut.
 *
 * A single newline is NOT a boundary: prose wraps, and "please bypass\nthe
 * security guard" is one sentence and one request.
 */
const CLAUSE_END = /\n[ \t]*\n|[.!?](?=\s+\p{Lu})/u;

/**
 * The character that joins a word into an identifier: `remove-observer`, this
 * rule's own name. `_` needs no handling: it is a word character, so `\b`
 * already refuses it. `/` is not a joiner: "disable/remove the hook" is an
 * alternation of two verbs, and the alternation takes its first member's
 * position.
 */
const WORD_JOINER = "-";

/** Markup that sits between a clause start and its first word: emphasis, quotes, code ticks, brackets. */
const TRANSPARENT_TAIL = /[ \t*_`"'“”‘’([{<>]+$/u;

/** A clause starts after these: line start, sentence/clause punctuation, a list marker or dash. */
const CLAUSE_START_CHARS = new Set(["\n", ".", "!", "?", ";", ":", ",", ")", "-", "+", "—", "–", "•"]);

/**
 * Pronoun subjects that make a bare form a finite verb: "they bypass the
 * guard". Indefinite pronouns are not here: they take the inflected form
 * ("everyone disables"), so "everyone disable the guard" is an address.
 */
const BARE_VERB_SUBJECTS = new Set(["i", "they", "who", "which", "that"]);

/** After these a clause is a description, so a plural noun phrase may start here: "note that symlinks bypass". */
const RELATIVE_PRONOUNS = new Set(["who", "which", "that"]);

/**
 * Function words: a closed class, so this list can be complete where a list
 * of request shapes never is. A plural noun phrase that runs into one of these
 * before reaching a clause start is not a sentence subject: "for these files
 * bypass", "if the build fails bypass", "okay agents bypass" are imperatives.
 * Relative pronouns are absent on purpose: after "that"/"which" the clause is
 * a description ("note that symlinks bypass the guard").
 */
const FUNCTION_WORDS = new Set([
  // subordinators and conjunctions
  "if", "when", "whenever", "once", "unless", "until", "till", "after", "before", "since", "because", "while",
  "whereas", "though", "although", "as", "so", "and", "or", "but", "nor", "then", "than", "otherwise",
  // prepositions
  "for", "with", "without", "in", "on", "at", "by", "from", "to", "into", "onto", "of", "off", "over", "under",
  "about", "across", "against", "around", "between", "through", "during", "per", "via", "within", "upon",
  // interjections, politeness and sequencing adverbs
  "ok", "okay", "yes", "yeah", "sure", "hey", "hi", "hello", "please", "pls", "plz", "kindly", "now", "just",
  "also", "first", "next", "finally", "still", "again", "here", "there",
  // modals, auxiliaries and the copula: a verb, not a noun phrase
  "can", "could", "would", "will", "shall", "should", "must", "may", "might", "do", "does", "did", "is", "are",
  "was", "were", "be", "been", "has", "have", "had", "let", "lets",
]);

/** Words that end in "s" without being a plural noun. */
const NOT_PLURAL = new Set([
  "always", "lets", "yes", "pls", "plus", "perhaps", "thanks", "afterwards", "besides", "sometimes", "unless",
  "does", "was", "has", "its", "his", "this", "is", "as", "us",
]);

/** How many words a subject noun phrase may hold before the plural head: "serialization collisions". */
const NOUN_PHRASE_WORDS = 3;

/** Inflected causatives take an object and a bare verb: "lets an attacker bypass the guard" is a finding. */
const CAUSATIVES = new Set(["lets", "letting", "makes", "making", "helps", "helping"]);
const CAUSATIVE_OBJECT_WORDS = 3;

/**
 * A modal with a bare verb is a request only when it addresses someone: "can
 * you", "we must", "Ivy must", "all agents must", and the third person injected
 * content uses for a model ("the assistant must"). With a pronoun, plural or
 * determiner-led subject it states a capability: "symlinks can", "an attacker
 * can".
 */
const MODALS = new Set(["can", "could", "would", "will", "shall", "should", "must", "may"]);
const MODAL_ADDRESSEES = new Set(["assistant", "agent", "model", "ai", "claude", "llm"]);
const MODAL_DESCRIPTIVE_SUBJECTS = new Set([
  "i", "it", "they", "he", "she", "one", "who", "which", "that", "anyone", "someone", "everyone", "anybody",
  "somebody", "everybody",
]);
const DETERMINERS = new Set([
  "a", "an", "the", "any", "every", "each", "some", "this", "that", "these", "those", "no", "its", "their", "his",
  "her", "our",
]);

/**
 * "to" is purpose or ability, not a request, only after an inflected verb
 * ("allows an attacker to", "tries to", "used to") or a copula and adjective
 * ("it is possible to"). Bare heads stay requests: "allow me to", "attempt to",
 * "find a way to", "make sure to".
 */
const INFLECTED_TO_HEADS = new Set([
  "allows", "allowed", "allowing", "enables", "enabled", "enabling", "permits", "permitted", "causes", "caused",
  "leads", "led", "used", "attempts", "attempted", "tries", "tried",
]);
const ADJECTIVE_TO_HEADS = new Set(["possible", "impossible", "easy", "easier", "trivial", "hard", "harder", "able", "unable"]);
const COPULAS = new Set(["is", "are", "was", "were", "be", "been", "it", "that"]);
const TO_HEAD_WORDS = 4;

/** How far back the position check looks; a clause start further away than this is not "directly before". */
const POSITION_LOOKBACK = 200;

/** Adverbs leave the position unchanged ("please temporarily disable"); this many are stepped over. */
const MAX_ADVERB_CHAIN = 3;

/** An alternation `a/b/verb` takes its first member's position; longer chains stay where they are. */
const MAX_ALTERNATION_MEMBERS = 8;

type PrecedingToken = { kind: "clause-start" } | { kind: "word"; word: string; start: number } | { kind: "other" };

/** The token directly before `index`, skipping whitespace and transparent markup. */
function precedingToken(text: string, index: number): PrecedingToken {
  const from = Math.max(0, index - POSITION_LOOKBACK);
  const before = text.slice(from, index).replace(TRANSPARENT_TAIL, "");
  if (before === "") return { kind: "clause-start" };
  const last = before[before.length - 1]!;
  if (CLAUSE_START_CHARS.has(last)) return { kind: "clause-start" };
  const word = /[\p{L}'’]+$/u.exec(before);
  if (!word) return { kind: "other" };
  const bare = word[0].toLowerCase().replace(/['’](?:ll|d|re|ve|s)$/u, "");
  return { kind: "word", word: bare, start: from + word.index };
}

/** Up to `count` words directly before `index`, nearest first, stopping at anything that is not a word. */
function wordsBefore(text: string, index: number, count: number): { word: string; start: number }[] {
  const words: { word: string; start: number }[] = [];
  for (let at = index; words.length < count; ) {
    const token = precedingToken(text, at);
    if (token.kind !== "word") break;
    words.push(token);
    at = token.start;
  }
  return words;
}

function looksPlural(word: string): boolean {
  return word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/u.test(word) && !NOT_PLURAL.has(word);
}

function singular(word: string): string {
  return looksPlural(word) ? word.slice(0, -1) : word;
}

/**
 * True when the plural word starting at `start` heads a noun phrase that runs
 * back to a clause start through content words and determiners only.
 */
function isPluralSubject(text: string, word: string, start: number): boolean {
  if (!looksPlural(word) || MODAL_ADDRESSEES.has(singular(word))) return false;
  let at = start;
  for (let words = 0; words <= NOUN_PHRASE_WORDS; words++) {
    const token = precedingToken(text, at);
    if (token.kind === "clause-start") return true;
    if (token.kind !== "word" || FUNCTION_WORDS.has(token.word)) return false;
    if (RELATIVE_PRONOUNS.has(token.word)) return true;
    at = token.start;
  }
  return false;
}

/** True when the subject before the modal at `modalStart` makes it a statement of capability. */
function hasDescriptiveModalSubject(text: string, modalStart: number): boolean {
  const subject = precedingToken(text, modalStart);
  if (subject.kind !== "word" || MODAL_ADDRESSEES.has(singular(subject.word))) return false;
  if (MODAL_DESCRIPTIVE_SUBJECTS.has(subject.word) || isPluralSubject(text, subject.word, subject.start)) return true;
  const determiner = precedingToken(text, subject.start);
  return determiner.kind === "word" && DETERMINERS.has(determiner.word);
}

/** True when the "to" at `toStart` follows a purpose or ability head rather than a request. */
function isDescriptiveTo(text: string, toStart: number): boolean {
  const heads = wordsBefore(text, toStart, TO_HEAD_WORDS);
  return heads.some(({ word }, i) =>
    INFLECTED_TO_HEADS.has(word) || (ADJECTIVE_TO_HEADS.has(word) && COPULAS.has(heads[i + 1]?.word ?? "")));
}

/** Where the alternation `a/b/verb` that ends at `index` starts; `index` itself when there is none. */
function alternationStart(text: string, index: number): number {
  let at = index;
  for (let members = 0; members < MAX_ALTERNATION_MEMBERS && text[at - 1] === "/"; members++) {
    const member = /\p{L}+\/$/u.exec(text.slice(Math.max(0, at - POSITION_LOOKBACK), at));
    if (!member) break;
    at -= member[0].length;
  }
  return at;
}

/**
 * True unless the words before the verb at `index` positively make it a
 * description. The default is a request: a security rule that clears only
 * listed request shapes fails open on every shape nobody listed.
 */
function inRequestPosition(text: string, verbIndex: number): boolean {
  let index = alternationStart(text, verbIndex);
  for (let adverbs = 0; ; adverbs++) {
    const token = precedingToken(text, index);
    if (token.kind !== "word") return true;
    const { word, start } = token;
    // An adverb leaves the position unchanged: "please temporarily disable"
    // vs "collisions silently bypass".
    if (word.length > 3 && word.endsWith("ly") && adverbs < MAX_ADVERB_CHAIN) {
      index = start;
      continue;
    }
    if (MODALS.has(word)) return !hasDescriptiveModalSubject(text, start);
    if (word === "to") return !isDescriptiveTo(text, start);
    if (BARE_VERB_SUBJECTS.has(word) || isPluralSubject(text, word, start)) return false;
    return !wordsBefore(text, index, CAUSATIVE_OBJECT_WORDS).some(({ word: head }) => CAUSATIVES.has(head));
  }
}

/** True when the match at `index..end` is a word of its own, not part of an identifier. */
function isFreeStanding(text: string, index: number, end: number): boolean {
  return text[index - 1] !== WORD_JOINER && text[end] !== WORD_JOINER;
}

/**
 * Find `verbPattern` (bare forms only, free-standing, in request position)
 * followed by `targetPattern` within `window` chars **of the same clause**,
 * rejecting negated occurrences. Returns the matched span, verb to target, or
 * undefined when every occurrence is a description, an identifier or a
 * refusal rather than a request. Patterns match case-insensitively against
 * the original text, so offsets index the text as written.
 */
function findUnnegatedRequest(
  text: string,
  verbPattern: RegExp,
  targetPattern: RegExp,
  window = 60,
): string | undefined {
  const verb = new RegExp(verbPattern.source, "giu");
  const target = new RegExp(targetPattern.source, "iu");
  for (let m = verb.exec(text); m !== null; m = verb.exec(text)) {
    const end = m.index + m[0].length;
    if (!isFreeStanding(text, m.index, end)) continue;
    if (isNegated(text, m.index)) continue;
    if (!inRequestPosition(text, m.index)) continue;
    const lookahead = text.slice(m.index, end + window);
    const boundary = lookahead.search(CLAUSE_END);
    const sameClause = boundary === -1 ? lookahead : lookahead.slice(0, boundary);
    const hit = target.exec(sameClause);
    if (hit) return sameClause.slice(0, hit.index + hit[0].length).replace(/\s+/gu, " ");
  }
  return undefined;
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

/**
 * A finding as inspection produces it. A prompt finding may carry the input
 * span that tripped it, so a denial says what to rephrase (#544). The span is
 * raw input, so it is not part of the exported `RuntimePolicyFinding`: it
 * reaches the returned reason and nothing else, and `publicFinding` strips it
 * before any finding leaves this module.
 */
type InspectedFinding = RuntimePolicyFinding & { excerpt?: string };

function publicFinding({ excerpt: _excerpt, ...rest }: InspectedFinding): RuntimePolicyFinding {
  return rest;
}

/**
 * A high-severity prompt finding for a request-position match, carrying the
 * matched span as its excerpt; undefined when nothing in `prompt` is a request.
 */
function requestFinding(prompt: string, verbs: RegExp, targets: RegExp, kind: string, detail: string): InspectedFinding | undefined {
  const excerpt = findUnnegatedRequest(prompt, verbs, targets);
  return excerpt === undefined ? undefined : { ...finding(kind, "high", detail, PROMPT_INSPECTOR_ID), excerpt };
}

/**
 * Every prompt rule matches the text as written, case-insensitively, so a
 * rule that reports a span or an offset indexes the same string the others
 * read.
 */
function inspectPrompt(prompt: string): InspectedFinding[] {
  const findings: InspectedFinding[] = [];

  const disableRequest = requestFinding(
    prompt,
    /\b(?:disable|turn off|bypass|remove)\b/u,
    /\b(?:soma\s+)?(?:security|policy|guard|hook)s?\b/u,
    "security-disable-request",
    // Gerunds, not bare verbs: the CLI prints this detail, and a report that
    // quotes it must not trip the rule it reports.
    "Prompt requests disabling or bypassing Soma runtime policy.",
  );
  if (disableRequest) findings.push(disableRequest);
  if (/\b(ignore|override)\s+(all\s+)?(previous|prior|system|developer)\s+instructions\b/iu.test(prompt)) {
    findings.push(finding("instruction-override", "high", "Prompt attempts to override higher-priority instructions.", PROMPT_INSPECTOR_ID));
  }
  const exfiltrationRequest = requestFinding(
    prompt,
    /\b(?:reveal|print|dump|exfiltrate|leak|steal)\b/u,
    /\b(?:private memory|secret|token|credential|private key)s?\b/u,
    "data-exfiltration-intent",
    "Prompt requests private memory or credential disclosure.",
  );
  if (exfiltrationRequest) findings.push(exfiltrationRequest);
  if (/\b(jailbreak|do anything now|roleplay as|pretend to be unrestricted)\b/iu.test(prompt)) {
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

interface TokenizeOptions {
  /**
   * Treat an unquoted newline as `;`: a script's next line is a new command, so
   * without it `cd x\ncat .env` has verb `cd`. Quoted strings still span lines,
   * so a multi-line commit message stays one argument. Line continuations join.
   */
  newlineAsSeparator?: boolean;
  /** Keep `<`, `>` and `>>` as tokens (cleanup strips them) so a redirect target can be told from an argument. */
  keepRedirects?: boolean;
}

function tokenizeCommand(command: string, options: TokenizeOptions = {}): string[] {
  const source = options.newlineAsSeparator ? command.replace(/\\\n/gu, " ") : command;
  const pattern = new RegExp(String.raw`"([^"]*)"|'([^']*)'|&&|\|\||[|;<>]{1,2}${options.newlineAsSeparator ? String.raw`|\n` : ""}|[^\s|;<>]+`, "gu");
  return [...source.matchAll(pattern)]
    .map((match) => {
      if (match[0] === "\n") return ";";
      if (options.keepRedirects && /^(?:<|>|>>)$/u.test(match[0])) return match[0];
      return cleanShellToken(match[1] || match[2] || match[0]);
    })
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

/** One shell operator found outside any quote span, with its offset in the line. */
interface LineOperator {
  index: number;
  /** `|` alone. Only a pipe carries a heredoc body to another command. */
  isPipe: boolean;
}

/** What a single quote-aware pass over one line yields. */
interface LineScan {
  opener: HeredocOpener | null;
  operators: LineOperator[];
  /**
   * The line ends in an unquoted `\`, so the shell joins the NEXT line to this
   * command. Whatever follows could be `| bash`, and this pass sees lines one at
   * a time, so a continued line is never classified as data.
   */
  continued: boolean;
  /**
   * An unquoted `>(` or `<(`. Process substitution runs a command that can consume
   * the body — `cat <<'EOF' > >(bash)` — and it is not a pipeline stage, so the
   * operator walk below cannot see it.
   */
  processSubstitution: boolean;
}

/**
 * One quote-aware pass over a line, yielding everything the heredoc classifier
 * needs: the first genuine `<<` redirect, the unquoted operator offsets, and the
 * two shapes that make the line unsafe to classify at all.
 *
 * Every consumer must share this pass. Splitting on a bare `/[|;&]/` elsewhere is
 * what produced two fail-open defects and one false positive:
 * `gh issue create --title "map & chart" <<'EOF'` resolved its owner to `chart"`,
 * and `ssh host "echo hi ; cat -" <<'EOF'` resolved it to `cat` — a sink — so an
 * interpreter's body was blanked.
 *
 * Quoting follows bash: inside `'…'` nothing escapes and only `'` closes the span;
 * inside `"…"` a backslash escapes the next character; outside, a backslash
 * escapes the next character and both quote characters open a span.
 */
function scanLine(line: string): LineScan {
  const operators: LineOperator[] = [];
  let opener: HeredocOpener | null = null;
  let processSubstitution = false;
  let quote: '"' | "'" | null = null;
  let index = 0;

  for (; index < line.length; index += 1) {
    const char = line[index];

    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "\\") index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if ((char === ">" || char === "<") && line[index + 1] === "(") {
      processSubstitution = true;
      continue;
    }
    if (char === "|" || char === ";" || char === "&") {
      const doubled = line[index + 1] === char;
      operators.push({ index, isPipe: char === "|" && !doubled });
      if (doubled) index += 1;
      continue;
    }
    if (char !== "<" || line[index + 1] !== "<") continue;
    if (line[index + 2] === "<") {
      index += 2; // here-string: no body, no terminator.
      continue;
    }
    if (opener) continue; // only the first redirect on a line is tracked; see below.
    const match = /^(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/u.exec(line.slice(index + 2));
    if (!match) continue;
    opener = { index, delimiter: match[3], stripTabs: match[1] === "-", quoted: match[2] !== "" };
  }

  // An unterminated quote span means the line was mis-parsed; treat it as continued
  // so nothing on it is classified as data.
  const continued = quote !== null || /(?<!\\)\\$/u.test(line);
  return { opener, operators, continued, processSubstitution };
}

/**
 * First word of a pipeline stage, as a bare command name. Empty when the stage is
 * blank or is nothing but env-assignment prefixes, which no allow-list contains —
 * so an all-prefix stage fails the sink test rather than reaching a lookup.
 */
function stageCommandName(stage: string): string {
  const words = stage.trim().split(/\s+/u).filter(Boolean);
  const start = skipCommandPrefixes(words);
  return start < words.length ? shellCommandName(words[start]) : "";
}

/**
 * True when this heredoc's body is inert data for every command that will see it.
 *
 * Each condition below was a live fail-open defect when it was missing:
 *
 * 1. **The line is fully parsed and self-contained.** A trailing `\` joins the next
 *    line (which may be `| bash`), an unclosed quote means the parse is unreliable,
 *    and `>(`/`<(` runs a command this walk cannot see.
 * 2. **The delimiter is quoted.** `<<EOF` makes the shell expand the body, so a
 *    `$(printenv)` inside it really runs. Only `<<'EOF'` / `<<"EOF"` is literal.
 * 3. **The owning command is a sink** — the stage between the last unquoted
 *    operator before the redirect and the redirect itself.
 * 4. **Every downstream pipe stage is a sink too.** `cat <<'EOF' | bash` has a sink
 *    for an owner and an interpreter for a consumer. Only pipes carry the body
 *    onward: `;`, `&&` and `||` begin a command that never sees it, and demanding
 *    sink-ness of those would refuse `cat <<'EOF' > f ; curl -d @f url`, which is
 *    the shape #540 is about.
 */
function heredocBodyIsData(line: string, scan: LineScan, opener: HeredocOpener): boolean {
  if (scan.continued || scan.processSubstitution) return false;
  if (!opener.quoted) return false;

  const ownerStart = scan.operators.filter((op) => op.index < opener.index).pop();
  const ownerStage = line.slice(ownerStart ? ownerStart.index + 1 : 0, opener.index);
  if (!HEREDOC_DATA_SINKS.has(stageCommandName(ownerStage))) return false;

  const pipes = scan.operators.filter((op) => op.index > opener.index && op.isPipe);
  return pipes.every((pipe, position) => {
    const isLast = position + 1 === pipes.length;
    const stage = line.slice(pipe.index + 1, isLast ? line.length : pipes[position + 1].index);
    return HEREDOC_DATA_SINKS.has(stageCommandName(stage));
  });
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
 *
 * Runs on the ORIGINAL command, never a lowercased copy: heredoc delimiters are
 * case-sensitive, and comparing lowercased text let a body line `msg` terminate a
 * `<<'MSG'` heredoc, putting the prose after it back into command-position scanning.
 *
 * Only the FIRST redirect on a line is tracked. `cat <<'A' > /tmp/a <<'B'` leaves
 * the second body scanned, which costs a false positive and never a missed
 * command — the same direction every other unmodelled case here fails in.
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
    const scan = scanLine(line);
    if (scan.opener && heredocBodyIsData(line, scan, scan.opener)) open = scan.opener;
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

function secretReadPatterns(config: RuntimePolicyCommandInspectionConfig): string[] {
  return [...DEFAULT_SECRET_READ_PATH_PATTERNS, ...(config.secretReadPathPatterns ?? [])];
}

function secretReadFinding(path: string, via: string): RuntimePolicyFinding {
  // High, not critical: a context leak, not an egress or an attack. The
  // explicit `deny` blocks it; the hint is what the model reads to recover.
  return {
    ...finding("secret-read", "high", `${via} reads ${path} raw into the model's context; it may hold tokens, passwords or seeds.`, COMMAND_INSPECTOR_ID, "deny"),
    hint: `Read it with \`soma redact ${path}\` (masks secret values, keeps keys, structure and paths), or pipe the command through \`| soma redact -\`.`,
  };
}

/** Resolve the verb a segment runs, looking through `rtk` and `rtk proxy`. */
function secretReadVerb(tokens: string[]): { verb: string; argsFrom: number } {
  const index = skipCommandPrefixes(tokens);
  const name = shellCommandName(tokens[index]);
  if (name !== "rtk") return { verb: name, argsFrom: index + 1 };
  const sub = (tokens[index + 1] ?? "").toLowerCase();
  if (sub === "proxy") return { verb: shellCommandName(tokens[index + 2]), argsFrom: index + 3 };
  return { verb: RTK_PRINTER_ALIASES[sub] ?? `rtk-${sub}`, argsFrom: index + 2 };
}

/**
 * The segment RUNS a redactor: `soma redact`, `bun run soma redact` or
 * `redact-cat`, resolved from the command position — not merely a
 * `soma redact` token pair somewhere in its arguments. `bun <any>/cli.ts` is
 * not accepted: any script can be called `cli.ts`.
 */
function isRedactorSegment(tokens: string[]): boolean {
  const index = skipCommandPrefixes(tokens);
  const name = shellCommandName(tokens[index]);
  if (name === "redact-cat") return true;
  if (name === "soma") return tokens[index + 1] === "redact";
  if (name !== "bun") return false;
  return tokens[index + 1] === "run" && shellCommandName(tokens[index + 2]) === "soma" && tokens[index + 3] === "redact";
}

// Redirect targets that send nothing around the redactor: discarding output,
// or folding stderr into the stdout the redactor reads (`2>&1`).
const HARMLESS_REDIRECT_TARGETS = new Set(["/dev/null", "&1"]);

/** True when a stage redirects output anywhere but the pipe: `>&2`, `> /dev/stderr`, `>> log`, `&> f`. */
function redirectsOutputElsewhere(tokens: string[]): boolean {
  return tokens.some((token, index) => (token === ">" || token === ">>") && !HARMLESS_REDIRECT_TARGETS.has(tokens[index + 1] ?? ""));
}

/**
 * Whether a read's output reaches the redactor and nothing else. Every route
 * by which raw content can bypass the redactor is a reason to refuse:
 *   - the chain the read feeds must END in a stage that runs a redactor;
 *   - every stage between must be a pure filter (an allow-list, like the
 *     heredoc sinks: a missing filter costs a false denial, a missing writer a
 *     leak — `tee /dev/stderr` is a writer);
 *   - no stage before the redactor, the read included, may redirect its output
 *     (`cat .env > /dev/stderr | soma redact -`, `| cat >&2 |`).
 */
function pipeChainEndsInRedactor(segments: { tokens: string[]; operatorAfter?: string }[], from: number): boolean {
  let end = from;
  while (end < segments.length - 1 && segments[end].operatorAfter === "|") end += 1;
  if (end === from || !isRedactorSegment(segments[end].tokens)) return false;
  const beforeRedactor = segments.slice(from, end);
  if (beforeRedactor.some(({ tokens }) => redirectsOutputElsewhere(tokens))) return false;
  return beforeRedactor.slice(1).every(({ tokens }) => REDACT_PIPE_FILTERS.has(secretReadVerb(tokens).verb));
}

/**
 * The arguments a grep-family command reads as FILES. The first positional is
 * the pattern unless `-e`/`-f` supplied one, so `grep -rn ".env" src/` — a
 * search for the word — is not a read of `.env`. Returns undefined when the
 * flags make the command count/list-only, which prints no content.
 */
function grepFileArguments(verb: string, args: string[]): string[] | undefined {
  const positional: string[] = [];
  let patternGiven = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const name = token.split("=")[0];
      if (GREP_COUNT_ONLY_LONG_FLAGS.has(name)) return undefined;
      if (name === "--regexp" || name === "--file") patternGiven = true;
      if (!token.includes("=") && GREP_LONG_VALUE_FLAGS.has(name)) index += 1;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const cluster = token.slice(1);
      for (let at = 0; at < cluster.length; at += 1) {
        const flag = cluster[at];
        if (GREP_COUNT_ONLY_SHORT_FLAGS.has(flag) || (flag === "L" && GREP_FILES_WITHOUT_MATCH_FAMILY.has(verb))) return undefined;
        if (GREP_VALUE_FLAGS[verb]?.has(flag)) {
          if (flag === "e" || flag === "f") patternGiven = true;
          if (at === cluster.length - 1) index += 1;
          break;
        }
      }
      continue;
    }
    positional.push(token);
  }
  return patternGiven ? positional : positional.slice(1);
}

/** Drop `> file` / `>> file` targets: a redirect writes the file, it does not print it. */
function withoutOutputRedirects(args: string[]): string[] {
  return args.filter((token, index) => token !== ">" && token !== ">>" && args[index - 1] !== ">" && args[index - 1] !== ">>" && token !== "<");
}

/** The tokens of a printer segment that name files whose content it prints. */
function printedFileArguments(verb: string, args: string[]): string[] {
  if (GREP_FAMILY.has(verb)) return grepFileArguments(verb, args) ?? [];
  // In-place sed rewrites the file and prints nothing.
  if (verb === "sed" && args.some((arg) => arg === "--in-place" || /^-[A-Za-z]*i/u.test(arg))) return [];
  return args.filter((arg) => !(arg.startsWith("-") && arg.length > 1));
}

/**
 * Blank the contents of single-quoted spans. The shell substitutes nothing
 * inside `'…'`, so `git commit -m 'docs: \`cat .env\` is denied'` runs no
 * `cat`; double-quoted spans keep their `$(…)`, because bash does run those.
 */
function blankSingleQuoted(command: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (const char of command) {
    if (quote === "'") {
      if (char === "'") quote = null;
      out += char === "'" ? char : " ";
      continue;
    }
    if (char === quote) quote = null;
    else if (!quote && (char === "'" || char === '"')) quote = char;
    out += char;
  }
  return out;
}

/** Nested command text: `$(…)`, backticks, `sh -c "…"`, `rtk run "…"`, `eval …`. */
function nestedCommands(rawCommand: string, segments: { tokens: string[] }[]): string[] {
  const substitutable = blankSingleQuoted(rawCommand);
  const nested = [
    ...[...substitutable.matchAll(/\$\(([^()]*)\)/gu)].map((match) => match[1]),
    ...[...substitutable.matchAll(/`([^`]*)`/gu)].map((match) => match[1]),
  ];
  for (const { tokens } of segments) {
    const index = skipCommandPrefixes(tokens);
    const name = shellCommandName(tokens[index]);
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(name)) {
      const flag = tokens.findIndex((token, at) => at > index && /^-[A-Za-z]*c$/u.test(token));
      if (flag !== -1 && tokens[flag + 1]) nested.push(tokens[flag + 1]);
    } else if (name === "rtk" && tokens[index + 1] === "run" && tokens[index + 2]) {
      nested.push(tokens[index + 2]);
    } else if (name === "eval") {
      nested.push(tokens.slice(index + 1).join(" "));
    }
  }
  return nested;
}

/**
 * `secret-read` for shell commands: a printing verb whose file argument is a
 * secret-bearing path, unless the pipe chain it feeds ends in a redactor.
 * Non-printing verbs (`cp`, `tar`, `source`, `nats-server -t`) never fire.
 */
function inspectSecretReadCommand(command: string, config: RuntimePolicyCommandInspectionConfig, depth = 0): RuntimePolicyFinding[] {
  // Data-heredoc bodies are stdin, not arguments: `cat <<'EOF' > notes.md`
  // whose body mentions `.env` reads nothing (#540).
  const stripped = stripDataHeredocBodies(command);
  const segments = shellSegments(tokenizeCommand(stripped, { newlineAsSeparator: true, keepRedirects: true }));
  const patterns = secretReadPatterns(config);
  const findings: RuntimePolicyFinding[] = [];

  segments.forEach((segment, position) => {
    const { verb, argsFrom } = secretReadVerb(segment.tokens);
    if (!SECRET_READ_PRINTERS.has(verb)) return;
    const path = printedFileArguments(verb, withoutOutputRedirects(segment.tokens.slice(argsFrom))).find((token) => tokenMatchesAnyPattern(token, patterns));
    if (!path || pipeChainEndsInRedactor(segments, position)) return;
    findings.push(secretReadFinding(normalizePathLikeToken(path), "Command"));
  });

  if (findings.length === 0 && depth < SECRET_READ_MAX_DEPTH) {
    for (const inner of nestedCommands(stripped, segments)) {
      const nested = inspectSecretReadCommand(inner, config, depth + 1);
      if (nested.length > 0) return nested;
    }
  }
  return findings.slice(0, 1);
}

function stringToolInput(input: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * `secret-read` for file-reading tools (Read, view, pi's `read`) and
 * content-search tools (Grep). A search prints matching lines unless its
 * input names a list or count `output_mode`. A substrate whose tool defaults
 * to listing files (Claude Code's Grep) states that default in its adapter
 * before inspection; the core does not know any tool's defaults.
 */
function inspectFileReadTool(options: RuntimePolicyInspectOptions, toolName: string): RuntimePolicyFinding[] {
  const input = options.toolCall?.input;
  if (CONTENT_SEARCH_TOOLS.has(toolName) && typeof input?.output_mode === "string" && input.output_mode !== "content") return [];

  const patterns = secretReadPatterns(commandConfig(options));
  const path = stringToolInput(input, "file_path", "path", "notebook_path", "filePath", "target_file", "dir_path");
  const glob = CONTENT_SEARCH_TOOLS.has(toolName) ? stringToolInput(input, "glob", "include") : undefined;
  const target = [path, ...searchGlobCandidates(path, glob)].find((candidate) => candidate !== undefined && tokenMatchesAnyPattern(candidate, patterns));
  return target === undefined ? [] : [secretReadFinding(target, options.toolCall?.toolName ?? toolName)];
}

/**
 * Concrete paths a search glob can select, so `{ glob: ".env*" }` or
 * `{ path: "~/.config/cortex", glob: "*.yaml" }` is checked like the files it
 * reaches. A `*` is tried as empty and as one character; a leading `**\/` is
 * dropped. A heuristic over common globs, not glob semantics.
 */
function searchGlobCandidates(path: string | undefined, glob: string | undefined): string[] {
  if (!glob) return [];
  const bare = glob.replace(/^(\*\*\/)+/u, "");
  const expanded = [bare.replace(/\*/gu, ""), bare.replace(/\*/gu, "x")];
  const base = path?.replace(/\/+$/u, "");
  return [...expanded, ...(base ? expanded.map((name) => `${base}/${name}`) : [])];
}

function inspectToolCall(options: RuntimePolicyInspectOptions): RuntimePolicyFinding[] {
  if (!options.toolCall || typeof options.toolCall.toolName !== "string") {
    return [finding("malformed-tool-call", "critical", "Tool-call inspection requires a toolName.", INPUT_INSPECTOR_ID)];
  }

  const toolName = options.toolCall.toolName.toLowerCase();
  if (FILE_READ_TOOLS.has(toolName) || CONTENT_SEARCH_TOOLS.has(toolName)) return inspectFileReadTool(options, toolName);
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
  // The heredoc pass reads `command`, not `normalized`: delimiters are
  // case-sensitive, so it must run before the lowercasing.
  const unquoted = stripDataHeredocBodies(command)
    .toLowerCase()
    .replace(/'[^']*'/gu, " '' ")
    .replace(/"[^"]*"/gu, ' "" ');
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
  findings.push(...inspectSecretReadCommand(command, config));
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

function reasonForDecision(decision: RuntimePolicyDecision, findings: InspectedFinding[]): string {
  if (decision === "allow") return "No deterministic runtime-policy findings.";
  // A denial that names only the kind leaves nobody able to tell what to
  // rephrase (#544), so a finding that knows its span shows it. "the words"
  // is a plural subject whose noun phrase runs back to the hyphenated kind,
  // which makes the span's verb a finite verb: a report that quotes this
  // reason back does not re-trip the rule (pinned by a test).
  const kinds = findings
    .map((item) => (item.excerpt ? `${item.kind} (the words "${item.excerpt}" tripped it)` : item.kind))
    .join(", ");
  // The reason is all a substrate relays to the model, so a finding that names
  // its own recovery (`secret-read` → `soma redact`) carries it here.
  const guidance = findings.flatMap((item) => (item.hint ? [`${item.detail} ${item.hint}`] : [])).join(" ");
  const suffix = guidance ? ` ${guidance}` : "";
  if (decision === "deny") return `Runtime policy denied this action: ${kinds}.${suffix}`;
  if (decision === "ask") return `Runtime policy requires principal approval: ${kinds}.${suffix}`;
  return `Runtime policy advisory alert: ${kinds}.${suffix}`;
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

  // The returned reason may quote the input; the stored one is rebuilt from
  // the public findings, which carry no excerpt.
  const stored: RuntimePolicyInspectResult = { ...result, reason: reasonForDecision(result.decision, result.findings) };
  const tracePath = await writeRuntimePolicyTrace(stored, options);
  const event = await appendSomaMemoryEvent(result.somaHome, {
    timestamp: options.timestamp,
    substrate: options.substrate ?? "custom",
    kind: "runtime_policy.inspect",
    summary: `${stored.decision}: ${stored.reason}`,
    artifactPaths: [tracePath],
    metadata: {
      surface: stored.surface,
      decision: stored.decision,
      findings: stored.findings,
      inputRef: inspectedInputRef(options),
    },
  });

  return { event, tracePath };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The principal's own `secret-read` paths, from `policy/secret-read.json`:
 * `{ "pathPatterns": ["(^|/)\\.config/acme/.*\\.toml$"] }`. Absent → defaults
 * only. Unreadable or malformed → defaults plus an advisory finding, never a
 * throw: this runs inside the fail-closed guard, where a throw denies EVERY
 * tool call. An invalid regex is tolerated later by `matchesPattern`.
 */
async function loadSecretReadPatterns(somaHome: string): Promise<{ patterns: string[]; finding?: RuntimePolicyFinding }> {
  const path = join(somaHome, SECRET_READ_CONFIG_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { patterns: [] };
    return { patterns: [], finding: secretReadConfigFinding(`${path} is unreadable: ${errorText(err)}`) };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const patterns = (parsed as { pathPatterns?: unknown } | null)?.pathPatterns;
    if (!Array.isArray(patterns) || !patterns.every((item) => typeof item === "string")) {
      return { patterns: [], finding: secretReadConfigFinding(`${path} needs { "pathPatterns": string[] }`) };
    }
    return { patterns };
  } catch (err: unknown) {
    return { patterns: [], finding: secretReadConfigFinding(`${path} is not JSON: ${errorText(err)}`) };
  }
}

function secretReadConfigFinding(detail: string): RuntimePolicyFinding {
  return finding("secret-read-config-invalid", "medium", `${detail}; using the default secret-read paths only.`, CONFIG_INSPECTOR_ID, "alert");
}

async function withSecretReadConfig(options: RuntimePolicyInspectOptions, somaHome: string): Promise<{ options: RuntimePolicyInspectOptions; findings: RuntimePolicyFinding[] }> {
  if (options.surface !== "tool_call") return { options, findings: [] };
  const loaded = await loadSecretReadPatterns(somaHome);
  if (loaded.patterns.length === 0) return { options, findings: loaded.finding ? [loaded.finding] : [] };
  const command = options.runtimePolicy?.command ?? {};
  return {
    options: {
      ...options,
      runtimePolicy: {
        ...options.runtimePolicy,
        command: { ...command, secretReadPathPatterns: [...(command.secretReadPathPatterns ?? []), ...loaded.patterns] },
      },
    },
    findings: [],
  };
}

export async function inspectRuntimePolicy(options: RuntimePolicyInspectOptions): Promise<RuntimePolicyInspectResult> {
  const somaHome = createPaths(options).root();
  const surface = options.surface;
  const configured = await withSecretReadConfig(options, somaHome);
  const findings: InspectedFinding[] = [...configured.findings, ...await inspectAllFindings(configured.options, somaHome)];
  const decision = decisionForFindings(findings);
  const result: RuntimePolicyInspectResult = {
    somaHome,
    surface,
    decision,
    reason: reasonForDecision(decision, findings),
    findings: findings.map(publicFinding),
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
