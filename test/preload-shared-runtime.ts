/**
 * Test preload (bunfig.toml `[test] preload`): remove the process's shared
 * staged runtime (`test/fixtures/shared-runtime.ts`, node #929) once its tests
 * have run. A preload's `afterAll` runs after the whole run, or after each file
 * when files are isolated; the fixture re-creates the store on demand.
 */
import { afterAll } from "bun:test";
import { removeSharedRuntimeStore } from "./fixtures/shared-runtime";

afterAll(removeSharedRuntimeStore);
