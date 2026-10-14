import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isNode, isScalar, isSeq, LineCounter, parseAllDocuments, visit } from "yaml";
import { z } from "zod";
import { isEnoent, defaultSomaHome, type SomaPathsOptions } from "./core";

const resourceSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  type: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  // Resource types can represent a scalar (feed URL) or structured config.
  // Kind schemas validate the resolved value later; missing values fail here.
  value: z.json(),
});

export type GoalResource = z.output<typeof resourceSchema>;

/** Exact pair lookup; never fall back to a differently typed resource. */
export function resolveGoalResource(resources: readonly GoalResource[], name: string, type: string): GoalResource["value"] | undefined {
  return resources.find((resource) => resource.name === name && resource.type === type)?.value;
}

/** Parse a YAML sequence of {name, type, value}; all errors are value-free. */
export function parseGoalResources(content: string, file: string): GoalResource[] {
  const lines = new LineCounter();
  const documents = parseAllDocuments(content, {
    lineCounter: lines, prettyErrors: false, logLevel: "silent", stringKeys: true,
  });
  const invalid = (offset: number, reason: string): never => {
    const line = Math.max(1, lines.linePos(offset).line);
    throw new Error(`Invalid goal resources: ${file}: line ${line}: ${reason}`);
  };
  if (documents.length !== 1) return invalid(documents[0]?.range[2] ?? 0, "expected one resource document");
  const [document] = documents;
  const error = document.errors.at(0) ?? document.warnings.at(0);
  if (error) invalid(error.pos[0], "malformed YAML");
  const root = document.contents;
  if (!isSeq(root)) return invalid(root?.range[0] ?? 0, "expected a resource sequence");
  visit(root, {
    Alias: (_key, node) => invalid(node.range?.[0] ?? 0, "resource aliases are unsupported"),
  });

  const resources: GoalResource[] = [];
  const seen = new Map<string, Set<string>>();
  for (const entry of root.items) {
    const offset = isNode(entry) ? entry.range[0] : 0;
    if (!isMap(entry)) return invalid(offset, "expected a resource entry");
    // Refuse unknown keys without printing their spelling: keys can be values
    // accidentally pasted into a private file. Use the key's source location.
    for (const pair of entry.items) {
      if (!isScalar(pair.key) || !["name", "type", "value"].includes(String(pair.key.value))) {
        invalid(isNode(pair.key) ? pair.key.range[0] : offset, "unknown resource field");
      }
    }
    let raw: unknown;
    try {
      raw = entry.toJSON();
    } catch {
      invalid(offset, "invalid resource value");
    }
    const parsed = resourceSchema.safeParse(raw);
    if (!parsed.success) {
      const field = parsed.error.issues[0].path[0];
      const node = entry.get(field, true);
      return invalid(isNode(node) ? node.range?.[0] ?? offset : offset,
        ["name", "type", "value"].includes(String(field)) ? `invalid or missing ${String(field)}` : "invalid resource entry");
    }
    const resource = parsed.data;
    const types = seen.get(resource.name) ?? new Set<string>();
    if (types.has(resource.type)) invalid(offset, "duplicate resource name and type");
    types.add(resource.type);
    seen.set(resource.name, types);
    resources.push(resource);
  }
  return resources;
}

/** Missing files are empty; read errors and malformed files fail closed. */
export async function loadGoalResources(options: SomaPathsOptions = {}): Promise<GoalResource[]> {
  const file = join(defaultSomaHome(options), "profile", "resources.yaml");
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (isEnoent(error)) return [];
    // Do not attach a cause: callers may print its private diagnostic text.
    // eslint-disable-next-line preserve-caught-error -- resource diagnostics must never expose private parser or filesystem text
    throw new Error(`Cannot read goal resources: ${file}`);
  }
  return parseGoalResources(content, file);
}
