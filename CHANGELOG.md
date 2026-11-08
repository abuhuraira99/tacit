# Changelog

## 1.1.0 (2026-11-08)

- New **Startup memory** page: see exactly which CLAUDE.md files (and `@` imports) every new chat starts with, and how
  many tokens they add.
- Switch a whole file off for new chats, and back on, without deleting it.
- Pause, turn back on, or remove single rules; add rules under any heading.
- Edit a memory file directly, with a line-by-line preview before saving.
- Change history for every file Tacit writes, including rules saved from Repeats, with compare and restore from backups.
- Rules added by Tacit are marked in the rule list.

## 1.0.0 (2026-11-08)

First release.

- Parallel, cached parser for Claude Code transcripts, including subagent transcripts.
- Habit mining with typo-tolerant grouping, correction-loop detection and reused-brief detection.
- Drafts for CLAUDE.md rules, Skills, hooks, subagents and slash commands, with project or personal scope.
- Trigger check for Skill and subagent descriptions against your own history.
- Memory health for global and project CLAUDE.md files.
- Session explorer with context curves, compactions and heavy tool outputs.
- Markdown retrospective export.
- Optional Refine with Claude through the Claude API or Claude Code.
- CLI: `scan`, `habits`, `report`, `doctor`, `--demo`.
- Light and dark themes; works from 390 px wide.
