import { createReadStream } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { inference } from "../inference";
import { createAutoInferenceBackend } from "../inference/factory";
import { pathsForLearningOptions } from "./paths";
import { transcriptContentToText } from "./transcript";
import type { FailureCaptureInput, FailureCaptureResult, ToolCall } from "./types";

interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  content?: unknown;
  output?: unknown;
}

function pathsFor(options: FailureCaptureInput) {
  return pathsForLearningOptions(options);
}

async function parseTranscript(transcriptPath: string): Promise<{
  entryCount: number;
  toolCalls: ToolCall[];
  conversations: Array<{ role: string; content: string; timestamp?: string }>;
}> {
  let entryCount = 0;
  const toolCalls: ToolCall[] = [];
  const conversations: Array<{ role: string; content: string; timestamp?: string }> = [];
  const lines = createInterface({ input: createReadStream(transcriptPath, { encoding: "utf8" }), crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    entryCount += 1;
    const text = transcriptContentToText(entry.message?.content);
    if ((entry.type === "user" || entry.type === "assistant") && text) {
      conversations.push({ role: entry.type, content: text, timestamp: entry.timestamp });
      if (conversations.length > 20) conversations.shift();
    }
    if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block && typeof block === "object" && "type" in block && block.type === "tool_use" && "name" in block) {
          toolCalls.push({ name: String(block.name), input: "input" in block ? block.input : undefined, timestamp: entry.timestamp });
          if (toolCalls.length > 50) toolCalls.shift();
        }
      }
    }
    if ((entry.type === "tool_result" || entry.type === "tool_output") && toolCalls.length > 0) {
      const last = toolCalls[toolCalls.length - 1];
      if (last && !last.output) last.output = transcriptContentToText(entry.content ?? entry.output);
    }
  }

  return { entryCount, toolCalls, conversations };
}

function sanitizeDescription(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  return (words.length >= 5 ? words.slice(0, 8).join("-") : `low-rating-failure-${words.join("-")}`).replace(/-+$/g, "")
    || "unspecified-failure-needs-review";
}

async function generateDescription(input: FailureCaptureInput, conversations: Array<{ role: string; content: string }>, toolCalls: ToolCall[]): Promise<string> {
  const backend = input.backend ?? (input.allowRemoteInference ? await createAutoInferenceBackend() : undefined);
  if (!backend) return sanitizeDescription(input.sentimentSummary);

  const prompt = [
    "Generate a short, specific kebab-case description of what went wrong.",
    "Use no more than 8 words. Return only the description.",
    "",
    `Sentiment: ${input.sentimentSummary}`,
    "Recent conversation:",
    conversations.slice(-6).map((item) => `${item.role}: ${item.content.slice(0, 200)}`).join("\n"),
    `Tools: ${toolCalls.slice(-5).map((tool) => tool.name).join(", ") || "none"}`,
  ].join("\n");

  try {
    const result = await inference(prompt, { level: "fast", timeoutMs: 10_000, backend });
    return sanitizeDescription(result.text);
  } catch {
    return sanitizeDescription(input.sentimentSummary);
  }
}

export async function captureFailure(input: FailureCaptureInput): Promise<FailureCaptureResult> {
  if (!Number.isFinite(input.rating)) {
    throw new Error("Failure capture rating must be a finite number.");
  }
  if (input.rating > 3) return { path: null, skipped: true };

  const { entryCount, toolCalls, conversations } = await parseTranscript(input.transcriptPath);
  const description = await generateDescription(input, conversations, toolCalls);
  const now = input.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const month = now.toISOString().slice(0, 7);
  const dir = pathsFor(input).resolve("memory", "LEARNING", "FAILURES", month, `${date}-${time}_${description}`);
  await mkdir(dir, { recursive: true });

  await copyFile(input.transcriptPath, join(dir, "transcript.jsonl"));
  await writeFile(join(dir, "sentiment.json"), JSON.stringify({
    rating: input.rating,
    summary: input.sentimentSummary,
    detailed_context: input.detailedContext ?? "",
    session_id: input.sessionId ?? "",
    captured_at: now.toISOString(),
    transcript_source: basename(input.transcriptPath),
  }, null, 2), "utf8");
  await writeFile(join(dir, "tool-calls.json"), JSON.stringify(toolCalls, null, 2), "utf8");
  await writeFile(join(dir, "CONTEXT.md"), `# Failure Analysis: ${description.replace(/-/g, " ")}

**Date:** ${date}
**Rating:** ${input.rating}/10
**Summary:** ${input.sentimentSummary}

## What Happened

${input.detailedContext ?? "No detailed context provided."}

## Conversation Summary

${conversations.slice(-10).map((item) => `**${item.role.toUpperCase()}:** ${item.content.slice(0, 500)}`).join("\n\n")}

## Tool Calls (${toolCalls.length})

${toolCalls.length === 0 ? "No tool calls recorded." : toolCalls.slice(-10).map((tool) => `- ${tool.name}: ${JSON.stringify(tool.input).slice(0, 200)}`).join("\n")}

## Files

- transcript.jsonl: raw transcript (${entryCount} entries)
- sentiment.json: rating metadata
- tool-calls.json: extracted tool calls
`, "utf8");

  return { path: dir, description, toolCalls };
}
