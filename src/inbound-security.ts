import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { createPaths } from "./paths";
import { appendSomaMemoryEvent } from "./memory";
import type {
  InboundContentDecision,
  InboundContentScanOptions,
  InboundContentScanOutput,
  InboundContentScanResult,
  InboundContentScanner,
  InboundContentSecurityConfig,
  InboundContentPromotionResult,
  SubstrateId,
} from "./types";

export function inboundContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function defaultInboundContentSecurityConfig(options: Pick<InboundContentScanOptions, "homeDir" | "somaHome"> = {}): InboundContentSecurityConfig {
  const paths = createPaths(options);
  return {
    untrustedRoots: [paths.resolve("memory", "RAW", "untrusted")],
    traceRoot: paths.resolve("memory", "SECURITY", "inbound-content"),
  };
}

function normalizeDecision(decision: string): InboundContentDecision {
  const normalized = decision.toUpperCase().replace(/[-\s]+/gu, "_");
  if (normalized === "ALLOWED" || normalized === "BLOCKED" || normalized === "HUMAN_REVIEW") return normalized;
  return "HUMAN_REVIEW";
}

export function createDeterministicInboundContentScanner(): InboundContentScanner {
  return {
    id: "soma-deterministic-inbound-v0",
    scan(input) {
      const content = input.content.toLowerCase();
      if (/\b(ignore|override)\s+(all\s+)?(previous|prior|system|developer)\s+instructions\b/u.test(content)) {
        return {
          decision: "BLOCKED",
          reason: "Inbound content attempts to override higher-priority instructions.",
          findings: [{ kind: "prompt-injection", detail: "instruction override pattern" }],
        };
      }
      if (/\b(exfiltrate|leak|steal)\b.{0,80}\b(secret|token|credential|private key|memory)\b/u.test(content)) {
        return {
          decision: "BLOCKED",
          reason: "Inbound content includes credential or private-memory exfiltration intent.",
          findings: [{ kind: "credential-egress", detail: "exfiltration pattern" }],
        };
      }
      if (/\b(jailbreak|roleplay as|do anything now|disable (safety|security|policy))\b/u.test(content)) {
        return {
          decision: "HUMAN_REVIEW",
          reason: "Inbound content contains ambiguous jailbreak or policy-disable language.",
          findings: [{ kind: "review-required", detail: "ambiguous adversarial language" }],
        };
      }
      return {
        decision: "ALLOWED",
        reason: "No deterministic inbound-content findings.",
        findings: [],
      };
    },
  };
}

function eventRecordAllowed(record: InboundContentScanOptions["record"], decision: InboundContentDecision): boolean {
  const mode = record ?? "all";
  return mode === "all" || (mode === "deny" && decision !== "ALLOWED");
}

async function writeInboundTrace(
  somaHome: string,
  result: InboundContentScanResult,
  input: Pick<InboundContentScanOptions, "sourcePath" | "sourceUri" | "timestamp">,
): Promise<string> {
  const traceRoot = defaultInboundContentSecurityConfig({ somaHome }).traceRoot;
  const timestamp = input.timestamp ?? new Date().toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/gu, "-");
  const tracePath = join(traceRoot, `${safeTimestamp}-${result.contentHash.slice(0, 16)}.json`);
  const payload = {
    timestamp,
    decision: result.decision,
    reason: result.reason,
    scanner: result.scanner,
    contentRef: {
      algorithm: "sha256",
      hash: result.contentHash,
    },
    findings: result.findings,
    sourcePath: input.sourcePath,
    sourceUri: input.sourceUri,
  };

  await mkdir(dirname(tracePath), { recursive: true });
  await writeFile(tracePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return tracePath;
}

function scanSummary(result: InboundContentScanResult): string {
  return `${result.decision}: ${result.reason}`;
}

async function auditInboundScan(
  somaHome: string,
  substrate: SubstrateId,
  result: InboundContentScanResult,
  options: InboundContentScanOptions,
): Promise<InboundContentScanOutput["audit"]> {
  if (!eventRecordAllowed(options.record, result.decision)) return undefined;

  const tracePath = await writeInboundTrace(somaHome, result, options);
  const event = await appendSomaMemoryEvent(somaHome, {
    timestamp: options.timestamp,
    substrate,
    kind: "security.inbound_content.scan",
    summary: scanSummary(result),
    artifactPaths: [tracePath, ...(options.sourcePath ? [resolve(options.sourcePath)] : [])],
    metadata: {
      decision: result.decision,
      scanner: result.scanner,
      contentHash: result.contentHash,
      findings: result.findings,
      sourceUri: options.sourceUri,
    },
  });

  return { event, tracePath };
}

export async function scanInboundContent(options: InboundContentScanOptions): Promise<InboundContentScanOutput> {
  const somaHome = createPaths(options).root();
  const substrate = options.substrate ?? "custom";
  const scanner = options.scanner ?? createDeterministicInboundContentScanner();
  const content = options.content ?? (options.sourcePath ? await readFile(options.sourcePath, "utf8") : "");
  const raw = await scanner.scan({
    content,
    sourcePath: options.sourcePath,
    sourceUri: options.sourceUri,
  });
  const result: InboundContentScanResult = {
    decision: normalizeDecision(raw.decision),
    reason: raw.reason,
    scanner: scanner.id,
    contentHash: inboundContentHash(content),
    findings: raw.findings,
  };
  const audit = await auditInboundScan(somaHome, substrate, result, options);

  return {
    somaHome,
    sourcePath: options.sourcePath,
    sourceUri: options.sourceUri,
    ...result,
    audit,
  };
}

export async function promoteInboundContent(options: InboundContentScanOptions & { sourcePath: string }): Promise<InboundContentPromotionResult> {
  const scan = await scanInboundContent(options);
  if (scan.decision !== "ALLOWED") {
    throw new Error(`Inbound content cannot be promoted: ${scan.decision}: ${scan.reason}`);
  }

  return {
    somaHome: scan.somaHome,
    sourcePath: resolve(options.sourcePath),
    contentRef: {
      algorithm: "sha256",
      hash: scan.contentHash,
    },
    scan,
  };
}

export function isInboundUntrustedPath(path: string, options: Pick<InboundContentScanOptions, "homeDir" | "somaHome"> = {}): boolean {
  const target = resolve(path);
  return defaultInboundContentSecurityConfig(options).untrustedRoots.some((root) => {
    const resolvedRoot = resolve(root);
    return target === resolvedRoot || target.startsWith(`${resolvedRoot}/`);
  });
}

export function inboundContentReferencePath(sourcePath: string): string {
  return basename(sourcePath);
}
