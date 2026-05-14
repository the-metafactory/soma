import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hasSomaPolicyPrivateMarker } from "./policy-marker";
import type { SomaPolicyBatchCheckOptions, SomaPolicyBatchCheckResult, SomaPolicyBatchTarget, SomaPolicyCheckOptions, SomaPolicyCheckResult, SomaPolicyFinding } from "./types";

function resolveSomaHome(options: Pick<SomaPolicyCheckOptions, "homeDir" | "somaHome"> = {}): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

export function normalizeSomaPolicyPath(path: string, baseDir = process.cwd(), homeDir?: string): string {
  const expanded = path.startsWith("~/") ? join(homeDir ?? homedir(), path.slice(2)) : path;
  return resolve(isAbsolute(expanded) ? expanded : join(baseDir, expanded));
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function somaPolicyPrivateRoots(somaHome: string, privateRoots: string[] = []): string[] {
  return [somaHome, ...privateRoots].map((path) => resolve(path));
}

const SOMA_POLICY_PORTABLE_MARKERS = [
  "~/.soma",
  "~/.codex/memories/soma",
  "~/.codex/skills/soma",
  "~/.pi/agent/soma",
  "~/.pi/agent/skills/soma",
] as const;

interface SomaPolicyScope {
  destinationPath: string;
  destinationScopePath: string;
  sourcePath?: string;
  sourceScopePath?: string;
  roots: string[];
  rootScopes: string[];
  somaHome: string;
}

async function realScopePath(path: string): Promise<string> {
  let cursor = path;
  const suffix: string[] = [];

  while (!(await pathExists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) return path;
    suffix.unshift(cursor.slice(parent.length + 1));
    cursor = parent;
  }

  const realCursor = await realpath(cursor);
  return suffix.length > 0 ? resolve(realCursor, ...suffix) : realCursor;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function markerFor(path: string, homeDir?: string): string {
  const home = resolve(homeDir ?? homedir());
  const resolvedPath = resolve(path);

  if (!isInside(resolvedPath, home)) {
    return path;
  }

  const rel = relative(home, resolvedPath);
  return rel === "" ? "~" : `~/${rel}`;
}

export function somaPolicyPrivateMarkers(somaHome: string, homeDir?: string, privateRoots: string[] = []): string[] {
  const roots = somaPolicyPrivateRoots(somaHome, privateRoots);
  return Array.from(new Set([...roots.flatMap((root) => [root, markerFor(root, homeDir)]), ...SOMA_POLICY_PORTABLE_MARKERS])).sort((left, right) => right.length - left.length);
}

export { hasSomaPolicyPrivateMarker };

function findPrivateMarkers(content: string, somaHome: string, homeDir?: string, privateRoots: string[] = []): SomaPolicyFinding[] {
  if (!content) return [];

  return somaPolicyPrivateMarkers(somaHome, homeDir, privateRoots)
    .filter((marker) => hasSomaPolicyPrivateMarker(content, marker))
    .map((marker) => ({
      kind: "private-marker" as const,
      detail: marker,
    }));
}

function unresolvedPolicyScope(options: SomaPolicyCheckOptions): Omit<SomaPolicyScope, "destinationScopePath" | "sourceScopePath" | "rootScopes"> {
  const somaHome = resolveSomaHome(options);
  const destinationPath = normalizeSomaPolicyPath(options.destinationPath, process.cwd(), options.homeDir);
  const sourcePath = options.sourcePath ? normalizeSomaPolicyPath(options.sourcePath, process.cwd(), options.homeDir) : undefined;
  const roots = somaPolicyPrivateRoots(somaHome, options.privateRoots);

  return {
    destinationPath,
    sourcePath,
    roots,
    somaHome,
  };
}

function evaluateResolvedSomaPolicy(options: SomaPolicyCheckOptions, scope: SomaPolicyScope): SomaPolicyCheckResult {
  const { destinationPath, destinationScopePath, sourcePath, sourceScopePath, roots, rootScopes, somaHome } = scope;
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
    findings.push(...findPrivateMarkers(options.content ?? "", somaHome, options.homeDir, roots.filter((root) => root !== somaHome)));
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

export function evaluateSomaPolicy(options: SomaPolicyCheckOptions): SomaPolicyCheckResult {
  const scope = unresolvedPolicyScope(options);

  return evaluateResolvedSomaPolicy(options, {
    ...scope,
    destinationScopePath: scope.destinationPath,
    sourceScopePath: scope.sourcePath,
    rootScopes: scope.roots,
  });
}

export async function evaluateSomaPolicyWithFilesystem(options: SomaPolicyCheckOptions, rootScopes?: string[]): Promise<SomaPolicyCheckResult> {
  const scope = unresolvedPolicyScope(options);

  return evaluateResolvedSomaPolicy(options, {
    ...scope,
    destinationScopePath: await realScopePath(scope.destinationPath),
    sourceScopePath: scope.sourcePath ? await realScopePath(scope.sourcePath) : undefined,
    rootScopes: rootScopes ?? (await Promise.all(scope.roots.map((root) => realScopePath(root)))),
  });
}

export async function evaluateSomaPolicyBatch(options: SomaPolicyBatchCheckOptions): Promise<SomaPolicyBatchCheckResult> {
  const somaHome = resolveSomaHome(options);
  const rootScopes = await Promise.all(somaPolicyPrivateRoots(somaHome, options.privateRoots).map((root) => realScopePath(root)));
  const results = await Promise.all(
    options.targets.map((target) => evaluateSomaPolicyWithFilesystem(policyOptionsForTarget(options, target), rootScopes)),
  );
  const denied = results.find((result) => result.decision === "deny");

  return {
    decision: denied ? "deny" : "allow",
    reason: denied?.reason ?? "No private Soma source markers found in batch.",
    results,
  };
}

export function policyOptionsForTarget(options: Omit<SomaPolicyBatchCheckOptions, "targets">, target: SomaPolicyBatchTarget): SomaPolicyCheckOptions {
  return {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    privateRoots: options.privateRoots,
    substrate: options.substrate,
    action: options.action,
    destinationPath: target.filePath,
    sourcePath: target.sourcePath,
    content: target.content,
    record: options.record,
    timestamp: options.timestamp,
  };
}
