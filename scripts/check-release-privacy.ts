#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

export interface ReleasePrivacyForbiddenHash {
  label: string;
  sha256: string;
}

export interface ReleasePrivacyFinding {
  file: string;
  kind: "private-marker" | "forbidden-hash";
  label: string;
  line?: number;
}

export interface ReleasePrivacyScanOptions {
  root: string;
  files?: string[];
  forbiddenHashes?: ReleasePrivacyForbiddenHash[];
}

const DEFAULT_FORBIDDEN_HASHES: ReleasePrivacyForbiddenHash[] = [
  {
    label: "publisher TELOS mission phrase",
    sha256: "64ee2fa8a1775aa82e46321051f8380a7ba8ae99ab4c575b2d28e3f934d1ba57",
  },
];

const PRIVATE_MARKERS: { label: string; pattern: RegExp }[] = [
  {
    label: "absolute private PAI USER root",
    pattern: /\/Users\/[^/\s]+\/\.claude\/PAI\/USER\b/,
  },
  {
    label: "absolute private Soma profile root",
    pattern: /\/Users\/[^/\s]+\/\.soma\/profile\b/,
  },
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isWithinPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function readTextFile(path: string): Promise<string | null> {
  const stat = await lstat(path);
  if (!stat.isFile()) return null;
  const bytes = await readFile(path);
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

function gitTrackedFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function scanPrivateMarkers(file: string, content: string): ReleasePrivacyFinding[] {
  const findings: ReleasePrivacyFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const marker of PRIVATE_MARKERS) {
      if (marker.pattern.test(lines[i])) {
        findings.push({
          file,
          kind: "private-marker",
          label: marker.label,
          line: i + 1,
        });
      }
    }
  }
  return findings;
}

function scanForbiddenHashes(
  file: string,
  content: string,
  forbiddenHashes: readonly ReleasePrivacyForbiddenHash[],
): ReleasePrivacyFinding[] {
  const wanted = new Map(forbiddenHashes.map((entry) => [entry.sha256.toLowerCase(), entry.label]));
  if (wanted.size === 0) return [];
  const findings: ReleasePrivacyFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const tokens = normalizeTokens(lines[lineIndex]);
    for (let start = 0; start < tokens.length; start += 1) {
      for (let length = 1; length <= 12 && start + length <= tokens.length; length += 1) {
        const digest = sha256(tokens.slice(start, start + length).join(" "));
        const label = wanted.get(digest);
        if (label) {
          findings.push({
            file,
            kind: "forbidden-hash",
            label,
            line: lineIndex + 1,
          });
        }
      }
    }
  }
  return findings;
}

export async function scanReleasePrivacy(
  options: ReleasePrivacyScanOptions,
): Promise<ReleasePrivacyFinding[]> {
  const root = resolve(options.root);
  const files = options.files ?? gitTrackedFiles(root);
  const forbiddenHashes = options.forbiddenHashes ?? DEFAULT_FORBIDDEN_HASHES;
  const findings: ReleasePrivacyFinding[] = [];
  for (const file of files) {
    const target = resolve(root, file);
    if (!isWithinPath(root, target)) {
      throw new Error(`Refusing to scan path outside root: ${file}`);
    }
    const content = await readTextFile(target);
    if (content === null) continue;
    findings.push(...scanPrivateMarkers(file, content));
    findings.push(...scanForbiddenHashes(file, content, forbiddenHashes));
  }
  return findings.sort((a, b) => `${a.file}:${a.line ?? 0}:${a.label}`.localeCompare(`${b.file}:${b.line ?? 0}:${b.label}`));
}

function parseArgs(argv: string[]): ReleasePrivacyScanOptions {
  let root = process.cwd();
  const files: string[] = [];
  const forbiddenHashes: ReleasePrivacyForbiddenHash[] = [...DEFAULT_FORBIDDEN_HASHES];
  const readOptionValue = (option: string, index: number): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} expects a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      root = readOptionValue(arg, i);
      i += 1;
    } else if (arg === "--file") {
      files.push(readOptionValue(arg, i));
      i += 1;
    } else if (arg === "--forbidden-sha256") {
      const value = readOptionValue(arg, i);
      i += 1;
      const [label, hash] = value.split(":");
      if (!label || !hash || !/^[a-f0-9]{64}$/i.test(hash)) {
        throw new Error("--forbidden-sha256 expects label:<64-hex-sha256>");
      }
      forbiddenHashes.push({ label, sha256: hash });
    } else if (arg === "--help") {
      console.log("Usage: bun scripts/check-release-privacy.ts [--root <dir>] [--file <path>] [--forbidden-sha256 label:<sha256>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return {
    root,
    ...(files.length > 0 ? { files } : {}),
    forbiddenHashes,
  };
}

if (import.meta.main) {
  try {
    const findings = await scanReleasePrivacy(parseArgs(Bun.argv.slice(2)));
    if (findings.length > 0) {
      console.error("[release-privacy] FAIL — private release markers found:");
      for (const finding of findings) {
        const line = finding.line ? `:${finding.line}` : "";
        console.error(`- ${finding.file}${line} [${finding.kind}] ${finding.label}`);
      }
      process.exit(1);
    }
    console.log("[release-privacy] ok — no private release markers found.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[release-privacy] runtime error: ${message}`);
    process.exit(2);
  }
}
