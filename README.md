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

| Variable              | Default | Description                                                                                     |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `ADVISOR_MODEL`       | `opus`  | Model alias or full ID passed to `claude -p --model`.                                           |
| `ADVISOR_MAX_CALLS`   | `5`     | Max advisor calls per server lifetime. After the limit the tool returns a budget-exhausted msg. |
| `ADVISOR_ENABLED`     | `true`  | Kill switch. Set to `false` to disable the tool without uninstalling the plugin.                |

Example managed settings:

```json
{
  "env": {
    "ADVISOR_MODEL": "opus",
    "ADVISOR_MAX_CALLS": "5"
  }
}
```

## Cost model

**Per advisor call (estimated):**

- Opus input: ~2,000–5,000 tokens (system prompt + your context blob)
- Opus output: ~200–400 tokens (the prompt enforces ~100 word responses)
- Roughly $0.05–$0.15 per consultation at current Bedrock Opus pricing

**Per task (estimated):**

- Typical 2–3 advisor calls per non-trivial task
- ~$0.10–$0.45 added on top of your Sonnet baseline
- Significantly cheaper than running Opus for the whole session

**Cost controls:**

- `ADVISOR_MAX_CALLS` caps calls server-side (default 5)
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

| Aspect                       | Native (Anthropic API)                         | bedrock-advisor                                      |
| ---------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| Model self-selects when to call | Yes (built-in)                              | Yes (via skill file)                                 |
| Mid-generation injection     | Yes                                            | No — fires between turns as a tool call              |
| Context to advisor           | Full transcript (automatic)                    | Context blob provided by executor                    |
| Works on Bedrock/Vertex/Foundry | No                                          | Yes                                                  |
| Cost controls                | `max_uses` parameter                           | `ADVISOR_MAX_CALLS` env var                          |
| Advisor caching              | Server-side prompt caching                     | No (each `claude -p` is a fresh invocation)          |

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
├── server/
│   ├── src/
│   │   ├── index.ts             # MCP server + consult tool
│   │   ├── advisor.ts           # spawn('claude', ...) wrapper
│   │   └── config.ts            # Env var parsing
│   ├── test/advisor.test.ts     # Injectable-spawner smoke tests
│   ├── dist/                    # Compiled JS (committed)
│   ├── package.json
│   └── tsconfig.json
├── skills/advisor/SKILL.md      # Teaches the model when/how to consult
├── LICENSE                      # MIT
└── README.md
```

## License

MIT. See [LICENSE](./LICENSE).
