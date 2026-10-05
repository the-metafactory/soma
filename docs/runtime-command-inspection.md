# Runtime Command Inspection

Runtime command inspection is the deterministic `tool_call` slice of Soma
runtime policy. It detects high-confidence command and path patterns before a
substrate lets a shell-like tool affect the session.

This is not a shell security engine. The implementation uses bounded token
segmentation, pipe and redirect signals, configured deterministic patterns, and
Soma private-marker checks. It does not attempt complete shell parsing, taint
tracking across temporary files, or broad network policy enforcement.

## PAI Inventory

PAI v5.0.0 split command security across `SecurityPipeline.hook.ts`,
`PatternInspector.ts`, and `EgressInspector.ts`.

| PAI behavior | Soma classification | Status |
| --- | --- | --- |
| `EgressInspector` outbound tools such as curl, wget, netcat, fetch, and HTTP helpers | runtime `tool_call` command inspection | First slice covered a narrow set; #257 expands the deterministic outbound-tool list and supports configured additions. |
| `EgressInspector` credential literals combined with outbound tools | runtime `tool_call` command inspection | First slice implemented credential-term egress; #257 preserves it and lets configured outbound tools participate. |
| `EgressInspector` pipe to shell | runtime `tool_call` command inspection | First slice treated remote fetch piped into an interpreter as approval-required. Broader shell-pipe semantics remain conservative and bounded. |
| `EgressInspector` inline interpreters such as Python, Node, Ruby, and Perl snippets | runtime `tool_call` command inspection | First slice alerted; #257 makes the decision configurable in Soma policy terms. |
| `PatternInspector` bash blocked, confirm, and alert regexes | runtime command pattern rules | #257 adds explicit deterministic `patternRules` in `RuntimePolicyConfig`; Soma does not inherit PAI YAML directly. |
| `PatternInspector` trusted regex fast-path | obsolete for Soma v0 | Soma v0 keeps explicit allow as the absence of findings. Bypass-style trust lists need a later design if required. |
| `PatternInspector` zeroAccess, readOnly, confirmWrite, and noDelete path families | Soma path/private-root policy | Existing path guards remain the source of truth. Command inspection only adds egress signals from path-like command tokens. |
| PAI fail-closed missing pattern file | obsolete for Soma v0 | Runtime policy config is optional and typed. Missing custom config means default deterministic rules, not a failed security subsystem. |

## Soma Command Config

`RuntimePolicyInspectOptions.runtimePolicy` can carry a Soma-owned command
configuration:

- `command.outboundTools`: extra outbound/data-transfer command names.
- `command.credentialPathPatterns`: additional credential-file path regexes.
- `command.privatePathPatterns`: additional private path regexes.
- `command.patternRules`: explicit deterministic regex rules with a finding
  kind, detail, severity, and `deny`, `ask`, or `alert` decision.
- `command.inlineInterpreterDecision`: override the default inline interpreter
  `alert` decision with `ask` or `deny`.
- `privateRoots`: extra private roots used by existing Soma private-marker
  logic.

The config is interpreted by the Soma runtime policy core. Substrate adapters
may project it into hooks, extensions, or daemon gates, but those projections
are not the policy source of truth.

## Implemented Signals

The #257 deterministic command inspector detects:

- raw reads of secret-bearing config into context (`secret-read`): `deny`,
  see [Secret Reads](#secret-reads-secret-read-716)
- environment dumps combined with outbound intent: `deny`
- credential-like terms combined with outbound intent: `deny`
- credential-file path upload through outbound tools: `deny`
- Soma private path content piped or passed to outbound tools: `deny`
- remote fetch piped into an interpreter: `ask`
- inline interpreter snippets: configurable, default `alert`
- configured deterministic command pattern rules: configured decision

The inspector records finding kinds and hash-bound input references in the
existing runtime policy trace. It does not store raw command text in normalized
events or traces by default.

## Secret Reads (`secret-read`, #716)

The egress signals above cover content leaving the machine. `secret-read`
covers the commoner leak: a raw read of a secret-bearing config file into the
model's context. Once a token is in the transcript the model provider has seen
it, and it survives compaction.

It fires on:

- a shell command whose printing verb (`cat`, `head`, `tail`, `sed`, `awk`,
  `grep`, `rg`, `jq`, `xxd`, `base64`, … and rtk's `read`/`grep`/`proxy`) takes
  a secret-bearing path as a file argument, including on a later script line,
  after `&&`/`;`, inside `$(…)` or backticks, and inside `sh -c`/`rtk run`;
- a file-reading tool (`Read`, `read`, `view`, `read_file`) on such a path;
- a content-search tool on such a path: Claude Code's `Grep` only with
  `output_mode: "content"` (its default lists files), other substrates' `grep`
  unless they ask for a list or count mode.

It does not fire on:

- a pipe chain that ends in a redactor: `soma redact`, `bun run soma redact`,
  `bun src/cli.ts redact` or `redact-cat`. Only the chain the read feeds
  counts, so `cat .env | soma redact -; cat .env` still fires;
- count/list-only greps (`-c`, `-l`, `-L`, `-q`, `--count`, `--files…`), the
  grep pattern itself (`grep -rn ".env" src/` searches for the word), and
  in-place `sed -i`;
- verbs that do not print (`cp`, `tar`, `source`, `nats-server -t`, `ls`) and
  `> file` redirect targets;
- data-heredoc bodies and quoted arguments such as a commit message.

Default path classes: `*.creds`, `*.nk`, `nsc/keys/`, NATS `*.conf` under
`~/.config/nats/` or named `nats*.conf`, `~/.config/cortex/**.yaml`, `.env` and
`.env.*` (not `.env.example`/`.sample`/`.template`/`.dist`), and the glab config
dir. The patterns are end-anchored, so `.envrc`, `env.ts` and `nginx.conf` do
not match. Principals add their own in `<soma-home>/policy/secret-read.json`:

```json
{ "pathPatterns": ["(^|/)\\.config/acme/.*\\.toml$"] }
```

A missing file means defaults only. An unreadable or malformed file keeps the
defaults and adds a `secret-read-config-invalid` alert; it never makes the
guard throw. `command.secretReadPathPatterns` does the same for callers that
pass `runtimePolicy` directly.

Severity is `high` with an explicit `deny`, not `critical`: this is a context
leak, not an egress or an attack. The finding carries a hint, and the decision
reason appends it, so the substrate tells the model the recovery:
`soma redact <path>` prints the file with secret values masked (JWTs, NKEY
seeds, creds/private-key blocks, long hex, values of secret-named keys, `.env`
values that are not paths or scalars) and keeps keys, structure, paths and
public NKEYs. The finding names the path, not its content, so the path lands in
the trace and the event metadata.

## Non-Guarantees

Runtime command inspection does not guarantee:

- complete shell parsing
- complete data-flow tracking across files, variables, process substitution, or
  command substitution
- complete network enforcement
- malware detection
- model-backed intent judgment
- replacement of the private-source guard or protected-path guard

Those limits are deliberate. Deterministic command inspection should block or
ask only on bounded, explainable patterns. Ambiguous semantic judgment belongs
behind the opt-in model-backed policy work tracked by #256.
