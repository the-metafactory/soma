# Soma MCP Server Design

Soma should expose an optional Model Context Protocol server for substrates that
can call tools directly. The MCP server is a thin access surface over Soma core;
it is not a substrate adapter replacement and it does not own assistant state.

The first implementation slice should be read-only. Mutating tools stay behind
an explicit confirmation model so the MCP surface cannot become a silent
writeback channel.

## Goals

- Let MCP-capable substrates discover Soma memory, skills, ISA, Algorithm, and
  identity context on demand.
- Keep eager startup context small by making large registries and skill bodies
  indexed with on-demand bodies.
- Share one portable tool contract across Cursor, Claude Code, Codex plugins,
  Pi.dev, and future daemon-backed substrates.
- Preserve adapter boundaries: adapters install and configure substrate-native
  MCP clients, while the MCP server reads and, after confirmation, mutates Soma
  through core APIs.

## Non-Goals

- The MCP server is not required for home projections, lifecycle hooks, or
  eager startup availability.
- The MCP server does not replace filesystem-native Soma memory.
- The MCP server does not mirror raw prompts, transcripts, full tool inputs, or
  command output into shared memory by default.
- The first implementation does not include mutating writes.

## Tool Inventory

The canonical tool set is grouped by Soma area. Tool schemas should stay
small: each tool needs a narrow description, bounded input shape, and
pagination or selector arguments for large outputs.

| Domain | Tool | First slice | Purpose |
|--------|------|-------------|---------|
| Memory | `soma_memory_search` | read | Search indexed Soma memory using filenames, metadata, and text snippets. |
| Memory | `soma_memory_read` | read | Read a bounded memory artifact by stable path or ID. |
| Memory | `soma_memory_promote` | deferred write | Promote reviewed material into durable memory. |
| Skills | `soma_skill_registry` | read | List available skills with names, summaries, token estimates, and entrypoints. |
| Skills | `soma_skill_route` | read | Route a task description to likely skills without loading every skill body. |
| Skills | `soma_skill_load` | read | Load one selected skill entrypoint or referenced file. |
| ISA | `soma_isa_active` | read | Return the active ISA summary and criterion IDs. |
| ISA | `soma_isa_check` | read | Check proposed evidence against active ISA criteria without mutating state. |
| ISA | `soma_isa_scaffold` | deferred write | Create a new ISA draft after explicit confirmation. |
| Algorithm | `soma_algorithm_classify` | read | Classify a prompt as MINIMAL, NATIVE, or ALGORITHM and map Algorithm depth. |
| Algorithm | `soma_algorithm_new` | deferred write | Create a new Algorithm run. |
| Algorithm | `soma_algorithm_advance` | deferred write | Advance an existing Algorithm run through phase gates. |
| Identity | `soma_identity_context` | read | Return bounded assistant/principal identity context for the current substrate. |

## Schema Budget

MCP tool schemas are loaded by the MCP client and can become always-on prompt
cost. The server should therefore expose a compact default manifest:

- default tools: `soma_identity_context`, `soma_skill_registry`,
  `soma_skill_route`, `soma_skill_load`, `soma_isa_active`,
  `soma_isa_check`, `soma_algorithm_classify`, `soma_memory_search`, and
  `soma_memory_read`
- deferred tools: `soma_memory_promote`, `soma_isa_scaffold`,
  `soma_algorithm_new`, and `soma_algorithm_advance`
- each tool description should stay under roughly 40 words
- large responses must require `limit`, `cursor`, `path`, `skill`, or
  `criterionId` selectors
- skill bodies and memory artifact bodies are never returned in registry calls

This mirrors the progressive loading contract in
[progressive-skill-loading.md](./progressive-skill-loading.md): start with a
small registry, route, then load only the selected body.

## Read Authorization Model

Every read tool must validate the requesting principal, MCP client session,
substrate, and allowed scope before returning data. Scope includes the requested
memory path or ID, identity context, active ISA, skill entrypoint, Algorithm
classification input, and any substrate-specific visibility limit.

Path-based reads must resolve through Soma core path validation and must not
accept raw filesystem paths from an untrusted client as authority. Unauthorized,
out-of-scope, or malformed reads fail closed with a bounded error and no private
content excerpt.

## Write Confirmation Model

Mutating tools require a two-step confirmation protocol:

1. The tool returns a proposed mutation with a deterministic preview, affected
   paths, policy checks, and a short-lived confirmation token.
2. A second call submits the token and the same mutation fingerprint before Soma
   writes through the normal core API.

Confirmation tokens must be single-use and bound to the requesting principal,
MCP client session, substrate, affected paths, policy result, and mutation
fingerprint. A token presented from a different client session or for a changed
mutation is refused.

The first MCP PR should not implement writes. It should reserve the protocol and
return structured `requires_confirmation` results for deferred write tools until
the confirmation implementation exists.

The confirmation model must use the same safety line as the adapter writeback
gate: no raw prompt, transcript, full tool input, or command output is written
by default.

## Adapter Boundary

The MCP server is a library/daemon surface. It owns the protocol transport and
tool schemas, but it calls Soma core for identity, memory, skill routing, ISA,
Algorithm, policy, and writeback.

Adapters own substrate-native install facts:

- Cursor may project MCP setup notes into `.cursor/rules/soma/MCP.md`.
- Claude Code may patch `mcpServers` in its settings only when explicitly
  requested.
- Codex plugin wiring is future work and should consume the same server.
- Pi.dev can keep its existing `soma_context` extension surface while MCP
  parity remains optional.

Substrates without MCP support still receive eager filesystem projections. MCP
is an on-demand optimization, not the only way to inhabit Soma.

## First Implementation Slice

The first code slice should add a server entrypoint that exposes the read tools
from the Tool Inventory table, matching the default manifest in the Schema
Budget section.

It should include fixture-backed tests for schema shape, bounded responses,
path validation, missing active ISA, missing skill, no raw prompt persistence,
and no writes from read-only tools.
