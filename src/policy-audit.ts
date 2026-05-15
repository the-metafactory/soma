import { appendSomaMemoryEvent } from "./memory";
import { evaluateSomaPolicyBatch, evaluateSomaPolicyWithFilesystem, normalizeSomaPolicyPath, policyOptionsForTarget } from "./policy";
import { somaProjectionPrivateRoots } from "./projection-private-roots";
import type { SomaPolicyBatchCheckOptions, SomaPolicyBatchCheckResult, SomaPolicyCheckOptions, SomaPolicyCheckResult } from "./types";

export async function checkSomaPolicy(options: SomaPolicyCheckOptions): Promise<SomaPolicyCheckResult> {
  const checkOptions = withProjectionPrivateRoots(options);
  const result = await evaluateSomaPolicyWithFilesystem(checkOptions);
  return recordSomaPolicyCheck(checkOptions, result);
}

export async function checkSomaPolicyBatch(options: SomaPolicyBatchCheckOptions): Promise<SomaPolicyBatchCheckResult> {
  const checkOptions = withProjectionPrivateRoots(options);
  const batch = await evaluateSomaPolicyBatch(checkOptions);
  const results = await Promise.all(
    batch.results.map((result, index) =>
      recordSomaPolicyCheck(policyOptionsForTarget(checkOptions, checkOptions.targets[index]), result),
    ),
  );
  const denied = results.find((result) => result.decision === "deny");

  return {
    decision: denied ? "deny" : "allow",
    reason: denied?.reason ?? batch.reason,
    results,
  };
}

function withProjectionPrivateRoots<T extends SomaPolicyCheckOptions | SomaPolicyBatchCheckOptions>(options: T): T {
  return {
    ...options,
    privateRoots: [...(options.privateRoots ?? []), ...somaProjectionPrivateRoots(options)],
  };
}

async function recordSomaPolicyCheck(options: SomaPolicyCheckOptions, result: SomaPolicyCheckResult): Promise<SomaPolicyCheckResult> {
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
      normalizeSomaPolicyPath(options.destinationPath, process.cwd(), options.homeDir),
      ...(options.sourcePath ? [normalizeSomaPolicyPath(options.sourcePath, process.cwd(), options.homeDir)] : []),
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
