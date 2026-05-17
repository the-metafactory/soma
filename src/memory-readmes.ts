// Canonical PAI v5.0.0 memory taxonomy (#88 / DD-2).
//
// 19 categories: 17 substrate-neutral + 2 PAI-bound. Substrate-neutral
// READMEs describe the directory contract in substrate-agnostic terms.
// PAI-bound READMEs (`PAISYSTEMUPDATES`, `AUTO`) explicitly state the
// directory is populated by the PAI substrate; portable Soma cores may
// leave it empty.
//
// Substrate-neutral READMEs derive their text from the canonical PAI v5.0.0
// source at `~/work/PAI/Releases/v5.0.0/.claude/PAI/MEMORY/<CAT>/README.md`
// where one exists. Adaptations for Soma:
//   - Reframe from "PAI" to "Soma" naming where the substrate would shadow
//     portability (e.g., "PAI install" → "Soma install").
//   - LEARNING / OBSERVABILITY / SECURITY / STATE READMEs are authored
//     fresh — the v5.0.0 source ships them empty or hook-specific.
//   - PAI-bound READMEs additionally include the mandatory provenance line
//     so cross-substrate consumers know not to depend on these populating.

export interface SomaMemoryCategoryReadme {
  /** Category directory name (e.g., `WORK`, `PAISYSTEMUPDATES`). */
  category: string;
  /** Whether the category is populated by the PAI substrate (DD-2). */
  paiBound: boolean;
  /** Full Markdown body without a trailing newline. */
  content: string;
}

const PAI_BOUND_PROVENANCE =
  "This directory is populated by the PAI substrate; portable Soma cores may leave it empty.";

function readme(category: string, body: string, options: { paiBound?: boolean } = {}): SomaMemoryCategoryReadme {
  return {
    category,
    paiBound: options.paiBound ?? false,
    content: body.trimEnd(),
  };
}

// Order is the canonical documentation order; bootstrap iterates this list.
export const SOMA_MEMORY_CATEGORY_READMES: readonly SomaMemoryCategoryReadme[] = [
  readme(
    "WORK",
    `# WORK

\`WORK/\` holds one subdirectory per Algorithm run, named with a slug of the form \`YYYYMMDD-HHMMSS_kebab-task-summary\`. Inside each slug live the artifacts that session produced: the canonical \`ISA.md\` (Ideal State Artifact), any \`PRD.md\`, intermediate notes, generated outputs, and tool-specific event files such as \`forge-events.jsonl\` or \`forge-final.txt\`.

This is the operating record of every non-trivial task. ISA-aware hooks write the ISA here, agent helpers stream their JSONL events here, and follow-up sessions resume by reading the slug directory of the prior run.

Empty in fresh installs. Populated automatically the first time you trigger Algorithm mode or any subagent that scopes its output by slug. Old slugs are safe to archive but should not be deleted while their work is still being referenced.
`,
  ),
  readme(
    "KNOWLEDGE",
    `# KNOWLEDGE

\`KNOWLEDGE/\` is the curated knowledge graph — a typed network of notes across entity domains such as People, Companies, Ideas, and Research, with cross-links between related entries. The \`Knowledge\` skill (and its equivalents on other substrates) manages add, search, and harvest operations against this directory.

Where \`memory/\` overall is append-mostly raw record, \`KNOWLEDGE/\` is curated and structured. Entries follow a frontmatter contract, link to one another via wikilinks, and form the system's long-term semantic memory. Harvesters elsewhere in \`memory/\` propose candidates that get promoted into here only after curation.

Empty in fresh installs. Populates as you add notes via knowledge skills or run harvest workflows that pull from \`LEARNING/\`, \`RESEARCH/\`, and other source layers. Treat structure here as load-bearing — schema changes ripple through every consumer.
`,
  ),
  readme(
    "LEARNING",
    `# LEARNING

\`LEARNING/\` is the staging area for lessons that emerged from real work — corrections the user made, failure modes the system observed, preferences inferred over time, and any other note worth promoting into durable memory after review. The Algorithm's LEARN phase and satisfaction-capture hooks write here.

Entries in \`LEARNING/\` are candidate lessons, not yet structured \`KNOWLEDGE/\` entries. Harvest workflows read this directory, distill recurring patterns, and propose promotion into \`KNOWLEDGE/\`.

Empty in fresh installs. Populates as Algorithm runs reach LEARN, as feedback events are reviewed, and as automated harvesters write candidate lessons. Periodic review encouraged so worthwhile lessons get promoted before the directory grows noisy.
`,
  ),
  readme(
    "RELATIONSHIP",
    `# RELATIONSHIP

\`RELATIONSHIP/\` stores the evolving record of how the principal and their assistant interact — communication patterns, preferences observed over time, agreements made, recurring frictions, and shared context that does not belong in static identity files. Relationship-memory hooks write here.

Where the assistant and principal profiles under \`profile/\` hold declared identity and preferences, \`RELATIONSHIP/\` holds learned ones. The system uses these notes to adjust tone, anticipate needs, and avoid repeating mistakes the principal has already corrected.

Empty in fresh installs. Begins accumulating once the relationship-memory hook fires for the first time. Sensitive by nature; treat it like any other personal data store.
`,
  ),
  readme(
    "STATE",
    `# STATE

\`STATE/\` holds the live operational state of the assistant across sessions — the append-only event log (\`events.jsonl\`), active Algorithm runs (\`active-algorithm-run.json\`), active ISA pointer (\`active.json\`), and similar single-source-of-truth records that hooks and tools read and update during normal use.

Where \`WORK/\` is per-run artifacts, \`STATE/\` is global runtime state. Files here are intentionally small and structured: one JSONL per event stream, one JSON per active pointer. Substrates append events; promotion and harvest workflows read them.

Created on first install. The \`events.jsonl\` writeback contract is documented in \`docs/memory-policy-v0.md\`. Never delete files here while a substrate is running — they back live behavior.
`,
  ),
  readme(
    "OBSERVABILITY",
    `# OBSERVABILITY

\`OBSERVABILITY/\` collects telemetry the substrate emits about itself — tool-activity traces, config-audit snapshots, idle-detection signals, hook-failure diagnostics, and other operational signals captured by observability hooks. PAI's \`ToolActivityTracker\`, \`ConfigAudit\`, and \`TeammateIdle\` hooks land their outputs here; substrate-equivalent hooks on other adapters do the same.

This is the system's self-monitoring layer. Entries are typically timestamped JSONL or structured Markdown, indexed by session or by hook. Downstream skills read this directory to surface anomalies, summarize sessions, and detect drift.

Empty in fresh installs. Populates the first time an observability hook fires. Safe to archive older entries; the latest entries back live dashboards and digests.
`,
  ),
  readme(
    "SECURITY",
    `# SECURITY

\`SECURITY/\` records security-relevant events the substrate captured — task-governance decisions, hook stop-failure diagnostics, permission-denial traces, and any other signal worth preserving for post-hoc review. PAI's \`TaskGovernance\` and \`StopFailureHandler\` hooks write here; substrate-equivalent hooks on other adapters do the same.

Where \`OBSERVABILITY/\` is general operational telemetry, \`SECURITY/\` is the subset worth preserving for incident review and audit. Entries are typically structured JSONL with timestamps, actor, action, and decision.

Empty in fresh installs. Populates the first time a security hook fires. Treat entries as sensitive — they may contain command excerpts, file paths, and policy decisions that reveal the principal's workflow.
`,
  ),
  readme(
    "SCRATCHPAD",
    `# SCRATCHPAD

\`SCRATCHPAD/\` is the ephemeral working space — drafts, intermediate calculations, throwaway notes, and any artifact that has no long-term value but needs a place to live during a session. Skills and agents that need a temp file outside their slug directory can write here.

Treat everything in \`SCRATCHPAD/\` as deletable. Nothing here is canonical, nothing is referenced by hooks for downstream pipelines, and nothing should be relied on across sessions. If a scratchpad note turns out to matter, promote it to \`WORK/\`, \`KNOWLEDGE/\`, or \`RESEARCH/\`.

Empty in fresh installs. Fills opportunistically as you work. Periodic cleanup is encouraged.
`,
  ),
  readme(
    "BOOKMARKS",
    `# BOOKMARKS

\`BOOKMARKS/\` is where bookmark-pulling skills land their synced state and parsed entries — typically as JSON or Markdown files keyed by source platform. Each platform integration owns its own subdirectory or file convention here.

The system uses bookmarks as a signal of interest: items the principal explicitly saved are higher-priority candidates for upgrade analysis, content harvesting, and follow-up workflows.

Empty in fresh installs. Populates the first time you run a bookmark-sync workflow. Re-running a sync is idempotent by design — state files track what has already been seen.
`,
  ),
  readme(
    "RESEARCH",
    `# RESEARCH

\`RESEARCH/\` stores the outputs of research-oriented skills and workflows — multi-source investigations, deep-dive reports, threat-model horizons, competitor analyses, and any other artifact whose primary value is the synthesized findings rather than the executing code. Research, threat-model, and similar deep-investigation skills target this directory.

Content here is human-readable Markdown by convention, often timestamped and topic-slugged. Treat it as a personal research library — the system reads from it for context and the principal reads from it for reference.

Empty in fresh installs. Populates the first time you run a research workflow. Safe to organize into subfolders by topic as the corpus grows.
`,
  ),
  readme(
    "PROJECT",
    `# PROJECT

\`PROJECT/\` is the per-project memory store — one subdirectory per project the principal works on, holding project-scoped notes, decisions, conventions, and accumulated context that should not pollute the global \`memory/\` namespace. Skills targeting a specific project read and write here.

This pattern lets the assistant carry distinct memory for each codebase or initiative without the principal managing project-specific config. Each project subdirectory can grow its own internal structure as needed.

Empty in fresh installs. Populates the first time a project-aware skill records project-specific context. Treat each project subdirectory as that project's working journal.
`,
  ),
  readme(
    "WISDOM",
    `# WISDOM

\`WISDOM/\` collects extracted wisdom artifacts — distilled insights, surprising ideas, quotable claims, and frame-shifting observations harvested from content the principal has consumed or produced. The \`ExtractWisdom\` skill and related fabric patterns write here.

This is intentionally separate from \`KNOWLEDGE/\` (typed graph of entities and notes) and \`RESEARCH/\` (full investigative reports). \`WISDOM/\` is the high-signal, atomic-insight layer — short, sharp, attributable.

Empty in fresh installs. Populates the first time a wisdom-extraction workflow runs. Safe to organize by source, topic, or date as the corpus grows.
`,
  ),
  readme(
    "VERIFICATION",
    `# VERIFICATION

\`VERIFICATION/\` stores evidence captured during the VERIFY phase of the Algorithm — screenshots, command outputs, test results, curl traces, and any other artifact that proves work was actually completed rather than merely claimed. Verification-focused skills and hooks write here with references back to the originating slug.

This directory exists because "should work" is the system's least-trusted phrase. Verifiable evidence sits here so claims of completion can be audited after the fact. Soma's ISA verification model relies on this layer for durable artifact retention beyond the per-run \`WORK/\` slug.

Empty in fresh installs. Populates whenever a workflow captures verification artifacts. Treat these files as evidence — preserve their original form and timestamps.
`,
  ),
  readme(
    "DATA",
    `# DATA

\`DATA/\` holds structured datasets that the system queries, analyzes, or reports on — economic indicators, public-data snapshots, custom JSON corpora, and similar tabular or document collections. Skills that pull from external data APIs land their canonical local copies here.

Where \`RAW/\` is unstructured source material, \`DATA/\` is curated, schema-stable data ready for query and analysis. Think of it as the system's local data warehouse.

Empty in fresh installs. Populates when you run any skill that maintains a local dataset. Schema discipline matters here — keep files versioned and document their shape.
`,
  ),
  readme(
    "RAW",
    `# RAW

\`RAW/\` stores unprocessed source material captured by the system before any parsing, classification, or summarization — raw HTML pulls, full API responses, transcript dumps, podcast audio metadata, original feed payloads, and similar inputs. Parsers and harvesters read from \`RAW/\` and write structured output elsewhere.

Keeping the raw form lets the system re-parse with improved logic later without re-fetching, and lets the principal inspect the original data when a downstream artifact looks wrong.

Empty in fresh installs. Populates when any ingestion workflow runs (feed pulls, transcript captures, scrapes). Files can be large — periodic cleanup of items already processed downstream is reasonable.
`,
  ),
  readme(
    "REFERENCE",
    `# REFERENCE

\`REFERENCE/\` holds curated reference material the system loads on demand — cheat sheets, API field maps, schema docs for external services, lookup tables, and other static information that supports skills without belonging in \`KNOWLEDGE/\` or substrate documentation directories. It is the system's working reference shelf.

Content tends to be tool-specific and skill-adjacent: things a particular workflow needs to consult mid-run. Where \`KNOWLEDGE/\` is curated insight, \`REFERENCE/\` is curated lookup.

Empty in fresh installs. Populates as skills that need reference material write or fetch their tables here. Safe to edit by hand for corrections.
`,
  ),
  readme(
    "SKILLS",
    `# SKILLS

\`SKILLS/\` holds runtime state owned by individual skills that does not fit neatly into \`STATE/\` or \`DATA/\` — skill-specific caches, accumulated user preferences for a given skill, evaluation histories, and per-skill working files. Each skill that needs persistent storage owns a subdirectory here.

Where Soma's \`skills/\` tree (under \`~/.soma/skills/\`) and the substrate skills tree (e.g., \`~/.claude/skills/\`) are the code and definitions for skills, \`memory/SKILLS/\` is the lived data those skills accumulate during use.

Empty in fresh installs. Populates as individual skills create their working subdirectories on first run. Inspect a skill's subdirectory to understand what state it is keeping.
`,
  ),
  readme(
    "PAISYSTEMUPDATES",
    `# PAISYSTEMUPDATES

${PAI_BOUND_PROVENANCE}

\`PAISYSTEMUPDATES/\` is the queue and history of proposed and applied changes to the PAI system itself — Algorithm tweaks, hook adjustments, skill upgrades, configuration changes, and architectural refactors. PAI's \`PAIUpgrade\` skill writes prioritized recommendations here, and applied upgrades are recorded with their before/after state.

This is how PAI improves itself across sessions: lessons in \`LEARNING/\` become candidate upgrades here, and the principal (or the system, with permission) promotes them into actual code and config changes. Other substrates do not write to this directory by default; portable Soma cores may leave it empty.

Empty in fresh installs. Populates when you run the \`PAIUpgrade\` skill or when a PAI hook surfaces a structural improvement. Treat entries as proposals until explicitly applied.
`,
    { paiBound: true },
  ),
  readme(
    "AUTO",
    `# AUTO

${PAI_BOUND_PROVENANCE}

\`AUTO/\` collects outputs from automated, unattended workflows — scheduled jobs, cron-driven scans, periodic syncs, and any agent that runs without an interactive session. Where \`WORK/\` corresponds to principal-initiated Algorithm runs, \`AUTO/\` corresponds to background runs.

PAI's auto-memory hook writes here. Files here are typically timestamped reports, scan results, and digest artifacts. The principal reads them on their own schedule rather than at execution time. Other substrates do not write to this directory by default; portable Soma cores may leave it empty.

Empty in fresh installs. Populates the first time a scheduled or background workflow completes. Older entries can be archived or pruned without affecting live behavior.
`,
    { paiBound: true },
  ),
];

/** Convenience accessor for substrate-neutral category names. */
export const SOMA_SUBSTRATE_NEUTRAL_MEMORY_CATEGORIES = SOMA_MEMORY_CATEGORY_READMES.filter((entry) => !entry.paiBound).map(
  (entry) => entry.category,
);

/** Convenience accessor for PAI-bound category names. */
export const SOMA_PAI_BOUND_MEMORY_CATEGORIES = SOMA_MEMORY_CATEGORY_READMES.filter((entry) => entry.paiBound).map(
  (entry) => entry.category,
);

/** All canonical memory category directory names (substrate-neutral + PAI-bound). */
export const SOMA_MEMORY_CATEGORIES = SOMA_MEMORY_CATEGORY_READMES.map((entry) => entry.category);
