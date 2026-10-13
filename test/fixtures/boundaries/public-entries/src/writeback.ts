import type { Note } from "./types";
import { memoryDir } from "./memory";
import { internalDir } from "./memory-internal";

export function writeback(note: Note): string {
  return `${memoryDir}/${internalDir}/${note.title}`;
}
