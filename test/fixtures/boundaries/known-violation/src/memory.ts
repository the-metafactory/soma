import { homeDir } from "./paths";
import { writeback } from "./writeback";

export const memoryDir = `${homeDir}/memory`;
export const flush = writeback;
