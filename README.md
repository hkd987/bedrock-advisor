# bedrock-advisor

A Claude Code plugin that replicates Anthropic's [advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool) pattern client-side, so Sonnet sessions on **Amazon Bedrock**, **Google Vertex AI**, and **Microsoft Foundry** can consult Opus on-demand — not just sessions on the Anthropic first-party API.

Sonnet decides when it needs a second opinion. It calls a local MCP tool, the tool shells out to `claude -p --model opus`, and Opus's response comes back as the tool result. Sonnet continues with the advice.

## Why

Anthropic's native advisor tool lets a fast executor model (Sonnet) autonomously consult a stronger reasoning model (Opus) mid-task. It's only available on the Anthropic first-party API. If you run Claude Code through Bedrock, Vertex, or Foundry, the built-in `advisorModel` setting doesn't help — it routes through Anthropic API infrastructure.

This plugin gives you the same pattern using primitives that work on every backend today:

- **Local stdio MCP server** exposes a `consult` tool.
- **Bundled skill** teaches the model when and how to call it.
- **Tool handler shells out to `claude -p`**, inheriting your existing Claude Code auth and backend configuration. If you're on Bedrock, the advisor call goes through Bedrock. Zero extra credentials.

## How it works

```
Engineer sends task to Claude Code (Sonnet on Bedrock)
        │
        ▼
┌───────────────────────┐
│  Sonnet (executor)    │◄──────────────────────────┐
│  Working on task      │                           │
└──────────┬────────────┘                           │
           │                                        │
     Sonnet decides it                              │
     needs guidance                                 │
           ▼                                        │
┌───────────────────────┐                           │
│  MCP tool: consult    │                           │
│  (context + question) │                           │
└──────────┬────────────┘                           │
           ▼                                        │
┌───────────────────────┐                           │
│  claude -p            │                           │
│  --model opus         │                           │
│  (advisor prompt      │                           │
│   piped via stdin)    │                           │
└──────────┬────────────┘                           │
           ▼                                        │
   Opus response returned                           │
   as tool_result ──────────────────────────────────┘
```

The model self-selects when to consult — the same way the native advisor tool works. The skill file teaches the patterns (before committing to an approach, when stuck, before declaring done).

## Install

Add the marketplace and install the plugin:

```
/plugin marketplace add hkd987/bedrock-advisor
/plugin install bedrock-advisor@bedrock-advisor
```

Restart your Claude Code session. The `mcp__advisor__consult` tool should now appear in your Sonnet sessions, and the skill file will guide the model on when to use it.

### Requirements

- Node.js 18+ (you already have this if you run Claude Code).
- `claude` CLI on `PATH` (the plugin shells out to it).
- Claude Code configured for your backend (Bedrock, Vertex, Foundry, or first-party). The plugin inherits your existing auth — there's nothing to configure.

## Configuration

All configuration is via environment variables. Organizations can set these centrally through managed settings' top-level `env` block.

| Variable                                | Default | Description                                                                                                                                                                 |
| --------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADVISOR_MODEL`                         | `opus`  | Model alias or full ID passed to `claude -p --model`.                                                                                                                       |
| `ADVISOR_MAX_CALLS`                     | `5`     | Max advisor calls per server lifetime. After the limit the tool returns a budget-exhausted msg.                                                                             |
| `ADVISOR_ENABLED`                       | `true`  | Kill switch. Set to `false` to disable the tool without uninstalling the plugin.                                                                                            |
| `ADVISOR_TRANSCRIPT_ENABLED`            | `true`  | Whether to inject recent conversation history into the advisor prompt via the bundled hook. Set to `false` for v0.1 behavior.                                               |
| `ADVISOR_TRANSCRIPT_MAX_CHARS`          | `24000` | Total char budget for the transcript section (~6k tokens). Older turns fall off first; the advisor always sees the most recent work.                                        |
| `ADVISOR_TRANSCRIPT_INCLUDE_SIDECHAINS` | `false` | Include sub-agent (Task tool) turns. Off by default — they're opaque to the main thread and their output already flows back as tool results.                                |
| `ADVISOR_TRANSCRIPT_INCLUDE_THINKING`   | `false` | Include assistant thinking blocks. Off by default — they're verbose and dominate the budget.                                                                                |

Example managed settings:

```json
{
  "env": {
    "ADVISOR_MODEL": "opus",
    "ADVISOR_MAX_CALLS": "5",
    "ADVISOR_TRANSCRIPT_MAX_CHARS": "24000"
  }
}
```

### Transcript injection

The plugin ships a `PreToolUse` hook (`hooks/hooks.json`) that fires on every
`mcp__advisor__consult` call and forwards the current session's
`transcript_path` into the tool input. The MCP server then reads the JSONL
transcript, filters it, truncates within the budget, and appends a `--- Recent
conversation ---` section to the prompt it pipes into `claude -p`.

- **Self-reference filter**: prior `mcp__advisor__consult` tool_use / tool_result pairs are dropped to avoid echo chambers and reclaim budget.
- **Untrusted-by-default**: the transcript section is labeled as untrusted evidence; tool_result content is fenced so the advisor's system prompt can disclaim it. This defends against prompt-injection attacks via hostile file contents or web fetches.
- **Path validation**: transcripts are only read from files under `~/.claude/projects/` ending in `.jsonl`. A prompt-injected `_transcript_path` override cannot escape that root.
- **Graceful degradation**: if the hook isn't trusted, fails, or the server can't read the file, the advisor call still works — it just won't see the transcript section. The tool call is never failed due to transcript loading issues.

First time you install the plugin, Claude Code will prompt you to trust the
bundled hook. Accepting it enables transcript injection; declining leaves you
with v0.1 behavior.

## Cost model

**Per advisor call (estimated, with default transcript budget):**

- Opus input: ~8,000–11,000 tokens (system prompt + context blob + ~6k tokens of recent transcript)
- Opus output: ~200–400 tokens (the prompt enforces ~100 word responses)
- Roughly $0.10–$0.25 per consultation at current Bedrock Opus pricing
- With `ADVISOR_TRANSCRIPT_ENABLED=false` you land back in the v0.1 $0.05–$0.15 range

**Per task (estimated):**

- Typical 2–3 advisor calls per non-trivial task
- ~$0.20–$0.75 added on top of your Sonnet baseline
- Still significantly cheaper than running Opus for the whole session — and the grounding from real transcript access usually outweighs the delta

**Cost controls:**

- `ADVISOR_MAX_CALLS` caps calls server-side (default 5)
- `ADVISOR_TRANSCRIPT_MAX_CHARS` caps transcript section size (default 24000 chars ≈ 6k tokens)
- `ADVISOR_TRANSCRIPT_ENABLED=false` fully disables transcript injection to restore v0.1 cost profile
- The skill file discourages unnecessary calls
- The advisor system prompt enforces concise enumerated responses, keeping output tokens low

## How this differs from `opusplan`

| Aspect                    | `opusplan`                     | bedrock-advisor                              |
| ------------------------- | ------------------------------ | -------------------------------------------- |
| Model switching           | Static (Opus plan, Sonnet exec) | Dynamic (Sonnet full session, Opus on call) |
| Who decides               | User (plan mode toggle)        | Model (autonomous tool call)                 |
| Opus involvement          | 100% of plan-mode tokens       | Targeted ~100-word consultations             |
| Cost profile              | Opus rates for all planning    | Sonnet rates + small Opus calls              |

## How this differs from the native advisor tool

| Aspect                       | Native (Anthropic API)                         | bedrock-advisor                                                               |
| ---------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Model self-selects when to call | Yes (built-in)                              | Yes (via skill file)                                                          |
| Mid-generation injection     | Yes                                            | No — fires between turns as a tool call                                       |
| Context to advisor           | Full transcript (automatic)                    | Recent transcript (automatic via hook) + engineer context blob                |
| Works on Bedrock/Vertex/Foundry | No                                          | Yes                                                                           |
| Cost controls                | `max_uses` parameter                           | `ADVISOR_MAX_CALLS`, `ADVISOR_TRANSCRIPT_MAX_CHARS`                            |
| Advisor caching              | Server-side prompt caching                     | No (each `claude -p` is a fresh invocation)                                   |

The mid-generation gap is negligible for agentic coding workflows — Sonnet is already making constant tool calls, so the advisor call interleaves naturally between turns.

## Migration to native advisor

When Anthropic ships the native advisor tool on your backend:

1. Disable this plugin (`/plugin uninstall bedrock-advisor@bedrock-advisor`, or set `ADVISOR_ENABLED=false`).
2. Set `advisorModel` in your Claude Code settings (this is the native Claude Code setting for the server-side advisor).
3. The skill file's guidance on when to consult carries over — the same patterns apply.

## Development

```bash
cd server
npm install
npm run build
npm test
```

Source lives in `server/src/`. Compiled output is committed under `server/dist/` so end users don't need a build step. CI verifies the committed `dist/` matches the sources.

### Repo layout

```
bedrock-advisor/
├── .claude-plugin/
│   ├── plugin.json              # Plugin manifest
│   └── marketplace.json         # Marketplace catalog
├── .mcp.json                    # Declares the stdio server
├── .github/workflows/build.yml  # CI: build + test + dist/ freshness check
├── hooks/
│   ├── hooks.json               # PreToolUse hook on mcp__advisor__consult
│   └── inject-transcript.mjs    # Forwards transcript_path into the tool input
├── server/
│   ├── src/
│   │   ├── index.ts             # MCP server + consult tool
│   │   ├── advisor.ts           # spawn('claude', ...) wrapper
│   │   ├── config.ts            # Env var parsing
│   │   └── transcript.ts        # JSONL read/filter/budget/format for transcript injection
│   ├── test/                    # Node --test suites
│   │   ├── advisor.test.ts      # Injectable-spawner smoke tests
│   │   ├── config.test.ts       # Env var parsing
│   │   ├── hook.test.ts         # Subprocess tests for inject-transcript.mjs
│   │   ├── index.test.ts        # buildPrompt + loadTranscriptSafely
│   │   ├── transcript.test.ts   # transcript.ts unit + golden fixture
│   │   └── fixtures/transcript.jsonl
│   ├── dist/                    # Compiled JS (committed)
│   ├── package.json
│   └── tsconfig.json
├── skills/advisor/SKILL.md      # Teaches the model when/how to consult
├── LICENSE                      # MIT
└── README.md
```

## License

MIT. See [LICENSE](./LICENSE).
