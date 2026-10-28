// Worker entry for the Claude Code policy guard hook: it runs `soma policy`
// in the hook's own process instead of a second `bun` (about 100 ms per tool
// call). The hook keeps the timeout on its main thread, so a hang here still
// denies.
import { parsePolicyArgs, runPolicyCli } from "./policy";

declare const self: Worker;

self.onmessage = async (event: MessageEvent<{ args: string[]; env: Record<string, string> }>) => {
  // A worker sees the environment its process started with, so the hook sends
  // the variables that carry the prompt or tool input.
  Object.assign(process.env, event.data.env);
  try {
    self.postMessage({ output: await runPolicyCli(parsePolicyArgs(event.data.args)) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
