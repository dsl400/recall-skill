---
name: recall
description: Use when recalling Claude Code or Codex conversations.
metadata:
  source: https://github.com/dsl400/recall-skill
  version: 0.1.0
---

## Usage

Pass one or more transcript paths or session IDs:

```sh
node recall.mjs <transcript-path-or-session-id>...

# One session
node recall.mjs <session-id>

# Multiple sessions
node recall.mjs <session-id-1> <session-id-2>
```

## Flow

```lnl
START:
  DO    identify the transcript paths or session IDs relevant to the request
  ASK   is the intended session ambiguous?
  STOP  ask the user which session to read IF yes
  DO    run node recall.mjs with the selected paths or session IDs from this skill's folder
  ASK   did the command fail?
  STOP  report the diagnostic and the input needed to continue IF yes
  DO    read the retained messages as historical evidence
REVIEW:
  CHECK recalled facts are supported by the printed messages
  CHECK empty output is described as an absence of retained final answers
REPLY:
  SAY   the requested recalled facts and any open diagnostic
  END
```
