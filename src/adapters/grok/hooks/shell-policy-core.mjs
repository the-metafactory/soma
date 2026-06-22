// soma:grok:shell-policy-core — Soma-owned hook asset (uninstall ownership marker).
//
// The descriptor-parameterized shell-extraction core: tokenizer and parsing
// helpers, the three POSIX passes, the pwsh/cmd dialect pass with its
// verb tables, and the fail-closed backstop. Extracted verbatim from
// grok-policy-targets.mjs as a preparatory step toward a future shared-core
// promotion. The tool-input layer (tool-name/input-key normalization and the
// three public extractor exports) stays in grok-policy-targets.mjs, which
// imports this file as a sibling and supplies grok's descriptor.
//
// The descriptor carries ONLY the adapter-specific relative path-prefix
// lists (the observed grok/codex delta). Everything else is unconditional
// core behavior, deliberately NOT descriptor-reachable:
//   - Windows-aware path matching (isAbsolute() root detection, separator
//     and case normalization, 8.3 short-name canonicalization) is the one
//     true behavior — POSIX paths are unaffected, the normalization is a
//     superset.
//   - The fail-closed architecture (the unknown-verb-touching-private-path
//     deny default, the no-silent-pass backstop, the read-only allowlist) lives here
//     and no descriptor value can disable or bypass it: an empty descriptor
//     still denies via the absolute config.policyMarkers resolution path.
import { dirname, isAbsolute, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { hasSomaPolicyPrivateMarker } from "./policy-marker.mjs";

export function hasSomaPolicyMarker(config, content) {
  return config.policyMarkers.some((marker) => hasSomaPolicyPrivateMarker(content, marker));
}

export function policyRelevantContent(config, content) {
  if (!hasSomaPolicyMarker(config, content)) return "";
  return (content || "")
    .split("\n")
    .filter((line) => hasSomaPolicyMarker(config, line))
    .join("\n");
}

function normalizeSeparators(path) {
  return path.replace(/\\/g, "/");
}

// pwsh accepts Windows 8.3 short-name components
// (`C:\Users\KYLELI~1\.soma\memory\WORK`, `C:\PROGRA~1\...`). They resolve
// to the same private file at runtime, but left literal they never
// prefix-match the long-form policy markers -> zero targets -> ALLOWED, the
// same Copy-Item egress class closed earlier.
// Canonicalize BOTH the candidate path AND the marker root before comparing
// (in isUnderRoot) so any mix of short/long forms folds to one shape — this
// mirrors the TS policy engine's own realScopePath (policy-path-guard.ts),
// which already canonicalizes both sides, so the extractor's RECOGNITION must
// too or it never emits a target for the engine to deny.
//
// realpathSync only resolves an EXISTING path, so walk to the longest existing
// ancestor (e.g. `~/.soma` when `~/.soma/memory/WORK` is not yet created),
// canonicalize it (expands every 8.3 component), then re-append the remainder.
// The `~\d` guard keeps every ordinary long-form path on the untouched fast
// path — fs is never consulted, so non-Windows and long-only paths are
// byte-identical to before. Memoized because isUnderRoot is hot.
const shortPathCanonCache = new Map();

function canonicalizeShortPath(path) {
  if (process.platform !== "win32") return path;
  if (!/~\d/.test(path)) return path;
  const cached = shortPathCanonCache.get(path);
  if (cached !== undefined) return cached;

  let cursor = path;
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      shortPathCanonCache.set(path, path);
      return path;
    }
    suffix.unshift(cursor.slice(parent.length + 1));
    cursor = parent;
  }

  let result = path;
  try {
    const realCursor = realpathSync.native(cursor);
    result = suffix.length > 0 ? resolve(realCursor, ...suffix) : realCursor;
  } catch {
    result = path;
  }
  shortPathCanonCache.set(path, result);
  return result;
}

function isUnderRootLiteral(path, root) {
  let normalizedPath = normalizeSeparators(path);
  let normalizedRoot = normalizeSeparators(root).replace(/\/+$/, "");
  // grok's platform is Windows, whose filesystem is case-INSENSITIVE —
  // `C:\Users\Kyle\.SOMA` and `C:\Users\Kyle\.soma` are the same dir, and
  // realpathSync.native returns true on-disk casing that may differ from a
  // config marker's. Compare case-insensitively on win32 so a case-variant
  // private path can't slip the prefix check.
  if (process.platform === "win32") {
    normalizedPath = normalizedPath.toLowerCase();
    normalizedRoot = normalizedRoot.toLowerCase();
  }
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function isUnderRoot(path, root) {
  // Fast path: a literal (separator/case-normalized) compare with NO fs
  // access. This handles every case where both sides already use the same
  // form — the overwhelming majority, including all long-form production
  // paths and the consistently-short test homes.
  if (isUnderRootLiteral(path, root)) return true;
  // Only pay the 8.3 canonicalization fs cost when the literal
  // compare missed AND a short-name component is actually present on either
  // side — the genuine short-vs-long mismatch the exploit relies on.
  if (process.platform !== "win32") return false;
  if (!/~\d/.test(path) && !/~\d/.test(root)) return false;
  return isUnderRootLiteral(canonicalizeShortPath(path), canonicalizeShortPath(root));
}

export function resolveToolPath(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd || process.cwd(), path);
}

function somaHomeParent(config) {
  const home = normalizeSeparators(config.somaHome);
  return home.endsWith("/.soma") ? config.somaHome.slice(0, -"/.soma".length) : process.env.HOME || process.env.USERPROFILE || "";
}

// pwsh is grok's native shell, so the model emits backslash separators and
// Windows home spellings by default. Normalize a token to forward slashes
// and fold the Windows home forms into the canonical `$HOME/` shape so every
// private-path check below fires on the separators and home spellings the
// model actually produces. Without this, `~\.soma\...` and `$HOME\.soma\...`
// evaded the policy.
//
// The fold list must cover every spelling pwsh resolves to the home dir, not
// just the bare-$env forms. `${env:USERPROFILE}` (brace), `$env:HOMEPATH`,
// and the
// `$env:HOMEDRIVE$env:HOMEPATH` concatenation all resolve to the home dir at
// runtime; left unfolded they fell through to a literal relative path,
// matched no absolute marker, and let `Copy-Item ${env:USERPROFILE}\.soma\
// memory\WORK <public>` egress with zero extractor targets. The `{?...}?`
// makes the braces optional so one rule covers `$env:X` and `${env:X}`; the
// `(?=\/|$)` lookahead keeps `$env:USERPROFILEX` from mis-folding.
function normalizeShellPathToken(token) {
  const slashed = (token || "").replace(/\\/g, "/");
  return slashed
    // HOMEDRIVE+HOMEPATH concatenation first (most specific), bare or braced.
    .replace(/^\$\{?env:HOMEDRIVE\}?\$\{?env:HOMEPATH\}?(?=\/|$)/i, "$HOME")
    // USERPROFILE / HOMEPATH / HOME, bare `$env:` or braced `${env:}`.
    .replace(/^\$\{?env:USERPROFILE\}?(?=\/|$)/i, "$HOME")
    .replace(/^\$\{?env:HOMEPATH\}?(?=\/|$)/i, "$HOME")
    .replace(/^\$\{?env:HOME\}?(?=\/|$)/i, "$HOME")
    .replace(/^%USERPROFILE%(?=\/|$)/i, "$HOME")
    .replace(/^%HOMEPATH%(?=\/|$)/i, "$HOME");
}

function resolveShellPath(config, rawPath, cwd) {
  const path = normalizeShellPathToken(rawPath);
  if (path.startsWith("~/.soma")) {
    return `${config.somaHome}${path.slice("~/.soma".length)}`;
  }

  const home = somaHomeParent(config);
  if (home && path.startsWith("$HOME/")) {
    return `${home}/${path.slice("$HOME/".length)}`;
  }
  if (home && path.startsWith("${HOME}/")) {
    return `${home}/${path.slice("${HOME}/".length)}`;
  }
  if (home && path.startsWith("~/")) {
    return `${home}/${path.slice(2)}`;
  }

  // Non-home forms: resolve the ORIGINAL token so absolute Windows paths
  // (`C:\...`) keep their native shape for the existing under-root checks.
  return resolveToolPath(rawPath, cwd);
}

function cleanShellToken(token) {
  return token.replace(/^[<>"']+|[>"']+$/g, "");
}

// Operators that may be glued to an adjacent token. `>` / `>>` are within-
// statement redirects (recovered by redirectionTarget); `;` / `&&` / `||` /
// `|` are statement/pipeline separators that shellSegments treats as segment
// boundaries. Kept verbatim as standalone tokens.
const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", ">>", ">"]);

// An unquoted operator glued to a token must be split out so the structure is
// recoverable instead of hidden inside one opaque token. The redirect `>` case
// is handled so `secret>public.txt` tokenizes to [secret, >, public.txt]; this
// also covers the statement/pipeline separators, because `echo x;Copy-Item <priv>
// <pub>` otherwise tokenizes `x;Copy-Item` as one token, collapses to a
// single segment led by the read-only verb `echo`, and is skipped by every
// pass and the fail-closed backstop. Quoted tokens never reach here, so a
// separator inside a quoted path is preserved. A lone `&` (the pwsh call
// operator) is intentionally not split.
function splitOperatorToken(token) {
  if (!token) return [token];
  // The capturing group keeps the operators as tokens; two-char operators
  // (`&&` / `||` / `>>`) precede their single-char forms so they win.
  return token.split(/(&&|\|\||>>|;|\||>)/).filter((piece) => piece !== "");
}

function tokenizeShellCommand(command) {
  const tokens = [];
  for (const match of (command || "").matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g)) {
    const quoted = match[1] !== undefined || match[2] !== undefined;
    const raw = match[1] || match[2] || match[0];
    if (quoted) {
      const cleaned = cleanShellToken(raw);
      if (cleaned) tokens.push(cleaned);
      continue;
    }
    for (const piece of splitOperatorToken(raw)) {
      // Keep operators verbatim: cleanShellToken would strip a bare `>` to
      // empty, hiding the redirect/separator from the segmenter.
      if (SHELL_OPERATORS.has(piece)) {
        tokens.push(piece);
      } else {
        const cleaned = cleanShellToken(piece);
        if (cleaned) tokens.push(cleaned);
      }
    }
  }
  return tokens;
}

// Descriptor prefix matching. The hardcoded predicate matrix this replaces
// was UNEVEN on purpose, so each entry carries its own bare-match semantics
// instead of a flat uniform rule:
//   - `bare: true` entries also match the exact bare token (no trailing
//     path) — e.g. a bare `.soma` is private, a bare `.claude` is protected.
//   - every entry matches `<path>/...` and the `./`-glued `./<path>/...`
//     variant.
// A bare `.grok/skills/soma` token historically matched only the PROTECTED
// check, never the private one — the descriptor reproduces that by carrying
// `bare: false` on the private entry and `bare: true` on the protected one.
// Mirror isUnderRootLiteral: Windows filesystems are case-INSENSITIVE, so
// `.SOMA` and `.soma` are the same directory and a case-variant spelling
// must not slip the relative leg (the absolute-marker leg already folds
// on win32). POSIX stays exact-case — there `.SOMA` really is a different
// path.
function matchesRelativePathPrefix(token, entry) {
  const fold = process.platform === "win32";
  const candidate = fold ? token.toLowerCase() : token;
  const prefix = fold ? entry.path.toLowerCase() : entry.path;
  if (entry.bare && candidate === prefix) return true;
  return candidate.startsWith(`${prefix}/`) || candidate.startsWith(`./${prefix}/`);
}

function absoluteProtectedRoots(config) {
  return Array.from(new Set(config.policyMarkers.filter((marker) => isAbsolute(marker)).map((marker) => resolve(marker))));
}

function lastPathToken(tokens) {
  return [...tokens].reverse().find((token) => token && !token.startsWith("-") && token !== "--");
}

function redirectionTarget(tokens) {
  const redirectIndex = tokens.findIndex((token) => token === ">" || token === ">>");
  if (redirectIndex !== -1) return tokens[redirectIndex + 1];
  const redirectToken = tokens.find((token) => token.startsWith(">") && token.length > 1);
  return redirectToken ? redirectToken.replace(/^>+/, "") : undefined;
}

function isShellOperator(token) {
  return token === "&&" || token === "||" || token === "|" || token === ";";
}

function shellSegments(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (isShellOperator(token)) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function shellSegmentsWithOperators(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (isShellOperator(token)) {
      if (current.length > 0) segments.push({ tokens: current, operatorAfter: token });
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push({ tokens: current, operatorAfter: undefined });
  return segments;
}

function shellCommandName(token) {
  return normalizeSeparators(token || "").split("/").pop() || "";
}

function skipShellPrefixes(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(token) || ["command", "exec", "time", "nice", "nohup"].includes(token)) {
      index += 1;
      continue;
    }
    if (token === "sudo") {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith("-")) {
        const option = tokens[index];
        index += 1;
        if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-T", "--command-timeout"].includes(option)) {
          index += 1;
        }
      }
      continue;
    }
    if (token === "env") {
      index += 1;
      while (index < tokens.length && (tokens[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(tokens[index]))) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

function shellPathArguments(tokens, startIndex) {
  const args = [];
  let parseFlags = true;
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (parseFlags && token === "--") {
      parseFlags = false;
      continue;
    }
    if (parseFlags && token.startsWith("-") && token.length > 1) {
      // PowerShell accepts colon-glued parameter values
      // (`-Path:C:\x`, `-Destination:pub`, and unambiguous abbreviations).
      // Recover the value as a candidate path arg instead of dropping the
      // whole token. Valueless switches (`-Recurse`, `-Force`) have no colon
      // and are still skipped.
      const colon = token.indexOf(":");
      if (colon !== -1 && colon < token.length - 1) {
        args.push(token.slice(colon + 1));
      }
      continue;
    }
    if (token === ">" || token === ">>") {
      i += 1;
      continue;
    }
    args.push(token);
  }
  return args;
}

function findSearchRoots(tokens, startIndex) {
  const roots = [];
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-H" || token === "-L" || token === "-P") continue;
    if (token === "(" || token === "!" || token.startsWith("-")) break;
    roots.push(token);
  }
  return roots.length > 0 ? roots : ["."];
}

function findNamePredicates(tokens) {
  const names = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "-name" || tokens[i] === "-iname") {
      const name = tokens[i + 1];
      if (name) names.push(name);
      i += 1;
    }
  }
  return names;
}

function findDeleteParentTargets(config, segment, commandIndex, cwd) {
  const names = findNamePredicates(segment);
  const roots = absoluteProtectedRoots(config);
  const targets = [];

  for (const searchRoot of findSearchRoots(segment, commandIndex + 1)) {
    const resolvedSearchRoot = resolveShellPath(config, searchRoot, cwd);
    for (const root of roots) {
      if (root === resolvedSearchRoot || !isUnderRoot(root, resolvedSearchRoot)) continue;
      const normalizedRoot = normalizeSeparators(root);
      const basename = normalizedRoot.slice(normalizedRoot.lastIndexOf("/") + 1);
      if (names.length === 0 || names.includes(basename)) {
        targets.push(root);
      }
    }
  }

  return targets;
}

function shellPayload(tokens, commandIndex) {
  const shellOptionsWithValues = new Set(["--command-timeout"]);
  for (let i = commandIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-c" || token === "--command") return tokens[i + 1];
    if (shellOptionsWithValues.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    if (/^-[A-Za-z]+$/.test(token) && token.includes("c")) return tokens[i + 1];
  }
  return undefined;
}

// --- PowerShell / cmd dialect coverage + fail-closed unknown verbs ---
//
// Grok's Windows shell tool is pwsh, so the model emits PowerShell cmdlets,
// not POSIX verbs. The POSIX passes above (cp/mv/rm/redirects) stay
// byte-aligned with the codex/TS source; this pass adds the pwsh/cmd dialect
// AND — critically — inverts the default so that ANY verb the parser does not
// recognize, when it touches a private path, fails closed. Enumerating bad
// verbs is a catch-up game on the only enforcement layer Windows has; the
// read-only allowlist is the explicit, small trust boundary instead.

/** PowerShell is case-insensitive and verbs may carry a `.exe` suffix. */
function dialectVerb(token) {
  return shellCommandName(token).toLowerCase().replace(/\.exe$/, "");
}

// Read-only inspection verbs — the explicit allowlist. A segment whose
// command is here never produces a target on its own, so legitimate
// listings/reads of private paths (the incident session's own
// `Get-ChildItem ~/.soma/memory/`) stay allowed. Content egress via a
// PIPE from a read-only reader is still caught by the piped pass.
const DIALECT_READ_ONLY_COMMANDS = new Set([
  // POSIX
  "ls", "cat", "bat", "head", "tail", "less", "more", "stat", "file", "wc",
  "grep", "rg", "egrep", "fgrep", "tree", "pwd", "echo", "printf", "realpath",
  "dirname", "basename", "test", "du", "df", "diff", "cmp", "od", "hexdump",
  // PowerShell cmdlets + aliases
  "get-childitem", "gci", "dir", "get-content", "gc", "type", "get-item", "gi",
  "get-itemproperty", "gp", "select-string", "sls", "measure-object", "measure",
  "format-table", "ft", "format-list", "fl", "format-wide", "out-string",
  "out-host", "write-output", "write-host", "resolve-path", "rvpa", "split-path",
  "test-path", "get-location", "gl", "select-object", "select", "where-object",
  "where", "foreach-object", "sort-object", "sort", "get-help", "get-command",
  "get-member", "compare-object",
]);

// Verbs the POSIX passes above already own — excluded from the
// fail-closed-unknown branch so they are not double-handled.
const DIALECT_POSIX_HANDLED = new Set([
  "cp", "mv", "rsync", "tee", "rm", "rmdir", "trash", "trash-put", "gtrash",
  "find", "bash", "sh", "zsh", "eval", "scp", "sftp",
]);

// pwsh + cmd transfer verbs (source path → destination). `cp`/`mv`/`tee`
// stay with the POSIX pass; these are the pwsh cmdlets, their aliases, and
// native copy execs reachable from pwsh.
const DIALECT_TRANSFER_COMMANDS = new Set([
  "copy-item", "copy", "cpi", "move-item", "move", "mi", "robocopy", "xcopy",
]);

// pwsh destructive verbs (delete protected paths). `rm`/`rmdir` stay POSIX.
const DIALECT_DESTRUCTIVE_COMMANDS = new Set([
  "remove-item", "del", "erase", "rd", "ri", "clear-content", "clc",
]);

// pwsh writing sinks — relevant as PIPE destinations (their source is
// stdin). Recognized so they are neither treated as unknown nor as the
// non-piped transfer shape; the piped pass turns a private source piped
// into one of these into an egress target.
const DIALECT_WRITE_SINK_COMMANDS = new Set([
  "out-file", "set-content", "sc", "add-content", "ac", "tee-object",
  "export-csv", "export-clixml",
]);

function isPowerShellWriteSink(command) {
  return DIALECT_WRITE_SINK_COMMANDS.has(dialectVerb(command));
}

/** `cmd /c <...>`, `powershell -Command <...>`, `pwsh -c <...>` payloads. */
function dialectNestedPayloadTokens(segment, commandIndex, verb) {
  if (verb === "cmd") {
    for (let i = commandIndex + 1; i < segment.length; i += 1) {
      const flag = segment[i].toLowerCase();
      if (flag === "/c" || flag === "/k") return segment.slice(i + 1);
    }
    return undefined;
  }
  if (verb === "powershell" || verb === "pwsh") {
    for (let i = commandIndex + 1; i < segment.length; i += 1) {
      const flag = segment[i].toLowerCase();
      // -Command / -c, prefix-abbreviated (PowerShell allows -Comm etc).
      if (flag === "-c" || (flag.length >= 2 && "-command".startsWith(flag))) {
        return tokenizeShellCommand(segment[i + 1] || "");
      }
    }
    return undefined;
  }
  return undefined;
}

/**
 * Build the shell-extraction entry point for one adapter. The descriptor
 * supplies ONLY the adapter's relative path-prefix lists:
 *
 *   {
 *     privatePathPrefixes:   [{ path: ".soma", bare: true }, ...],
 *     protectedPathPrefixes: [{ path: ".claude", bare: true }, ...],
 *   }
 *
 * Returns `extractShellTarget(config, context)`. The fail-closed structure
 * (unknown-verb deny, no-silent-pass backstop, read-only allowlist) is core behavior
 * the descriptor cannot reach: absolute-marker resolution through
 * `config.policyMarkers` runs regardless of the prefix lists.
 */
export function createShellPolicyExtractor(descriptor) {
  const privatePathPrefixes = descriptor?.privatePathPrefixes ?? [];
  const protectedPathPrefixes = descriptor?.protectedPathPrefixes ?? [];

  function hasPrivatePathReference(config, rawToken, cwd) {
    if (!rawToken) return false;
    if (hasSomaPolicyMarker(config, rawToken)) return true;
    // Re-test the separator/home-normalized form so backslash-tilde
    // (`~\.soma\...`) and relative backslash (`.soma\...`) markers are caught
    // by the literal-prefix and policy-marker substring checks below.
    const token = normalizeShellPathToken(rawToken);
    if (token !== rawToken && hasSomaPolicyMarker(config, token)) return true;
    if (privatePathPrefixes.some((entry) => matchesRelativePathPrefix(token, entry))) return true;
    const resolved = resolveShellPath(config, rawToken, cwd);
    return config.policyMarkers.some((marker) => isAbsolute(marker) && isUnderRoot(resolved, resolve(marker)));
  }

  function isProtectedPathReference(config, rawToken, cwd) {
    if (!rawToken) return false;
    if (hasPrivatePathReference(config, rawToken, cwd)) return true;
    const token = normalizeShellPathToken(rawToken);
    return protectedPathPrefixes.some((entry) => matchesRelativePathPrefix(token, entry));
  }

  function firstPrivatePathToken(config, tokens, cwd) {
    return tokens.find((token) => hasPrivatePathReference(config, token, cwd));
  }

  function protectedPathTokens(config, tokens, cwd) {
    return tokens.filter((token) => isProtectedPathReference(config, token, cwd));
  }

  function extractDestructiveShellTargets(config, tokens, cwd, depth = 0) {
    const destructiveTargets = [];
    for (const segment of shellSegments(tokens)) {
      const commandIndex = skipShellPrefixes(segment);
      const command = shellCommandName(segment[commandIndex]);

      if (depth < 4 && (command === "bash" || command === "sh" || command === "zsh")) {
        const payload = shellPayload(segment, commandIndex);
        if (payload) destructiveTargets.push(...extractDestructiveShellTargets(config, tokenizeShellCommand(payload), cwd, depth + 1));
        continue;
      }

      if (depth < 4 && command === "eval") {
        destructiveTargets.push(...extractDestructiveShellTargets(config, segment.slice(commandIndex + 1), cwd, depth + 1));
        continue;
      }

      if (command === "rm" || command === "rmdir" || command === "trash" || command === "trash-put" || command === "gtrash") {
        destructiveTargets.push(
          ...protectedPathTokens(config, shellPathArguments(segment, commandIndex + 1), cwd).map((token) => ({
            action: "delete",
            filePath: resolveShellPath(config, token, cwd),
            content: "",
          })),
        );
      }
      if (command === "find" && segment.includes("-delete")) {
        destructiveTargets.push(
          ...[
            ...protectedPathTokens(config, shellPathArguments(segment, commandIndex + 1), cwd).map((token) => resolveShellPath(config, token, cwd)),
            ...findDeleteParentTargets(config, segment, commandIndex, cwd),
          ].map((path) => ({
            action: "delete",
            filePath: path,
            content: "",
          })),
        );
      }
      if (command === "mv") {
        const args = shellPathArguments(segment, commandIndex + 1);
        const sourceArgs = args.length > 1 ? args.slice(0, -1) : args;
        destructiveTargets.push(
          ...protectedPathTokens(config, sourceArgs, cwd).map((token) => ({
            action: "modify",
            filePath: resolveShellPath(config, token, cwd),
            content: "",
          })),
        );
      }
    }
    return destructiveTargets;
  }

  function extractPrivateShellTransferTargets(config, tokens, cwd, depth = 0) {
    const transferTargets = [];
    for (const segment of shellSegments(tokens)) {
      const commandIndex = skipShellPrefixes(segment);
      const command = shellCommandName(segment[commandIndex]);

      if (depth < 4 && (command === "bash" || command === "sh" || command === "zsh")) {
        const payload = shellPayload(segment, commandIndex);
        if (payload) transferTargets.push(...extractPrivateShellTransferTargets(config, tokenizeShellCommand(payload), cwd, depth + 1));
        continue;
      }

      if (depth < 4 && command === "eval") {
        transferTargets.push(...extractPrivateShellTransferTargets(config, segment.slice(commandIndex + 1), cwd, depth + 1));
        continue;
      }

      const privateSource = firstPrivatePathToken(config, segment, cwd);
      if (!privateSource) {
        const redirectedDestination = redirectionTarget(segment);
        if (redirectedDestination) {
          const markerSource = segment.find((token) => hasPrivatePathReference(config, token, cwd));
          if (markerSource) {
            transferTargets.push({ filePath: resolveShellPath(config, redirectedDestination, cwd), sourcePath: resolveShellPath(config, markerSource, cwd), content: "" });
          }
        }
        continue;
      }

      if (command === "cp" || command === "mv" || command === "rsync") {
        const destination = lastPathToken(segment.slice(commandIndex + 1));
        if (destination && destination !== privateSource) {
          transferTargets.push({ filePath: resolveShellPath(config, destination, cwd), sourcePath: resolveShellPath(config, privateSource, cwd), content: "" });
        }
        continue;
      }

      const redirectedDestination = redirectionTarget(segment);
      if (redirectedDestination) {
        transferTargets.push({ filePath: resolveShellPath(config, redirectedDestination, cwd), sourcePath: resolveShellPath(config, privateSource, cwd), content: "" });
        continue;
      }

      if (command === "tee") {
        const destination = lastPathToken(segment.slice(commandIndex + 1));
        if (destination && destination !== privateSource) {
          transferTargets.push({ filePath: resolveShellPath(config, destination, cwd), sourcePath: resolveShellPath(config, privateSource, cwd), content: "" });
        }
      }
    }
    return transferTargets;
  }

  function extractPipedPrivateShellTransferTargets(config, tokens, cwd, depth = 0) {
    const transferTargets = [];
    let pipedPrivateSource;

    for (const { tokens: segment, operatorAfter } of shellSegmentsWithOperators(tokens)) {
      const commandIndex = skipShellPrefixes(segment);
      const command = shellCommandName(segment[commandIndex]);

      if (depth < 4 && (command === "bash" || command === "sh" || command === "zsh")) {
        const payload = shellPayload(segment, commandIndex);
        if (payload) transferTargets.push(...extractPipedPrivateShellTransferTargets(config, tokenizeShellCommand(payload), cwd, depth + 1));
        pipedPrivateSource = operatorAfter === "|" ? pipedPrivateSource : undefined;
        continue;
      }

      if (depth < 4 && command === "eval") {
        transferTargets.push(...extractPipedPrivateShellTransferTargets(config, segment.slice(commandIndex + 1), cwd, depth + 1));
        pipedPrivateSource = operatorAfter === "|" ? pipedPrivateSource : undefined;
        continue;
      }

      // pwsh pipelines write through cmdlet sinks (Out-File, Set-Content,
      // Tee-Object, Export-*), not just POSIX `tee`. A private source piped
      // into any writing sink is an egress.
      if (pipedPrivateSource && (command === "tee" || isPowerShellWriteSink(command))) {
        const destination = lastPathToken(shellPathArguments(segment, commandIndex + 1));
        if (destination) {
          transferTargets.push({ filePath: resolveShellPath(config, destination, cwd), sourcePath: resolveShellPath(config, pipedPrivateSource, cwd), content: "" });
        }
      }

      const privateSource = firstPrivatePathToken(config, segment, cwd);
      if (operatorAfter === "|") {
        pipedPrivateSource = privateSource || pipedPrivateSource;
      } else {
        pipedPrivateSource = undefined;
      }
    }

    return transferTargets;
  }

  /**
   * Dialect pass: pwsh/cmd transfer + destructive verbs, nesting, and
   * the fail-closed-unknown backstop. Reuses the POSIX helpers; emits the
   * same target shapes the policy engine already denies.
   */
  function extractDialectShellTargets(config, tokens, cwd, depth = 0) {
    const targets = [];
    for (const segment of shellSegments(tokens)) {
      const commandIndex = skipShellPrefixes(segment);
      const verb = dialectVerb(segment[commandIndex]);

      // Nesting first: a wrapped command is parsed, not treated as one
      // opaque allowed token.
      if (depth < 4 && (verb === "cmd" || verb === "powershell" || verb === "pwsh")) {
        const payload = dialectNestedPayloadTokens(segment, commandIndex, verb);
        if (payload) targets.push(...extractDialectShellTargets(config, payload, cwd, depth + 1));
        continue;
      }

      // Read-only allowlist and POSIX-owned verbs never fail closed here.
      if (DIALECT_READ_ONLY_COMMANDS.has(verb) || DIALECT_POSIX_HANDLED.has(verb)) continue;

      const pathArgs = shellPathArguments(segment, commandIndex + 1);

      if (DIALECT_TRANSFER_COMMANDS.has(verb)) {
        const privateSource = firstPrivatePathToken(config, pathArgs, cwd);
        if (privateSource) {
          const destination = lastPathToken(pathArgs);
          const resolvedSource = resolveShellPath(config, privateSource, cwd);
          const resolvedDest = destination ? resolveShellPath(config, destination, cwd) : resolvedSource;
          targets.push({
            ...(resolvedDest === resolvedSource ? { action: "modify" } : {}),
            filePath: resolvedDest,
            sourcePath: resolvedSource,
            content: "",
          });
        }
        continue;
      }

      if (DIALECT_DESTRUCTIVE_COMMANDS.has(verb)) {
        targets.push(
          ...protectedPathTokens(config, pathArgs, cwd).map((token) => ({
            action: "delete",
            filePath: resolveShellPath(config, token, cwd),
            content: "",
          })),
        );
        continue;
      }

      // Writing sinks are handled by the piped pass (their source is stdin);
      // recognized here so they are not misread as unknown.
      if (DIALECT_WRITE_SINK_COMMANDS.has(verb)) continue;

      // Fail-closed: an unrecognized verb that touches a private path must
      // produce a target so the policy check runs and denies. Same shape as
      // the transfer branch — a distinct destination keeps no explicit action
      // so the engine runs the private-source→public-dest leak check (a
      // per-target `action:"modify"` would instead ask "can I modify the
      // public dest?" and allow). Only when there is no separate destination
      // do we fall back to modify-of-private.
      const privateToken = firstPrivatePathToken(config, segment, cwd);
      if (privateToken) {
        // Resolve the source through the marker-aware backstop helper, not a
        // bare `resolveShellPath`. An opaque or glued token (e.g. `@<priv>`)
        // resolves to a toothless cwd-relative path that sits under NO private
        // root, so the emitted target was a no-op deny AND it preempted the
        // marker backstop below — a fail-open. On POSIX especially, the
        // unstripped prefix made the resolved path miss every root. The helper
        // falls back to the real private-root marker, keeping the deny
        // enforceable.
        const resolvedSource =
          matchedPrivateMarkerSource(config, segment, cwd) ?? resolveShellPath(config, privateToken, cwd);
        const destination = pathArgs.find((arg) => resolveShellPath(config, arg, cwd) !== resolvedSource);
        const resolvedDest = destination ? resolveShellPath(config, destination, cwd) : resolvedSource;
        targets.push({
          ...(resolvedDest === resolvedSource ? { action: "modify" } : {}),
          filePath: resolvedDest,
          sourcePath: resolvedSource,
          content: "",
        });
      }
    }
    return targets;
  }

  // The no-silent-pass invariant: each structured pass above can miss an
  // unforeseen shell form (a parser gap, a fabricated syntax, a
  // separator-mismatched marker). As a last-resort backstop, a segment that
  // carries a private-root marker but was classified by NO pass must still
  // produce a fail-closed target so `policy check` runs and denies. Read-only
  // inspection verbs (listings/reads) and writing sinks (their arg is a
  // destination being written, not a source being read out) are exempt so
  // legitimate inspection and in-place writes stay allowed (AC-5). The
  // per-form fixes remain so the common cases produce a precise
  // source/destination; this only catches what they don't.
  function matchedPrivateMarkerSource(config, segment, cwd) {
    // Prefer a token that RESOLVES to a path actually under a private root —
    // that yields a precise, enforceable source. A token can satisfy
    // hasPrivatePathReference via an embedded marker SUBSTRING (a marker glued
    // inside an opaque `iex"..."` / `$(...)` / `@`-prefixed token) yet resolve
    // to a path that is NOT under any root. Returning that path made the backstop
    // emit a target whose sourcePath fails the private-root test, so `policy
    // check` ALLOWED — a toothless deny. Require the resolved token to be under
    // a root here; if none is, fall through to the marker-root branch, whose
    // source IS a real private root, so the deny is enforceable.
    const roots = absoluteProtectedRoots(config);
    const resolvableToken = segment.find(
      (token) => hasPrivatePathReference(config, token, cwd) && roots.some((root) => isUnderRoot(resolveShellPath(config, token, cwd), root)),
    );
    if (resolvableToken) return resolveShellPath(config, resolvableToken, cwd);
    // No token resolves under a root, but the raw (separator-normalized) text
    // still carries an absolute private marker — use the marker root as the
    // source so the deny is enforceable.
    const text = normalizeSeparators(segment.join(" "));
    const marker = config.policyMarkers.find(
      (candidate) => isAbsolute(candidate) && text.includes(normalizeSeparators(candidate).replace(/\/+$/, "")),
    );
    if (marker) return resolve(marker);
    // A RELATIVE private prefix glued behind a non-path prefix
    // (`Frobnicate-Item @.soma/memory/x`) defeats the per-token relative
    // match — the token starts `@.soma/`, not `.soma/`, so
    // matchesRelativePathPrefix misses it — AND it carries no absolute
    // marker, so both scans above miss it: a fail-OPEN of the same class the
    // absolute branch closes. Scan the segment text for any descriptor
    // relative privatePathPrefix at a token/path boundary (case-folded on
    // win32, mirroring matchesRelativePathPrefix; the boundary keeps a glued
    // `@`/quote/`(` matching while a benign `my.somatic` does not) and emit
    // that prefix's absolute root — anchored at the soma-home parent — so the
    // deny is enforceable: the `.soma` root is config.somaHome, a private
    // scope root `policy check` always honors regardless of policyMarkers.
    const home = somaHomeParent(config);
    if (home) {
      const fold = process.platform === "win32";
      const folded = fold ? text.toLowerCase() : text;
      // A boundary char is anything that cannot continue a path token.
      const boundary = "[^A-Za-z0-9._/~-]";
      for (const entry of privatePathPrefixes) {
        const prefix = fold ? entry.path.toLowerCase() : entry.path;
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const prefixed = new RegExp(`(?:^|${boundary})${escaped}/`);
        const bare = entry.bare ? new RegExp(`(?:^|${boundary})${escaped}(?:$|${boundary})`) : undefined;
        if (prefixed.test(folded) || (bare && bare.test(folded))) {
          return resolve(home, entry.path);
        }
      }
    }
    return undefined;
  }

  function extractFailClosedBackstopTargets(config, tokens, cwd) {
    const fallbackDestination = cwd || process.cwd();
    const targets = [];
    for (const segment of shellSegments(tokens)) {
      if (segment.length === 0) continue;
      const verb = dialectVerb(segment[skipShellPrefixes(segment)]);
      if (DIALECT_READ_ONLY_COMMANDS.has(verb) || DIALECT_WRITE_SINK_COMMANDS.has(verb)) continue;
      const sourcePath = matchedPrivateMarkerSource(config, segment, cwd);
      if (!sourcePath) continue;
      // sourcePath is a private root; the working dir is the best-effort
      // public destination. A distinct destination keeps no explicit action
      // so the engine runs the private-source -> public-dest leak check.
      targets.push({
        ...(fallbackDestination === sourcePath ? { action: "modify" } : {}),
        filePath: fallbackDestination,
        sourcePath,
        content: "",
      });
    }
    return targets;
  }

  return function extractShellTarget(config, context) {
    const tokens = tokenizeShellCommand(context.command);
    const destructiveTargets = extractDestructiveShellTargets(config, tokens, context.cwd);
    const transferTargets = extractPrivateShellTransferTargets(config, tokens, context.cwd);
    const pipedTransferTargets = extractPipedPrivateShellTransferTargets(config, tokens, context.cwd);
    // pwsh/cmd dialect coverage + fail-closed unknown verbs.
    const dialectTargets = extractDialectShellTargets(config, tokens, context.cwd);
    const structured = [...destructiveTargets, ...transferTargets, ...pipedTransferTargets, ...dialectTargets];
    if (structured.length > 0) return structured;
    // No structured pass produced a target — fail closed if a private
    // marker is nonetheless present in a non-read-only/non-sink segment.
    return extractFailClosedBackstopTargets(config, tokens, context.cwd);
  };
}
