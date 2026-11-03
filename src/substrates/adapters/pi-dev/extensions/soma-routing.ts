export function renderSomaRoutingExtension(somaHome: string): string {
  return [
    'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";',
    'import { pathToFileURL } from "node:url";',
    `const SOMA_HOME = ${JSON.stringify(somaHome)};`,
    'export default function (pi: ExtensionAPI) {',
    '\tpi.on("tool_result", async (event) => {',
    '\t\ttry {',
    '\t\t\tconst { toolNudgeLines } = await import(pathToFileURL(`${SOMA_HOME}/runtime/tool-nudges.mjs`).href);',
    '\t\t\tconst lines: string[] = toolNudgeLines(SOMA_HOME, event.toolName, event.input);',
    '\t\t\tif (lines.length === 0) return;',
    '\t\t\treturn { content: [...event.content, { type: "text", text: lines.join("\\n") }] };',
    '\t\t} catch (error) {',
    '\t\t\tprocess.stderr.write(`Soma tool nudge failed: ${error instanceof Error ? error.message : String(error)}\\n`);',
    '\t\t\treturn undefined;',
    '\t\t}',
    '\t});',
    '}',
  ].join("\n");
}
