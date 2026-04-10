---
name: advisor
description: When and how to consult the mcp__advisor__consult tool — a stronger reasoning model (Opus) that reviews your context and returns strategic guidance. Apply whenever choosing an approach on a non-trivial task, when stuck, when considering a change of direction, or before declaring a task complete.
---

# Advisor Tool

You have access to an `mcp__advisor__consult` tool backed by a stronger
reasoning model (Opus). It reviews your context and provides strategic
guidance in under 100 words as enumerated steps.

## When to call

- Before committing to an approach on non-trivial tasks
- When stuck — errors recurring, approach not converging
- When considering a change of approach
- Before declaring a task complete (write/save files first)

## When NOT to call

- If you are running as Opus — you are already the strongest model
  available, and calling the advisor would be redundant
- For simple, mechanical tasks where the next step is obvious
- Back-to-back without doing meaningful work between calls
- For quick lookups or exploration (read files first, then call)

## How to call

Provide rich context in the `context` parameter:

- What the task is
- What you've learned or read so far
- What approach you're considering or have started
- What's blocking you or what you're uncertain about

The advisor ONLY sees what you put in `context`. Be thorough — it has
no access to your conversation, your file reads, or your tool history.

Optionally provide a specific `question` if you have one beyond general
"is my approach right?" guidance.

## How to treat the response

Give the advice serious weight. If it conflicts with evidence you have
(a file says X, a test shows Y), surface the conflict in another advisor
call — "I found X, you suggested Y, which should I follow?" — rather than
silently diverging. The advisor may have underweighted your evidence; a
reconcile call is cheaper than committing to the wrong branch.

## Budget

The tool is capped per session (default 5 calls via `ADVISOR_MAX_CALLS`).
Spend calls on genuine decision points, not reassurance.
