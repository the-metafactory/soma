import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionCapabilities, ExecuteOptions, PreparedExecution, SomaExecutionRequest } from "./types";

/** Shared request-scoped process state for substrate command executors. */
export class RequestScopedExecutionLifecycle {
  private readonly cancellations = new Set<string>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly temporaryRoots = new Map<string, string>();

  async prepare(
    executionId: string,
    request: SomaExecutionRequest,
    capabilitySnapshot: ExecutionCapabilities,
    temporaryRoot: string | undefined,
    temporaryPrefix: string,
  ): Promise<PreparedExecution> {
    const root = await mkdtemp(join(temporaryRoot ?? tmpdir(), temporaryPrefix));
    await writeFile(join(root, "SOMA_EXECUTION.md"), `# Soma Execution\n\nProjection: ${request.projectionFingerprint}\n`, "utf8");
    this.temporaryRoots.set(executionId, root);
    return { executionId, request, capabilitySnapshot };
  }

  begin(executionId: string, options?: ExecuteOptions): { signal: AbortSignal; cancelled(): boolean; finish(): Promise<void> } {
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    if (options?.signal?.aborted) controller.abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    this.activeControllers.set(executionId, controller);
    return {
      signal: controller.signal,
      cancelled: () => controller.signal.aborted || this.cancellations.has(executionId),
      finish: async () => {
        options?.signal?.removeEventListener("abort", abort);
        this.activeControllers.delete(executionId);
        await this.cleanup(executionId);
        this.cancellations.delete(executionId);
      },
    };
  }

  async cancel(executionId: string): Promise<void> {
    this.cancellations.add(executionId);
    this.activeControllers.get(executionId)?.abort();
    await this.cleanup(executionId);
  }

  private async cleanup(executionId: string): Promise<void> {
    const root = this.temporaryRoots.get(executionId);
    this.temporaryRoots.delete(executionId);
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
}
