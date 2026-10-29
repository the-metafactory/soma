import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";
import { createPaths } from "./paths";
import { isEnoent } from "./fs-errors";

async function principalJudgmentLabelSchema() {
  const { z } = await import("zod");
  return z.object({
    v: z.literal(1),
    judgmentId: z.string().min(1),
    ts: z.iso.datetime(),
    source: z.literal("principal"),
    principal: z.string().trim().min(1),
    verdict: z.enum(["right", "wrong"]),
  });
}

export type PrincipalJudgmentLabel = z.infer<Awaited<ReturnType<typeof principalJudgmentLabelSchema>>>;

export function judgeLabelsPath(somaHome: string): string {
  return createPaths(somaHome).state("judgments", "labels.jsonl");
}

export async function appendJudgmentLabel(somaHome: string, label: PrincipalJudgmentLabel): Promise<void> {
  const validated = (await principalJudgmentLabelSchema()).parse(label);
  const path = judgeLabelsPath(somaHome);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(validated)}\n`, "utf8");
}

export async function readJudgmentLabels(somaHome: string): Promise<{ labels: PrincipalJudgmentLabel[]; malformed: number }> {
  let text: string;
  try {
    text = await readFile(judgeLabelsPath(somaHome), "utf8");
  } catch (error) {
    if (isEnoent(error)) return { labels: [], malformed: 0 };
    throw error;
  }
  const labels: PrincipalJudgmentLabel[] = [];
  const schema = await principalJudgmentLabelSchema();
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      malformed += 1;
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) labels.push(parsed.data);
    else malformed += 1;
  }
  return { labels, malformed };
}
