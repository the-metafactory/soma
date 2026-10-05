/**
 * Secret redaction for reading config files into a model's context (soma#716).
 *
 * The `secret-read` runtime-policy rule denies raw reads of secret-bearing
 * config and points here: `soma redact <path|->` prints the same text with
 * secret VALUES masked and everything else — keys, structure, paths, public
 * NKEYs — left readable, so the assistant can still reason about the file.
 *
 * Masked: JWTs, NKEY seeds, creds/private-key blocks, long hex strings, URL
 * userinfo passwords, the whole value of a secret-named key in yaml/conf/json
 * (numbers and block scalars included), and every `.env` value that is not a
 * path, a reference or a literal. A SHA-256 digest beside a hash-like word stays.
 *
 * This is a heuristic, not a guarantee: it masks what it recognises. That is
 * the right trade for its job — keeping secrets out of a transcript by
 * accident — and the wrong one for publishing a file.
 */

import { basename } from "node:path";

export interface RedactOptions {
  /** Treat every `KEY=value` line as `.env`, masking all non-path values. */
  envFile?: boolean;
  /** Prefix each line with its 1-based number, `cat -n` style. */
  number?: boolean;
}

export interface RedactResult {
  text: string;
  /** Number of values masked. */
  redacted: number;
}

const SECRET_KEY =
  /(pass(word|wd)?|secret|token|api[_-]?key|apikey|auth|credential|private[_-]?key|\bpat\b|_pat$|webhook[_-]?secret|payload[_-]?key|seed)$/iu;

/** A `.env` basename, including `.env.local`, `.env.production`, `prod.env`. */
export function isEnvFileName(path: string): boolean {
  const name = basename(path);
  return /^\.env(\..+)?$/u.test(name) || /\.env$/u.test(name);
}

/** Literals that carry no secret even under a secret-named key. Numbers are NOT here: a PIN is a number. */
const LITERAL = /^(true|false|null|~|\[\]|\{\}|""|'')$/iu;
const NUMBER = /^-?\d+(\.\d+)?$/u;
const ALREADY_MASKED = /^<redacted:[^>]+>$/u;

/** `${VAR}`, `$VAR` and `__PLACEHOLDER__` name a secret held elsewhere. */
const indentOf = (line: string) => /^\s*/u.exec(line)?.[0] ?? "";

/**
 * The value names a secret held elsewhere instead of holding one: a whole
 * `${VAR}` (optionally followed by a path, `${BASE}/v1`) or `__PLACEHOLDER__`.
 * A bare `$NAME` is a reference only in `.env`, where dotenv expands it; in
 * yaml/conf/json `password: $ecretPass` is a literal password.
 */
const isReference = (value: string, envFormat: boolean) =>
  /^\$\{[A-Za-z_][A-Za-z0-9_]*\}(?:\/[\w./-]*)?$/u.test(value) ||
  /^__[A-Z0-9_]+__$/u.test(value) ||
  (envFormat && /^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(value));

/**
 * A filesystem path, which stays readable. Narrower than "starts with `/`": a
 * base64 secret can start with `/` too, so a path must use path characters
 * only (no `+` or `=`) and have a second segment or an extension.
 */
const isPathValue = (value: string) =>
  value.length <= 200 && /^(?:~|\.{1,2})?\/[\w.@~/-]*$/u.test(value) && (value.indexOf("/", 1) !== -1 || value.includes("."));

/** A YAML block scalar indicator (`|`, `>-`, `|+2`): the value is on the following, deeper-indented lines. */
const BLOCK_SCALAR = /^[|>][+-]?\d?[+-]?$/u;

/**
 * Split the text after `key:` / `KEY=` into the value and what surrounds it, so
 * the mask replaces exactly the value. A quoted value runs to its closing quote
 * (so `,` `}` `#` inside it are part of the secret). An unquoted value runs to
 * a ` #` comment or the end of the line; in JSON a trailing `,` or `}` is
 * syntax, not value.
 */
function splitValue(rest: string, jsonish: boolean): { open: string; value: string; close: string } {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    let end = 1;
    while (end < rest.length && rest[end] !== quote) end += rest[end] === "\\" && quote === '"' ? 2 : 1;
    if (end >= rest.length) return { open: quote, value: rest.slice(1), close: "" };
    return { open: quote, value: rest.slice(1, end), close: rest.slice(end) };
  }
  const comment = rest.search(/\s#/u);
  let value = comment === -1 ? rest : rest.slice(0, comment);
  let close = comment === -1 ? "" : rest.slice(comment);
  const trailing = /[\s]*$/u.exec(value)?.[0] ?? "";
  value = value.slice(0, value.length - trailing.length);
  close = trailing + close;
  if (jsonish) {
    const syntax = /[,}\]]+$/u.exec(value)?.[0] ?? "";
    value = value.slice(0, value.length - syntax.length);
    close = syntax + close;
  }
  return { open: "", value, close };
}

/** True when `value` under a key must be masked. Secret-named keys mask numbers too. */
function shouldMask(value: string, secretKey: boolean, envFormat = false): boolean {
  if (value === "" || LITERAL.test(value) || ALREADY_MASKED.test(value) || isReference(value, envFormat) || isPathValue(value)) return false;
  return secretKey || !NUMBER.test(value);
}

export function redactSecrets(text: string, options: RedactOptions = {}): RedactResult {
  let redacted = 0;
  let blockIndent: number | null = null;
  const mask = (label: string) => {
    redacted += 1;
    return `<redacted:${label}>`;
  };

  function redactBody(line: string, envLike: boolean): string {
    let out = line
      .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, () => mask("jwt"))
      .replace(/\bS[AUONCPX][A-Z2-7]{50,}\b/gu, () => mask("nkey-seed"))
      .replace(/\b[a-fA-F0-9]{40,}\b/gu, (match) => (match.length === 64 && /sha256|hash|digest|sum/iu.test(line) ? match : mask("hex")))
      // `scheme://user:password@host` — a credential under a key that is not secret-named (`url:`, a NATS remote).
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)([^\s@/"']+)(@)/giu, (_all, pre: string, _password: string, at: string) => `${pre}${mask("url-password")}${at}`);

    // .env: KEY=VALUE — every value except paths, references and literals;
    // numbers stay only under keys that are not secret-named (`PORT=8080`).
    if (envLike) {
      const match = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)(.*)$/u.exec(out);
      if (!match) return out;
      const { open, value, close } = splitValue(match[3], false);
      return shouldMask(value, SECRET_KEY.test(match[2]), true) ? `${match[1]}${open}${mask("env-value")}${close}` : out;
    }

    // key: value / key = value / "key": "value" with a secret-looking key.
    const pair = /^(\s*-?\s*(["']?)([A-Za-z0-9_.-]+)\2\s*[:=]\s*)(.*)$/u.exec(out);
    if (pair && SECRET_KEY.test(pair[3])) {
      const { open, value, close } = splitValue(pair[4], pair[2] === '"');
      if (BLOCK_SCALAR.test(value)) {
        blockIndent = indentOf(out).length;
        return out;
      }
      if (shouldMask(value, true)) return `${pair[1]}${open}${mask(pair[3])}${close}`;
    }

    // Inline pairs like `{ user: "x", "password": "p,w" }`: a quoted value under
    // a secret-named key anywhere on the line.
    return out.replace(
      /(^|[{,\s])(["']?)([A-Za-z0-9_.-]+)\2(\s*:\s*)(["'])((?:\\.|(?!\5).)*)\5/gu,
      (all, lead: string, keyQuote: string, key: string, separator: string, quote: string, value: string) =>
        SECRET_KEY.test(key) && shouldMask(value, true) ? `${lead}${keyQuote}${key}${keyQuote}${separator}${quote}${mask("inline")}${quote}` : all,
    );
  }

  function redactLine(raw: string): string {
    // `grep -n`, `rg` and rtk prefix lines with "path:N:", "N:" or "N:0:". Split
    // the prefix off so the key rules see the real line, then put it back.
    const prefix = raw.match(/^((?:[^\s:]+[:-])?\d+(?::\d+)?[:-])(?=\s|["'A-Za-z_-])/u)?.[1] ?? "";
    const body = raw.slice(prefix.length);
    // An UPPER_CASE=value line is `.env` even on stdin, where the name is unknown.
    const envLike = options.envFile === true || /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*=/u.test(body);
    return prefix + redactBody(body, envLike);
  }

  let inSeedBlock = false;
  const lines = text.split("\n").map((line) => {
    // Inside a block scalar under a secret-named key (`password: |`): every
    // deeper-indented or blank line is the value.
    if (blockIndent !== null) {
      if (line.trim() === "") return line;
      if (indentOf(line).length > blockIndent) return `${indentOf(line)}${mask("block-scalar")}`;
      blockIndent = null;
    }
    if (/-----BEGIN [A-Z ]*(SEED|PRIVATE KEY)-----/u.test(line)) {
      inSeedBlock = true;
      return line;
    }
    if (/-----END [A-Z ]*(SEED|PRIVATE KEY)-----/u.test(line)) {
      inSeedBlock = false;
      return line;
    }
    return inSeedBlock && line.trim() !== "" ? mask("seed-block") : redactLine(line);
  });

  const shown = options.number ? lines.map((line, index) => `${String(index + 1).padStart(6)}\t${line}`) : lines;
  return { text: shown.join("\n"), redacted };
}
