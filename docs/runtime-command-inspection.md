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

Threat model: `secret-read` stops an assistant reading a secret into its own
context BY ACCIDENT, the way #716 happened (a whole-file read, a line-range
read). It is not a boundary against a model working to evade it: a command
built to route raw content around the redactor, or a redactor impersonated
by a script named `soma`, is out of scope. Where a cheap rule closes a whole
class of accident (any output redirect before the redactor), it is taken; a
construction that only an evasive command would use is not chased.

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
- a content-search tool on such a path, or whose `glob` selects such files
  (`.env*`, `**/*.creds`), unless its input names a list or count
  `output_mode`. The core knows no tool's defaults; the Claude Code adapter
  fills in `Grep`'s own default, `files_with_matches`, and lets such a Grep
  through without starting the guard at all, since it can never be denied.

It does not fire on:

- a pipe chain whose last stage runs a redactor (`soma redact`,
  `bun run soma redact` or `redact-cat`, resolved from the command position)
  and whose stages in between are filters with no way to write a file
  (`head`, `tail`, `grep`, `rg`, `cut`, `tr`), none of which, the read
  included, redirects its output (`2>/dev/null` and `2>&1` are fine). Only the
  chain the read feeds counts, so `cat .env | soma redact -; cat .env` still
  fires, and so do `cat .env | tee /dev/stderr | soma redact -` and
  `cat .env > /dev/stderr | soma redact -`, which carry the raw file around
  the redactor;
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

This follows the convention of `policy/probe-registry.json`: a principal-owned
rule extension lives in `<soma-home>/policy/<rule>.json`, one file per rule,
read by the core at inspection time. No single runtime-policy config file
exists on disk; `RuntimePolicyInspectOptions.runtimePolicy` is the programmatic
form. A missing file means defaults only. An unreadable or malformed file keeps the
defaults and adds a `secret-read-config-invalid` alert; it never makes the
guard throw. `command.secretReadPathPatterns` does the same for callers that
pass `runtimePolicy` directly.

Severity is `high` with an explicit `deny`, not `critical`: this is a context
leak, not an egress or an attack. The finding carries a hint, and the decision
reason appends it, so the substrate tells the model the recovery:
`soma redact <path>` prints the file with secret values masked and keeps keys,
structure, paths and public NKEYs. It masks JWTs, NKEY seeds, creds and
private-key blocks, long hex, URL userinfo passwords, and the whole value of a
secret-named key: quoted values up to their closing quote, numbers included,
and YAML block scalars line by line. A whole `${VAR}` (or `${VAR}/path`) is a
reference and stays; a bare `$NAME` is one only in `.env`, where dotenv
expands it, so `password: $ecretPass` in yaml is masked. In `.env` it masks
every value that is not a path, a reference or a literal, and keeps numbers only under
keys that are not secret-named (`PORT=8080`). A value counts as a path only
when it uses path characters and has a second segment or an extension, so a
base64 secret that starts with `/` is still masked. The finding names the path, not its content, so the path lands in
the trace and the event metadata.

`secret-read` does not catch:

- a recursive search of an ordinary directory that happens to contain a
  secret file (`grep -rn KEY .`); only paths that match a pattern count;
- `git diff`, `git show` or `git log -p` of a tracked secret file;
- a read by an interpreter (`bun -e`, `python -c`) or through a variable
  (`f=.env; cat $f`).

`soma redact` masks what it recognises. A secret under a key it does not
recognise, in a format it does not parse, prints.

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
