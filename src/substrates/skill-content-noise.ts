/**
 * #106 — Editor/IDE configuration directories whose ENTIRE contents are
 * noise, not skill content. `claude-skills-migrator.ts` skips them as
 * regular directories and refuses symlinks into them (the #104 symlink
 * denylist), so both kinds of contents stay out of `~/.soma/skills/`.
 *
 * Each entry is a bare directory name, matched against POSIX-style path
 * segments so `.vscode/launch.json`, `nested/.idea/x.md`, and
 * `src/Workflows/.cursor/rules/r.md` all hit, while substring collisions
 * (e.g. `my.cursor.dir/`) do not.
 */
export const EDITOR_CONFIG_DIRS = [".cursor", ".vscode", ".idea", ".fleet", ".zed"] as const;
