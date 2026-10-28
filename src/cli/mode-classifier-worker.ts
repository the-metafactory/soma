// Worker entry for the Claude Code mode-classifier hook: it runs `soma
// algorithm classify` in the hook's own process instead of a second `bun`
// (about 100 ms per prompt). The hook keeps the timeout on its main thread,
// so a hang here still fails open.
import { parseAlgorithmClassifyArgs, runAlgorithmClassify } from "./algorithm-classify";

declare const self: Worker;

self.onmessage = async (event: MessageEvent<{ args: string[] }>) => {
  try {
    self.postMessage({ output: await runAlgorithmClassify(parseAlgorithmClassifyArgs(event.data.args)) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
