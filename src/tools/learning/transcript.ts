function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function transcriptContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (isRecord(block) && typeof block.text === "string") return block.text;
    if (isRecord(block) && "content" in block) return transcriptContentToText(block.content);
    return "";
  }).filter(Boolean).join("\n").trim();
}
