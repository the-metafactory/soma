import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import {
  buildRunFinishedEnvelope,
  publishRunFinished,
  RUN_KINDS,
  RUN_OUTCOMES,
  type RunFinishedInput,
} from "../src/flows/run-ledger";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function emit(stack?: string, input: Partial<RunFinishedInput> = {}): Promise<ExecutionRunFinishedEvent> {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-run-ledger-source-"));
  homes.push(somaHome);
  const events: ExecutionRunFinishedEvent[] = [];
  const result = await publishRunFinished({
    kind: "job",
    ref: "source-grammar-test",
    runId: "source-grammar-test",
    outcome: "succeeded",
    startedAt: "2026-10-22T10:00:00.000Z",
    endedAt: "2026-10-22T10:00:01.000Z",
    ...input,
  }, {
    somaHome,
    substrate: "codex",
    env: { SOMA_PRINCIPAL: "jc", ...(stack === undefined ? {} : { SOMA_STACK: stack }) },
    publish: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  });
  expect(result).toBe("published");
  expect(events).toHaveLength(1);
  return events[0];
}

test("default stack names the same stack in the source and subject", async () => {
  for (const stack of [undefined, "default"]) {
    const event = await emit(stack);
    const envelope = await buildRunFinishedEnvelope(event);
    expect(envelope.source).toBe("jc.default.soma");
    expect(event.subject).toBe("local.jc.default.execution.run.finished");
  }
});

test("work stack names the same stack in the source and subject", async () => {
  const event = await emit("work");
  const envelope = await buildRunFinishedEnvelope(event);
  expect(envelope.source).toBe("jc.work.soma");
  expect(event.subject).toBe("local.jc.work.execution.run.finished");
});

test("every emitted run kind and outcome keeps source and subject stacks equal", async () => {
  for (const stack of [undefined, "default", "work"]) {
    for (const kind of RUN_KINDS) {
      for (const outcome of RUN_OUTCOMES) {
        const event = await emit(stack, { kind, outcome });
        const envelope = await buildRunFinishedEnvelope(event);
        expect(envelope.source.split(".")[1]).toBe(event.subject.split(".")[2]);
      }
    }
  }
});
