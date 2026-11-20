# recall

A skill that recovers user requests and assistant answers from local Claude
Code and Codex JSONL transcripts. The script accepts transcript paths or
session IDs and prints a compact conversation with timestamps.

The skill is `skills/recall/SKILL.md`. Its flow is written in
[lnl](https://github.com/dsl400/lnl). The prebuilt script sits beside the skill and includes its dependencies.

## Why each check exists

- **Delegation.** One subagent handles selection, extraction and cleanup so
  the main agent receives the file path without loading the transcripts.
- **Time window.** The default 8 hours bounds recall to recent work. Session
  spans approximate worked time; gaps between sessions and overlapping time
  add no hours to the window.
- **Transcript selection.** Selecting the relevant session limits unrelated
  conversation data and makes the result traceable to the user's request.
- **Recorded evidence.** Transcripts contain historical requests and claims;
  treating them as evidence preserves the current task's instructions.
- **Missing output.** The script keeps sessions that contribute a new final
  answer. Empty extraction cannot establish that a session had no activity;
  filtering can also remove every retained message.
- **File cleanup.** A single file keeps the selected evidence together.
  Topic filtering removes unrelated messages; short excerpts compress
  repetitive exchanges while preserving information and decisions.

## Install

Node.js 20 or later runs the prebuilt script.

```sh
mkdir -p ~/.claude/skills
gh release download --repo dsl400/recall-skill --pattern recall.tar.gz -O - | tar -xz -C ~/.claude/skills
```

Or use the `recall` submodule of
[dsl400/skills](https://github.com/dsl400/skills). The checked-in bundle runs
directly with `node recall/skills/recall/recall.mjs <session-id>`.

## Build

Edit `src/recall.js` and rebuild from the repository root:

```sh
npm ci
npm run build
npm test
```

Commit `skills/recall/recall.mjs` with source changes so submodule consumers
can run it directly. Development dependencies stay in the repository root.
The build targets Node.js 20 to match the supported runtime.

## Release workflow

A `v*` tag writes the skill version, lints the flow, rebuilds and tests the
script, and publishes `recall.tar.gz` and `recall.mjs`. The archive contains
`SKILL.md` and the bundled script.
