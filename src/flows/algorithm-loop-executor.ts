import { recordAlgorithmChange } from "../algorithm/algorithm";
import { applySomaMemoryEventWritebacks } from "./writeback";
import { runSubstrateExecution, isKnownSubstrate, type ExecutionKernelOptions, type SomaExecutionRequest, type SubstrateExecutor } from "../execution/index";
import type { SubstrateId } from "../core/types";
import type { AlgorithmLoopExecutionContext, AlgorithmLoopExecutor, AlgorithmLoopIterationResult } from "../algorithm/types";

export interface SubstrateExecutionAlgorithmLoopExecutorOptions {
  executor: SubstrateExecutor;
  somaHome: string;
  request(context: AlgorithmLoopExecutionContext): SomaExecutionRequest;
  kernelOptions?: ExecutionKernelOptions;
  timestamp?: () => string;
}

/**
 * Connects a validated substrate execution to the existing Algorithm loop.
 * It records only normalized, bounded result facts; it never verifies criteria
 * or advances phases. The caller still applies the returned iteration through
 * recordAlgorithmLoopIterationResult and the normal Algorithm gates.
 */
export class SubstrateExecutionAlgorithmLoopExecutor implements AlgorithmLoopExecutor {
  constructor(private readonly options: SubstrateExecutionAlgorithmLoopExecutorOptions) {}

  async executeIteration(context: AlgorithmLoopExecutionContext): Promise<AlgorithmLoopIterationResult> {
    const request = this.options.request(context);
    const execution = await runSubstrateExecution(this.options.executor, request, this.options.kernelOptions);
    const timestamp = this.options.timestamp?.() ?? new Date().toISOString();
    const eventKinds = execution.events.slice(0, 8).map((event) => event.kind);
    const summary = `Validated ${execution.result.status} execution; ${execution.result.artifacts.length} artifact(s).`;
    const run = recordAlgorithmChange(context.run, summary, timestamp);

    await applySomaMemoryEventWritebacks({
      somaHome: this.options.somaHome,
      substrate: executionWritebackSubstrate(execution.result.substrate),
      timestamp,
      events: [{
        kind: `execution.${execution.result.status}`,
        summary,
        artifactPaths: execution.result.artifacts,
        metadata: {
          executionId: execution.result.executionId,
          taskId: execution.result.taskId,
          projectionFingerprint: execution.result.projectionFingerprint,
          eventKinds,
          ...(request.algorithmRunId === undefined ? {} : { algorithmRunId: request.algorithmRunId }),
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        },
      }],
    });

    return {
      run,
      progressBefore: context.run.vsa.frontmatter.progress,
      progressAfter: run.vsa.frontmatter.progress,
      summary,
    };
  }
}

function executionWritebackSubstrate(substrate: string): SubstrateId {
  if (isKnownSubstrate(substrate)) return substrate;
  throw new Error(`Execution substrate ${substrate} has no governed writeback identity.`);
}
