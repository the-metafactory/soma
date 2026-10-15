import { test } from "bun:test";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { noDiscardedError } from "../eslint.config.js";

RuleTester.describe = (_name, run) => run();
RuleTester.it = (name, run) => test(name, run);
RuleTester.itOnly = (name, run) => test.only(name, run);

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

tester.run("soma/no-discarded-error", noDiscardedError, {
  valid: [
    "try { f(); } catch (error) { if (isEnoent(error)) return null; throw error; }",
    "try { f(); } catch (error) { throw new Error('read failed', { cause: error }); }",
    "p.catch((error: unknown) => report(error));",
    "p.catch(handler);",
    "try { f(); } catch ({ code }) { log(code); }",
  ],
  invalid: [
    // #723 (c2d2f92): an unreadable ledger read as an empty one.
    { code: "try { f(); } catch { return false; }", errors: [{ messageId: "discarded" }] },
    // #724: readdir(...).catch(() => []) truncated the existing corpus.
    { code: "const names = await readdir(dir).catch(() => []);", errors: [{ messageId: "discarded" }] },
    { code: "try { f(); } catch (_error) { return []; }", errors: [{ messageId: "discarded" }] },
    { code: "p.catch(function (_e) { return ''; });", errors: [{ messageId: "discarded" }] },
  ],
});
