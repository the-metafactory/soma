# CanonicalizeSkill

## Input

```
~/.claude/skills/[skill-name]/SKILL.md
```

## Steps

1. Back up before modifying:
   ```bash
   cp -r ~/.claude/skills/[skill-name]/ ~/.claude/History/Backups/[skill-name]-backup-$(date +%Y%m%d)/
   ```

   **Note:** Backups go to `~/.claude/History/Backups/`, NEVER inside skill directories.

2. Validate against the reference: `~/.claude/PAI/SkillSystem.md`
