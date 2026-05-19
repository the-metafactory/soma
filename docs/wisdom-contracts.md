# Soma Wisdom Contracts

Wisdom Frames are a specialized Soma memory store. Tools must resolve their
paths through `createPaths().wisdom()` and must not address substrate-specific
assistant directories directly.

## Frame Layout

Frames live under `<soma-wisdom-root>/FRAMES/<domain>.md`, where the wisdom
root is supplied by the Soma path resolver.

Each frame is Markdown with these sections:

- `Crystallized Principles`
- `Contextual Rules`
- `Predictive Model`
- `Anti-Patterns`
- `Cross-Frame Connections`
- `Evolution Log`
- `Metadata`

Crystallized principles are marked with `[CRYSTAL]`. Cross-frame synthesis uses
those marked lines as candidate principles and computes Jaccard similarity over
their normalized word sets.

## Observation Types

`soma wisdom update` accepts these observation types:

- `principle`
- `contextual-rule`
- `prediction`
- `anti-pattern`
- `evolution`

Updates append to the matching section, append a dated evolution log entry, and
increment `Observation Count` in metadata.

## Synthesis Outputs

`soma wisdom synthesize` writes:

- `<soma-wisdom-root>/PRINCIPLES/verified.md`
- `<soma-wisdom-root>/META/frame-health.md`

`soma wisdom health` writes only the health report.
