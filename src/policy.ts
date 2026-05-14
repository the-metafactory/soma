import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appendSomaMemoryEvent } from "./memory";
import type { SomaPolicyCheckOptions, SomaPolicyCheckResult, SomaPolicyFinding } from "./types";

function resolveSomaHome(options: Pick<SomaPolicyCheckOptions, "homeDir" | "somaHome"> = {}): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

function normalizePath(path: string, baseDir = process.cwd(), homeDir?: string): string {
  const expanded = path.startsWith("~/") ? join(homeDir ?? homedir(), path.slice(2)) : path;
  return resolve(isAbsolute(expanded) ? expanded : join(baseDir, expanded));
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function somaPolicyPrivateRoots(somaHome: string, homeDir?: string): string[] {
  const home = resolve(homeDir ?? homedir());

  return [
    join(somaHome, "profile"),
    join(somaHome, "memory"),
    join(home, ".codex", "memories", "soma"),
    join(home, ".codex", "skills", "soma"),
    join(home, ".pi", "agent", "soma"),
    join(home, ".pi", "agent", "skills", "soma"),
  ].map((path) => resolve(path));
}

function realScopePath(path: string): string {
  let cursor = path;
  const suffix: string[] = [];

  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return path;
    suffix.unshift(cursor.slice(parent.length + 1));
    cursor = parent;
  }

  const realCursor = realpathSync(cursor);
  return suffix.length > 0 ? resolve(realCursor, ...suffix) : realCursor;
}

function markerFor(path: string, homeDir?: string): string {
  return path.replace(resolve(homeDir ?? homedir()), "~");
}

function somaPolicyPrivateMarkers(somaHome: string, homeDir?: string): string[] {
  const roots = somaPolicyPrivateRoots(somaHome, homeDir);
  return Array.from(new Set(roots.flatMap((root) => [root, markerFor(root, homeDir)]))).sort((left, right) => right.length - left.length);
}

function findPrivateMarkers(content: string, somaHome: string, homeDir?: string): SomaPolicyFinding[] {
  if (!content) return [];

  return somaPolicyPrivateMarkers(somaHome, homeDir)
    .filter((marker) => content.includes(marker))
    .map((marker) => ({
      kind: "private-marker" as const,
      detail: marker,
    }));
}

export function evaluateSomaPolicy(options: SomaPolicyCheckOptions): SomaPolicyCheckResult {
  const somaHome = resolveSomaHome(options);
  const destinationPath = normalizePath(options.destinationPath, process.cwd(), options.homeDir);
  const destinationScopePath = realScopePath(destinationPath);
  const sourcePath = options.sourcePath ? normalizePath(options.sourcePath, process.cwd(), options.homeDir) : undefined;
  const sourceScopePath = sourcePath ? realScopePath(sourcePath) : undefined;
  const roots = somaPolicyPrivateRoots(somaHome, options.homeDir);
  const rootScopes = roots.map((root) => realScopePath(root));
  const findings: SomaPolicyFinding[] = [];
  const destinationIsPrivate = roots.some((root, index) => isInside(destinationPath, root) && isInside(destinationScopePath, rootScopes[index]));
  const destinationIsPublic = !destinationIsPrivate;

  if (destinationIsPublic && sourcePath && roots.some((root, index) => isInside(sourcePath, root) || isInside(sourceScopePath ?? sourcePath, rootScopes[index]))) {
    findings.push({
      kind: "private-source",
      detail: markerFor(sourcePath, options.homeDir),
    });
  }

  if (destinationIsPublic) {
    findings.push(...findPrivateMarkers(options.content ?? "", somaHome, options.homeDir));
  }

  const decision = findings.length > 0 ? "deny" : "allow";
  const reason =
    decision === "deny"
      ? `Private Soma context cannot be written to public destination ${markerFor(destinationPath, options.homeDir)}.`
      : `No private Soma source markers found for ${markerFor(destinationPath, options.homeDir)}.`;

  return {
    somaHome,
    decision,
    reason,
    findings,
  };
}

export async function checkSomaPolicy(options: SomaPolicyCheckOptions): Promise<SomaPolicyCheckResult> {
  const result = evaluateSomaPolicy(options);
  const record = options.record ?? "all";

  if (record === "none" || (record === "deny" && result.decision !== "deny")) {
    return result;
  }

  const event = await appendSomaMemoryEvent(result.somaHome, {
    timestamp: options.timestamp,
    substrate: options.substrate ?? "custom",
    kind: "policy.check",
    summary: `${result.decision}: ${result.reason}`,
    artifactPaths: [
      normalizePath(options.destinationPath, process.cwd(), options.homeDir),
      ...(options.sourcePath ? [normalizePath(options.sourcePath, process.cwd(), options.homeDir)] : []),
    ],
    metadata: {
      action: options.action,
      findings: result.findings,
    },
  });

  return {
    ...result,
    event,
  };
}
