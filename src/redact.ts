/**
 * Secret redaction for reading config files into a model's context (soma#716).
 *
 * The `secret-read` runtime-policy rule denies raw reads of secret-bearing
 * config and points here: `soma redact <path|->` prints the same text with
 * secret VALUES masked and everything else — keys, structure, paths, public
 * NKEYs — left readable, so an agent can still reason about the file.
 *
 * Masked: JWTs, NKEY seeds, creds/private-key blocks, long hex strings, the
 * values of secret-named keys in yaml/conf/json, and every `.env` value that is
 * not a path or a plain scalar. A SHA-256 digest beside a hash-like word stays.
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

const isPathish = (value: string) => /^["']?(~|\/|\.\/|\$\{|__[A-Z0-9_]+__|\{)/u.test(value);
const isPlain = (value: string) => /^["']?(true|false|null|-?\d+(\.\d+)?|\[\]|"")["']?$/iu.test(value) || value === "";

export function redactSecrets(text: string, options: RedactOptions = {}): RedactResult {
  let redacted = 0;
  const mask = (label: string) => {
    redacted += 1;
    return `<redacted:${label}>`;
  };

  function redactBody(line: string, envLike: boolean): string {
    let out = line
      .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, () => mask("jwt"))
      .replace(/\bS[AUONCPX][A-Z2-7]{50,}\b/gu, () => mask("nkey-seed"))
      .replace(/\b[a-fA-F0-9]{40,}\b/gu, (match) => (match.length === 64 && /sha256|hash|digest|sum/iu.test(line) ? match : mask("hex")));

    // .env: KEY=VALUE — every value except paths and plain scalars.
    if (envLike) {
      const match = out.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.*)$/u);
      if (match) {
        const value = match[2].trim();
        if (!isPathish(value) && !isPlain(value) && !value.includes("<redacted:")) return match[1] + mask("env-value");
      }
      return out;
    }

    // key: value / key = value / "key": "value" with a secret-looking key.
    out = out.replace(
      /^(\s*-?\s*["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*)(["']?)([^"'#\s,}][^"'#,}]*?)(\3)(\s*(?:[,}]|#.*)?\s*)$/u,
      (all, pre: string, key: string, quote: string, value: string, closing: string, post: string) => {
        if (!SECRET_KEY.test(key) || isPathish(value) || isPlain(value) || value.includes("<redacted:")) return all;
        return `${pre}${quote}${mask(key)}${closing}${post}`;
      },
    );
    // Inline pairs like `{ user: "x", password: "y" }`.
    return out.replace(/((?:password|pass|token|secret)\s*:\s*)(["'])([^"']+)\2/giu, (all, pre: string, quote: string, value: string) =>
      value.includes("<redacted:") ? all : `${pre}${quote}${mask("inline")}${quote}`,
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
  const lines = text.split("\n").map((line, index) => {
    let shown: string;
    if (/-----BEGIN [A-Z ]*(SEED|PRIVATE KEY)-----/u.test(line)) {
      inSeedBlock = true;
      shown = line;
    } else if (/-----END [A-Z ]*(SEED|PRIVATE KEY)-----/u.test(line)) {
      inSeedBlock = false;
      shown = line;
    } else if (inSeedBlock && line.trim() !== "") {
      shown = mask("seed-block");
    } else {
      shown = redactLine(line);
    }
    return options.number ? `${String(index + 1).padStart(6)}\t${shown}` : shown;
  });

  return { text: lines.join("\n"), redacted };
}
