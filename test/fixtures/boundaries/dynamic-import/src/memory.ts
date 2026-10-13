import { homeDir } from "./paths";

export const memoryDir = `${homeDir}/memory`;

export async function flush(): Promise<unknown> {
  return import("./writeback");
}
