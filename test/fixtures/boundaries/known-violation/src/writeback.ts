import type { Note } from "./types";
import { memoryDir } from "./memory";

export function writeback(note: Note): string {
  return `${memoryDir}/${note.title}`;
}
