import { appendSomaMemoryEvent } from "./memory";
import { evaluateSomaPolicyBatch, evaluateSomaPolicyWithFilesystem, normalizeSomaPolicyPath } from "./policy";
import type { SomaPolicyBatchCheckOptions, SomaPolicyBatchCheckResult, SomaPolicyCheckOptions, SomaPolicyCheckResult } from "./types";

export async function checkSomaPolicy(options: SomaPolicyCheckOptions): Promise<SomaPolicyCheckResult> {
  const result = await evaluateSomaPolicyWithFilesystem(options);
  return recordSomaPolicyCheck(options, result);
}

export async function checkSomaPolicyBatch(options: SomaPolicyBatchCheckOptions): Promise<SomaPolicyBatchCheckResult> {
  const batch = await evaluateSomaPolicyBatch(options);
  const results = await Promise.all(
    batch.results.map((result, index) =>
      recordSomaPolicyCheck(
        {
          homeDir: options.homeDir,
          somaHome: options.somaHome,
          substrate: options.substrate,
          action: options.action,
          destinationPath: options.targets[index].filePath,
          sourcePath: options.targets[index].sourcePath,
          content: options.targets[index].content,
          record: options.record,
          timestamp: options.timestamp,
        },
        result,
      ),
    ),
  );
  const denied = results.find((result) => result.decision === "deny");

  return {
    decision: denied ? "deny" : "allow",
    reason: denied?.reason ?? batch.reason,
    results,
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
