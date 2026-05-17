---
name: Issue86Fixture
description: USE WHEN reproducing issue 86 — surfaces every claude-path rewrite class plus PAI Customization block.
---

# Issue86Fixture

Fixture pack that intentionally embeds every `~/.claude/<subpath>` shape called
out in `the-metafactory/soma#86` plus the PAI `## Customization` runtime block.

Used by the importer test suite to lock the post-fix normalizer against silent
regressions on:

- `~/.claude/skills/...` — deterministic Soma rewrite
- `~/.claude/PAI/MEMORY/...` — deterministic Soma memory rewrite
- `~/.claude/PAI/DOCUMENTATION/...` — unmapped catch-all
- `~/.claude/PAI/SkillSystem.md` — unmapped catch-all (PAI runtime root)
- `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/...` — stripped via Customization block
- `~/.claude/History/Backups/...` — unmapped catch-all
- `## Customization` heading — stripped as PAI runtime block

After normalization the body must contain zero `~/.claude/` strings.
