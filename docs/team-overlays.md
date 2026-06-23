# Team Overlays

Issue #152 asks for shared skills, team memory, team ISAs, and a permission
model without leaking personal Identity, Purpose, or Relationship state. The
implementation term is **team overlay**: a policy-scoped shared Soma layer that
supplements one principal's local Soma home.

Team overlays do not make a Soma home multi-principal. A Soma home remains
owned by exactly one principal. Team material is mounted beside that home,
projected into substrates only after Policy allows it, and cited as team
provenance when it is used.

## Goals

- Let several principals use a team-curated set of Soma skills.
- Let personal Soma memory read shared team `KNOWLEDGE` and `WORK` without
  copying private personal stores into the team layer.
- Let project or team ISAs be visible beside personal/task ISAs.
- Keep shared state explicitly namespaced by team, source, and permission.
- Preserve Arc as the package/distribution system and Compass as the SOP and
  governance authority.
- Start read-only so shared editing does not bypass writeback, review, or
  provenance rules.

## Non-Goals

- A team overlay is not a second principal inside the personal Soma home.
- A team overlay does not share `profile/`, personal Purpose, Relationship,
  private notes, raw transcripts, security traces, or local policy secrets.
- A team overlay does not replace Arc packages, Compass SOPs, or Cortex/Myelin
  collaboration.
- The first implementation does not support collaborative editing of team
  memory.
- Team overlay state is not projected into a workspace unless the principal has
  enabled that team for the workspace.

## Model

Each principal keeps a personal Soma home:

```text
~/.soma/
  profile/
  memory/
  skills/
  policy/
  teams/
    <team-id>/
      team-overlay.json
      skills/
      memory/
        KNOWLEDGE/
        WORK/
      isa/
      policy/
```

The team directory is a local materialization of a shared source. It can be
installed from an Arc package, a Git-backed team repository, or another future
backend, but the mounted shape is the same. The overlay manifest names the
team, source, version, enabled scopes, permission mode, and provenance.

Personal state remains first-class and private. Team overlay data is read as a
separate source and cited with a team prefix instead of being merged into
personal files.

## Allowed Compartments

| Area | Team overlay default | Rule |
| --- | --- | --- |
| Skills | allowed | Team skills are shared capability folders distributed by Arc or an approved source. |
| `memory/KNOWLEDGE` | read-only | Shared facts require provenance and stay team-cited. |
| `memory/WORK` | read-only | Shared project/work artifacts are visible but not silently promoted into personal work. |
| ISA | read-only | Team ISAs supplement personal/task ISAs and keep team provenance. |
| Policy | read-only | Team policy may add stricter rules; it must not relax personal policy. |
| Identity | denied | Personal principal and assistant identity are never sourced from a team overlay. |
| Purpose | denied | Personal goals and commitments are never shared by default. |
| Relationship | denied | Personal relationship memory is private and never mounted from a team overlay. |
| Raw/security | denied | Raw transcripts and security traces are not team-overlay material in the first slice. |

## Precedence

Team overlays supplement personal Soma; they do not override it.

1. Personal policy is always evaluated.
2. Team policy may only add restrictions or metadata requirements.
3. Personal skills and workspace skills keep their names. A team skill name
   collision is reported as a conflict unless the principal explicitly aliases
   one side.
4. Personal memory search results and team memory search results are separate
   cited result groups.
5. A team ISA is selected explicitly by team and slug. It does not replace the
   active personal ISA unless the principal chooses that team ISA for the
   current workspace or task.

This avoids hidden last-writer-wins behavior and makes team provenance visible
in every projected or searched result.

## Permission Model

The first implementation uses a read-only permission model:

```json
{
  "schema": "soma-team-overlay-v1",
  "teamId": "example-team",
  "source": {
    "kind": "arc-package",
    "ref": "@example/soma-team"
  },
  "scopes": ["skills", "knowledge", "work", "isa", "policy"],
  "mode": "read-only"
}
```

Policy checks every overlay before use:

- the team id must be a safe identifier
- the source must be trusted by the principal's personal policy
- requested scopes must be enabled by the overlay manifest
- denied compartments must remain absent or unread
- team policy must not relax personal policy
- every projected team artifact must retain team/source/version provenance

Malformed or unauthorized overlays fail closed and are omitted from projection,
memory search, and skill routing.

## Arc And Compass Boundaries

Arc owns distribution. Team skill registries and curated skill packs should be
Arc packages or Arc-installable references. Soma may read their manifests and
materialize them into `teams/<team-id>/`, but Arc owns package lifecycle,
version resolution, and provenance.

Compass owns SOPs and governance. A team overlay may reference Compass SOP ids,
project governance, or policy requirements, but it must not redefine the
organization process. Soma uses Compass references as context and policy input.

## First Implementation Slice

The first code slice should implement read-only team overlays:

- `soma team add --from <path-or-arc-ref> --team <team-id>` materializes a
  local overlay manifest and eligible shared files.
- `soma team list` reports enabled teams, versions, sources, scopes, and
  conflicts.
- Memory search can include team `KNOWLEDGE` and `WORK` results with team
  provenance, but keeps personal and team result groups separate.
- Skill registry can include team skills with team prefixes or aliases, but
  refuses unaliased name collisions.
- Active ISA commands can show or select a team ISA explicitly by team and slug.
- Projection code includes only enabled read-only team artifacts and never
  projects personal-private compartments from a team overlay.

Follow-up work can add reviewed team writeback, but only after team-specific
merge rules, approval, provenance, and conflict reports exist.
