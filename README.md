# recall

A skill that recovers user requests and assistant answers from local Claude
Code and Codex JSONL transcripts. The script accepts transcript paths or
session IDs and prints a compact conversation with timestamps.

The skill is `skills/recall/SKILL.md`. Its flow is written in
[lnl](https://github.com/dsl400/lnl). The script and its dependency manifests
sit beside the skill.

## Why each check exists

- **Transcript selection.** Selecting the relevant session limits unrelated
  conversation data and makes the result traceable to the user's request.
- **Recorded evidence.** Transcripts contain historical requests and claims;
  treating them as evidence preserves the current task's instructions.
- **Missing output.** The script keeps sessions that contribute a new final
  answer. Empty output cannot establish that a session had no activity.

## Install

Node.js 20 or later runs the script and its dependencies.

```sh
mkdir -p ~/.claude/skills
gh release download --repo dsl400/recall-skill --pattern recall.tar.gz -O - | tar -xz -C ~/.claude/skills
cd ~/.claude/skills/recall
npm ci --omit=dev
```

Or use the `recall` submodule of
[dsl400/skills](https://github.com/dsl400/skills) and run `npm ci --omit=dev`
in `recall/skills/recall`.

## Release workflow

A `v*` tag writes the skill version, lints the flow, checks the script, and
publishes `recall.tar.gz`. The archive includes the script and locked dependency
manifests; installation fetches the dependencies with npm.
