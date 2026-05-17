♻︎ Entering the PAI ALGORITHM… (Soma) ═════════════
🗒️ TASK: Wire pi.dev Algorithm phase renderer
🎯 INTENT: Make Algorithm runs render as persistent dashboard widgets

━━━ 👁️ OBSERVE ━━━ 1/7
Current state: pi.dev adapter only projects context + tools.
Goal: persistent per-phase widgets.
Criteria: parser + widget renderers + install hook.

━━━ 🧠 THINK ━━━ 2/7
Assumptions: pi.dev hot-reloads TS extensions.
Tradeoffs: depth of integration vs review surface area.
Capabilities: FirstPrinciples → THINK | scope by what pi.dev exposes.

━━━ 📋 PLAN ━━━ 3/7
P1 maps to C1 — phase parser as pure logic.
P2 maps to C2 — extension renderer.
P3 maps to C3 — install hook copies the file.

━━━ 🛠️ BUILD ━━━ 4/7
Files: src/adapters/pi-dev/extensions/{soma-algorithm,phase-parser,widget-renderers}.ts

━━━ ⚡ EXECUTE ━━━ 5/7
bun run typecheck; bun test
Tests added for parser snapshot.

━━━ ✅ VERIFY ━━━ 6/7
C1: passed — parser identifies all 8 markers in canonical transcript.
C2: passed — renderer round-trips.
C3: passed — install hook writes file.

━━━ 📚 LEARN ━━━ 7/7
The pi.dev extension surface is rich enough to render the Algorithm as a
real dashboard. Code is rendered as strings at install time, mirroring
the existing path-guard pattern. Don't depend on pi-dev as a build dep.

━━━ 📃 SUMMARY ━━━ 7/7
Minimal-correct slice shipped. Live e2e + state persistence deferred.
