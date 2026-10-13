import type { writeback } from "./writeback";
import { homeDir } from "./paths";

export const memoryDir = `${homeDir}/memory`;
export type Flush = typeof writeback;
