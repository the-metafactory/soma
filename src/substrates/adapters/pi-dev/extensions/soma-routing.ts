export function renderSomaRoutingExtension(somaHome: string): string {
  return [
    'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";',
    'import { pathToFileURL } from "node:url";',
    `const SOMA_HOME = ${JSON.stringify(somaHome)};`,
    'export default function (pi: ExtensionAPI) {',
    '\tpi.on("tool_result", async (event) => {',
    '\t\tconst { toolNudgeLines } = await import(pathToFileURL(`${SOMA_HOME}/runtime/tool-nudges.mjs`).href);',
    '\t\tconst lines: string[] = toolNudgeLines(SOMA_HOME, event.toolName, event.input);',
    '\t\tif (lines.length === 0) return;',
    '\t\treturn { content: [...event.content, { type: "text", text: lines.join("\\n") }] };',
    '\t});',
    '}',
  ].join("\n");
}
