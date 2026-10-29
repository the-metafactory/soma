import { expect } from "bun:test";
import type { ExecutionConformanceReport } from "../../src/execution/index";

export function abortOnListen({ controller, signal, onAbort }: {
  controller: AbortController;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}): Promise<never> {
  if (signal === undefined) throw new Error("Cancellation fixture requires a runner signal.");
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => {
      onAbort();
      reject(new Error("cancelled by fixture"));
    }, { once: true });
    controller.abort();
  });
}

export function expectConformancePassed(report: ExecutionConformanceReport): void {
  expect(report.results.filter((scenario) => !scenario.passed)).toEqual([]);
  expect(report.passed).toBe(true);
}
