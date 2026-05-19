export function transcriptContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (block && typeof block === "object" && "text" in block && typeof block.text === "string") return block.text;
    if (block && typeof block === "object" && "content" in block) return transcriptContentToText(block.content);
    return "";
  }).filter(Boolean).join("\n").trim();
}
