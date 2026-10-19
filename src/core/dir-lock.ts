import { dlopen, FFIType } from "bun:ffi";
import { open } from "node:fs/promises";

const LOCK_EX = 2;
const LOCK_NB = 4;

export class LockBusyError extends Error {}

let flock: ((fd: number, operation: number) => number) | undefined;

function loadFlock() {
  flock ??= dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols.flock;
  return flock;
}

/**
 * Run `work` holding an OS advisory lock on `path` (a directory or file that already exists).
 * The kernel drops the lock when the descriptor closes or the process dies, so there is no lock
 * file to leave behind and no staleness to judge. Throws LockBusyError when another holder has it.
 */
export async function withExclusiveLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const handle = await open(path, "r");
  try {
    if (loadFlock()(handle.fd, LOCK_EX | LOCK_NB) !== 0) throw new LockBusyError(`${path} is locked`);
    return await work();
  } finally {
    await handle.close();
  }
}
