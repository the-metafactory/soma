// Run generated extensions in a separate process so host-package mocks never
// leak into the rest of the test suite. Lifecycle subprocesses remain real.
import { mock } from "bun:test";

mock.module("@mariozechner/pi-ai", () => ({ StringEnum: () => ({}) }));
mock.module("@sinclair/typebox", () => ({
  Type: {
    Object: () => ({}),
    Optional: () => ({}),
    String: () => ({}),
    Number: () => ({}),
  },
}));

type Handler = (event: unknown, context: unknown) => unknown;
const handlers = new Map<string, Handler>();
const extension = await import(process.argv[2]);
extension.default({
  on: (event: string, handler: Handler) => handlers.set(event, handler),
  registerTool: () => undefined,
  registerCommand: () => undefined,
});
const handler = handlers.get(process.argv[3]);
if (!handler) throw new Error(`Extension did not register ${process.argv[3]}`);
await handler({}, {});
// Bun keeps the execFile callback alive until the recorder child finishes.
