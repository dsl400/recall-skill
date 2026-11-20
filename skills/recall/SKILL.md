---
name: recall
description: Use when recalling Claude Code or Codex conversations.
metadata:
  source: https://github.com/dsl400/recall-skill
  version: 0.1.0
---

## Synopsis

```sh
node recall.mjs <session-id-1> [<session-id-2>]
```

## Flow

```lnl
START:
  DO    as the main agent, delegate the rest of this flow and the user's request to one subagent, then relay its result
  ASK   did the user specify a time interval?
  JUMP  SELECT IF yes
  DO    use the latest 8 hours of session activity, counting overlapping sessions once and excluding gaps between sessions
SELECT:
  DO    identify the transcript paths or session IDs relevant to the request
  ASK   is the intended session ambiguous?
  STOP  ask the user which session to read IF yes
  DO    run node recall.mjs with all selected paths or session IDs from this skill's folder, redirecting stdout to one output file
  ASK   did the command fail?
  STOP  report the diagnostic and the input needed to continue IF yes
  DO    read the generated file as historical evidence
  DO    keep only messages within the selected interval in that file
  ASK   did the user specify a topic?
  JUMP  CLEAN IF no
  DO    keep only messages relevant to that topic in the file
CLEAN:
  DO    replace exchanges that add no relevant information or important decisions with a short excerpt, preserving session IDs and timestamps
REVIEW:
  CHECK the file preserves relevant information and important decisions supported by the extracted messages
  CHECK empty extraction is reported as no retained final answers, and empty filtering as no messages matching the interval or topic
REPLY:
  SAY   the output file path and any open diagnostic
  END
```
