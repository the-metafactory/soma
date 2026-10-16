# pstack notice

Several playbook cards (`references/playbooks.md`) and principles (`references/principles.md`) are adapted from pstack, a Cursor plugin by Lauren Tan: repository `cursor/plugins` on GitHub, directory `pstack/`.

From commit `99743e9`: the principles explain-the-number, attack-the-premise, separate-before-serializing-shared-state and encode-lessons-in-structure, and the task shapes and step order of the nine cards.

From commit `f713f14`, the remaining pstack principles:

- Adapted as new principles: laziness-protocol, foundational-thinking, redesign-from-first-principles, subtract-before-you-add, minimize-reader-load, outcome-oriented-execution, experience-first, exhaust-the-design-space, build-the-lever, model-the-domain, boundary-discipline, type-system-discipline, make-operations-idempotent, migrate-callers-then-delete-legacy-apis, sequence-verifiable-units, test-behavior-not-implementation, guard-the-context-window.
- Merged into existing principles: prove-it-works into verify-before-claiming, fix-root-causes into fix-at-the-ingestion-point, never-block-on-the-human into build-over-ask-when-reversible (bounded by the principal's ask-before list).

pstack is distributed under the MIT License, reproduced here as it requires:

```text
MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
