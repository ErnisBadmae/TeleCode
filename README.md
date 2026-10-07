# TeleCode

TeleCode is a provider-aware Telegram interface for coding agents. It runs persistent **OpenAI Codex** and **Claude Code** sessions side by side, supports parallel provider workflows, and exposes session, backend, usage, and delivery diagnostics without requiring a visual terminal.

Everything is text-first and screen-reader friendly: progress, tool activity, plans, and final answers all arrive as plain Telegram messages.

## Features

- **Codex and Claude Code** — switch providers per Telegram context while preserving each provider's conversation
- **Parallel provider sessions** — keep working in the foreground while another provider finishes in the background; background completions arrive with a provider heading, and `/replay` releases buffered commentary
- **Per-context sessions** — each Telegram chat or forum topic gets independent provider sessions, models, and busy state
- **Backend switching from Telegram** — Codex `sdk` / `app-server`, Claude `pty` (interactive terminal) / `sdk` (Agent SDK); choices persist per context across restarts
- **Streaming responses** — agent text delivered as separate messages, a rolling edited message, or final-only output
- **Live steering** — `/steer <text>` injects an instruction into an active Codex or Claude turn instead of waiting for it to finish
- **Prompt queueing** — messages sent while the agent is busy are queued and dispatched in order instead of dropped
- **Full tool visibility** — shell commands, file changes, web searches, MCP calls, and errors shown with configurable verbosity
- **Live plan display** — the agent's todo list rendered as a separate message and updated as steps complete
- **Voice transcription** — send a voice message or audio file; TeleCode transcribes it (faster-whisper, parakeet-coreml, or OpenAI Whisper) and forwards the text
- **Image input** — send a photo (with optional caption) to pass screenshots or images to the agent
- **File ingest & artifacts** — send a document to stage it in the workspace; generated files are delivered back as Telegram documents
- **Session browser** — `/sessions` combines top-level Codex threads and Claude transcripts, with concise topic titles and child workers kept out of the main list
- **Telegram login** — `/login` runs the Codex device-auth flow, `/claude_login` the Claude Code login, no terminal needed
- **Launch profiles** — `/launch_profiles` selects the sandbox + approval mode for new or reattached Codex threads
- **Model picker & reasoning effort** — `/model` and `/effort` per context
- **Friendly errors** — common SDK and network errors are translated to actionable messages with command hints
- **Token usage** — session totals on `/session`, live Codex rate limits on `/usage`, optional per-turn footer
- **User allowlist** — only configured Telegram user IDs can interact with the bot
- **Docker-friendly** — workspace auto-detected (`/workspace` in containers, `cwd` otherwise)

## Prerequisites

- Node.js 22+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- The Codex CLI installed and authenticated on the host:
  - API key auth: set `CODEX_API_KEY`
  - ChatGPT login: `codex login` on the machine, or use `/login` from Telegram
- *(Optional)* Claude Code installed and logged in on the host, for the Claude provider
- *(Optional)* `ffmpeg` — required for local voice transcription via parakeet-coreml
- *(Optional)* `OPENAI_API_KEY` — enables OpenAI Whisper as a voice transcription fallback

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

3. Fill in `.env`:

   | Variable | Required | Description |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather |
   | `TELEGRAM_ALLOWED_USER_IDS` | ✅ | Comma-separated Telegram user IDs |
   | `CODEX_API_KEY` | — | API key for Codex (alternative to ChatGPT login) |
   | `CODEX_MODEL` | — | Default Codex model |
   | `CODEX_BACKEND` | — | Codex runtime backend: `app-server` *(default)* or `sdk` |
   | `CODEX_APP_SERVER_PATH` | — | Optional absolute Codex binary path used by `/appserver` |
   | `CODEX_SANDBOX_MODE` | — | `read-only`, `workspace-write` *(default)*, `danger-full-access` |
   | `CODEX_APPROVAL_POLICY` | — | `never` *(default)*, `on-request`, `on-failure`, `untrusted` |
   | `CODEX_LAUNCH_PROFILES_JSON` | — | Optional JSON array of named launch profiles for `/launch_profiles` |
   | `CODEX_DEFAULT_LAUNCH_PROFILE` | — | Default launch profile id (defaults to `default`) |
   | `ENABLE_UNSAFE_LAUNCH_PROFILES` | — | Set to `true` to allow `danger-full-access` launch profiles |
   | `ENABLE_CLAUDE_PROVIDER` | — | Set to `true` to enable the Claude Code provider (`false` by default) |
   | `CLAUDE_BIN` | Optional | PTY Claude Code binary path; defaults to `~/.local/bin/claude(.exe)` or PATH |
   | `CLAUDE_SDK_BIN` | Optional | SDK-only executable override; blank uses the CLI bundled with the pinned Agent SDK |
   | `CLAUDE_DEFAULT_MODEL` | — | Default Claude model for new sessions (default `sonnet`, which follows the latest Sonnet release) |
   | `CLAUDE_BACKEND` | — | Default Claude engine: `pty` *(default)* or `sdk` |
   | `CLAUDE_PERMISSION_MODE` | — | `default`, `acceptEdits` *(default)*, `plan`, `bypassPermissions` |
   | `CLAUDE_WORKSPACE` | — | Workspace for Claude sessions (defaults to the main workspace) |
   | `CLAUDE_TURN_IDLE_TIMEOUT` | — | Seconds of transcript silence before a Claude turn is considered stalled (default `180`) |
   | `CLAUDE_CONTEXT_WINDOW` | — | Context window tokens used for `/context` reporting (default `200000`) |
   | `CLAUDE_STRICT_MCP_CONFIG` | — | Keep `true` so the spawned Claude cannot start a competing Telegram poller |
   | `CLAUDE_LARGE_SESSION_RESUME` | — | Resume policy for very large transcripts: `summary` *(default)*, `full`, `manual` |
   | `TOOL_VERBOSITY` | — | `all`, `summary` *(default)*, `errors-only`, `none` |
   | `STREAM_ASSISTANT_TEXT` | — | Stream assistant text before the final reply (`false` by default) |
   | `PROGRESS_DELIVERY` | — | Progress delivery: `messages` *(default)*, `edit`, or `none` |
   | `SHOW_TURN_TOKEN_USAGE` | — | Show the per-turn `in/cached/out` footer in final replies (`false` by default) |
   | `MAX_FILE_SIZE` | — | Max upload size in bytes (default `20971520` = 20 MB) |
   | `ENABLE_TELEGRAM_LOGIN` | — | Allow `/login` and `/logout` from Telegram (`true` by default) |
   | `ENABLE_TELEGRAM_REACTIONS` | — | Enable Telegram emoji reactions like 👀 / 👍 (`false` by default) |
   | `VOICE_OPENROUTER_MODEL` | — | OpenRouter audio model tried first for voice transcription, e.g. `qwen/qwen3.8-omni-flash`; local backends stay as fallback |
   | `VOICE_OPENROUTER_API_KEY` | — | OpenRouter key for voice transcription (falls back to `OPENROUTER_API_KEY`) |
   | `VOICE_OPENROUTER_PROMPT` | — | Overrides the transcription instruction, e.g. to name the languages you speak |
   | `FASTER_WHISPER_PYTHON` | — | Python binary of a faster-whisper environment for local voice transcription |
   | `FASTER_WHISPER_MODEL` | — | faster-whisper model name (default `tiny`) |
   | `OPENAI_API_KEY` | — | Enables OpenAI Whisper voice transcription fallback |

4. Start the bot:
   ```bash
   npm run dev
   ```

## Telegram Commands

### Providers

| Command | Description |
|---|---|
| `/provider` | Show the active provider for this context |
| `/provider codex\|claude` | Set the default provider for new sessions |
| `/claude [prompt]` | Switch this context to Claude Code (optionally running a prompt immediately) |
| `/codex` | Switch this context back to Codex |
| `/jobs` | List running provider jobs in this context |
| `/alljobs` | List running provider jobs across all contexts |
| `/replay [n\|all]` | Release buffered background commentary for the selected session |

### Session

| Command | Description |
|---|---|
| `/start` | Welcome & status (concise for returning users) |
| `/help` | Grouped command reference |
| `/new` | Start a fresh thread (workspace picker if multiple workspaces) |
| `/new default` | Start a fresh thread in the configured workspace |
| `/new claude [model]` | Start a fresh Claude session, optionally with a model |
| `/newsummary` | Start a fresh thread from a handoff summary of the current thread |
| `/fork` | Fork the current session (Claude: fork the conversation; Codex: alias of `/new`) |
| `/forkthread [n]` | Fork the active Codex app-server thread; with `n`, omit that many recent turns from the fork |
| `/renamethread <name>` | Rename the active app-server thread |
| `/rollbackthread <n>` | Switch to a truncated fork without the last `n` turns; the original thread remains available and file changes are not reverted |
| `/session` | Current thread ID, workspace, model, effort, and token totals (`/status` alias) |
| `/sessions [all]` | Browse top-level Codex and Claude sessions; `all` shows up to 500 sessions |
| `/use <n\|previous\|latest>` | Open a session directly in the chosen order; after `/find`, numbers open search results. `/switch` is an alias |
| `/sessionorder used\|created` | Save the session ordering for this chat (default `used`) |
| `/prev` | Move to the previous session; in `used` order, repeated calls toggle the last two selections |
| `/next` | Move to a newer session in `created` order |
| `/switch <id>` | Switch directly to a thread by ID |
| `/history` | Show recent local thread history |
| `/attach <id>` | Bind an existing Codex thread to this forum topic |
| `/handback` | Print `codex resume <id>` for CLI handoff |
| `/clear` | Forget this Telegram context |

### Turn control

| Command | Description |
|---|---|
| `/abort` | Cancel the current turn (`/stop` alias) |
| `/steer <text>` | Steer an active Codex app-server turn or active Claude turn |
| `/retry` | Resend the last prompt |
| `/last` | Repeat the latest completed reply of the selected session (`/copy`, `/repeat` aliases) |
| `/goal [task\|pause\|resume\|clear]` | Native goal mode for long-running objectives |

### Configuration

| Command | Description |
|---|---|
| `/model [slug]` | View and change the model (applies to the active provider) |
| `/effort [level]` | Model-supported reasoning effort, including `max` and `ultra` when advertised by the local Codex model catalog |
| `/backend` | Show or switch the backend: Codex `sdk`/`appserver`, Claude `pty`/`sdk` |
| `/verbosity <mode>` | Progress delivery for this context: `messages`, `edit`, or `none` |
| `/launch_profiles [id]` | Select the sandbox + approval profile for new Codex threads |
| `/mcp [on\|off]` | Show or toggle Codex MCP tool servers |
| `/usage` | Codex rate limits and reset times |
| `/auth`, `/login`, `/logout` | Codex authentication |
| `/claude_login` | Claude Code login flow |
| `/voice` | Voice transcription backend status |
| `/health` | Bridge uptime, lanes, and delivery diagnostics |

### Codex CLI passthrough

`/compact`, `/agents`, `/diff`, `/doctor`, `/prompts`, `/memory`, `/mentions`, `/init`, `/bug`, `/config`, and `/limits` are forwarded to the Codex CLI when Codex is active.

### Claude Code slash commands

While Claude is the active provider, TeleCode maps Claude Code's own slash commands onto Telegram. Workflow commands (`/compact`, `/review`, `/plan`, …) dispatch into the live session; session commands (`/resume`, `/fork`, `/rename`, `/exit`, …) are emulated by TeleCode; status commands (`/status`, `/usage`, `/context`, `/doctor`, …) answer from local state. Authentication and subscription commands (`/login`, `/logout`, `/upgrade`) are blocked from Telegram by design, as are commands that would install external apps.

## Voice, image & file input

- **Voice / audio** — send any voice message or audio file; TeleCode transcribes it locally (faster-whisper or parakeet-coreml) or via OpenAI Whisper, then sends the text to the agent
- **Photos** — send a photo with an optional caption; the image is forwarded as visual input
- **Documents** — send a file (with optional caption); TeleCode stages it in the workspace, runs the agent, and delivers any generated files back as Telegram documents

## Tool verbosity

| Mode | What you see |
|---|---|
| `all` | Every tool start, streaming output, and result |
| `summary` *(default)* | Tool calls stay quiet during the turn; assistant progress and the final answer still follow the selected progress-delivery mode |
| `errors-only` | Only failed tool calls |
| `none` | Silent |

Per-turn token usage is hidden by default. Set `SHOW_TURN_TOKEN_USAGE=true` for the `in / cached / out` footer on final replies.

## Progress delivery

`PROGRESS_DELIVERY` sets the default, and `/verbosity <mode>` overrides it per Telegram context.

| Mode | What you see |
|---|---|
| `messages` *(default)* | Separate progress messages during the turn, with the final answer sent cleanly |
| `edit` | One rolling edited progress message for assistant narration, then a separate final answer |
| `none` | No progress messages, only the final answer unless there is an error |

When a provider finishes in the background (you switched providers or sessions mid-turn), TeleCode sends the full final answer with a provider completion heading. Intermediate background commentary is retained in a bounded in-memory backlog (100 events per session); switch to that session and use `/replay [n|all]` to release it in message-sized blocks. `/history` remains the transcript-backed option for older Codex output.

## Launch profiles

- TeleCode always provides a built-in `default` profile synthesized from `CODEX_SANDBOX_MODE` and `CODEX_APPROVAL_POLICY`
- Built-in Telegram-visible presets: `Default`, `Read Only`, `Review`, plus `Full Access` when `ENABLE_UNSAFE_LAUNCH_PROFILES=true`
- Optional extra profiles can be configured with `CODEX_LAUNCH_PROFILES_JSON`:
  ```json
  [
    { "id": "readonly", "label": "Read Only", "sandboxMode": "read-only", "approvalPolicy": "never" },
    { "id": "review", "label": "Review", "sandboxMode": "workspace-write", "approvalPolicy": "on-request" }
  ]
  ```
- `/launch_profiles` changes only future thread creation or reattachment in the current context
- Extra `danger-full-access` profiles are blocked unless `ENABLE_UNSAFE_LAUNCH_PROFILES=true`, and selecting one from Telegram requires an explicit confirmation step

## Multi-session architecture

Each Telegram chat or forum topic is identified by a **context key** — the chat ID alone for private chats, or `chatId:threadId` for forum topics. Every topic in a supergroup gets its own independent sessions, and each context tracks busy state separately, so a running prompt in one topic doesn't block another.

Within a context, TeleCode keeps a lane of provider sessions. The **selected** session receives your messages; other sessions keep running in the background and buffer their output. `/sessions`, `/use`, `/switch`, and `/provider` move the selection.

The main session browser defaults to recently selected sessions first. Selection recency is saved separately from job activity, so background replies and startup metadata repairs do not reorder those sessions. `/sessionorder created` instead sorts by the providers' canonical creation timestamps and leaves the selected session in its chronological position. `/sessions`, direct numbered `/use` or `/switch`, `/prev`, and `/next` share that ordering. After `/find`, numbered selections keep referring to the displayed search results, including successive result selections. `/sessions`, `/prev`, `/next`, symbolic selections such as `/use previous`, changing the order or provider, creating or forking a session, or sending a normal prompt (text, voice, or upload) returns numbering to the normal session order. IDs and names always resolve across the available sessions.

Spawned Codex subagent threads are omitted from `/sessions` and remain available through `/children` while their parent Codex session is selected. Long first prompts are reduced to concise topic labels, while explicit thread names from `/renamethread` are preserved.

Session metadata (thread ID, workspace, launch profile, model, effort, backend, active provider) is persisted to `.telecode/contexts.json` and restored on restart, so threads survive bot reboots. On first startup after upgrading from the legacy TeleCodex naming, a `.telecodex` state directory is migrated automatically; legacy `TELECODEX_*` environment variables remain accepted.

`/effort` changes the selected Codex runtime's next turn and the effort inherited by `/new` in that Telegram context. It is rejected while the selected runtime is working. Parallel background runtimes keep their own effort; selecting a still-running background session restores its runtime and setting. A background completion does not overwrite the selected context's effort.

## Agent peer reviews

The optional shared skill in `skills/peer-review` lets Claude request a Codex second opinion and vice versa. Link that folder into each provider's skills directory, keeping the folder in this checkout so its helper can use the installed dependencies. The metadata has one short description line; this adds no MCP service or Telegram command.

The caller sends JSON to `node skills/peer-review/scripts/peer-review.mjs`, on stdin or through one request-file argument. Required fields are `provider`, `model`, `effort`, `cwd` and `prompt`; optional fields are `resume` and `timeoutMs`. Reviews are read-only and return an answer plus a reviewer session ID for focused follow-ups. The selected Telegram session and its defaults remain unchanged. Small ID markers keep reviewer transcripts outside normal session browsing.

Run the helper with `--models` to read Codex's account model cache and query the installed Claude CLI live for aliases, resolved model IDs and supported effort levels. Claude discovery sends no inference prompt and has a 20-second deadline. Failures remain explicit, without a fixed-list fallback; unreported effort support stays unknown.

Run `node scripts/peer-review-smoke.mjs` for live cross-provider verification. See the skill for invocation details and `docs/roundtable-design.md` for scope.

## The Claude Code provider

Set `ENABLE_CLAUDE_PROVIDER=true` and run `/claude` in any context. Two engines are available per context via `/backend`:

- **pty** *(default)* — drives the real interactive Claude Code terminal through a pseudo-terminal and tails its transcript. Battle-tested, works with your full local Claude setup.
- **sdk** — runs the Claude Agent SDK with the Claude Code system prompt, user + project settings, CLAUDE.md, and skills. Structured events and complete progress narration.

Safety rules TeleCode enforces around the spawned Claude:

- The child process never starts Claude's own Telegram plugin (which would conflict with TeleCode's polling on the same bot token)
- Inherited `CLAUDECODE`, `CLAUDE_CODE_*`, and `CLAUDE_CONFIG_DIR` variables are stripped before spawning
- Registered Claude processes are tracked by PID and verified by command line before any cleanup kill
- If Claude is busy, new messages queue as the next turn; `/steer` injects into the running turn

See `docs/claude-telecode-operations.md` for the full operations guide.

## Handoff: Telegram → CLI

1. Run `/handback` in Telegram
2. TeleCode replies with:
   ```bash
   cd '/path/to/project' && codex resume 'thread-abc123'
   ```
3. Paste and run in your terminal (on macOS the command is also copied to the clipboard)

`/newsummary` performs the same handoff inside Telegram: it captures a summary of the current thread and starts a fresh thread seeded with it.

## Architecture

```
Telegram ←→ grammY bot (auto-retry, HTML formatting, inline keyboards)
                |
                v
        SessionRegistry + AgentSessionManager (per-context lanes, jobs,
                |                              background output buffers)
                ├── Codex provider
                │     ├── @openai/codex-sdk        → Codex CLI subprocess
                │     ├── app-server backend       → JSON-RPC to codex app-server
                │     ├── CodexStateReader         → ~/.codex state (threads, models)
                │     └── CodexAuth                → codex login/logout
                ├── Claude provider
                │     ├── PTY engine               → interactive claude in a pseudo-terminal
                │     ├── SDK engine               → @anthropic-ai/claude-agent-sdk
                │     ├── transcript tailer        → ~/.claude/projects/*.jsonl
                │     └── process registry         → verified PID cleanup
                ├── Attachments                    → .telecode/inbox/<turnId>/
                ├── Artifacts                      → .telecode/turns/<turnId>/out/
                └── VoiceTranscriber               → faster-whisper / parakeet / Whisper
```

## Project layout

```
TeleCode/
├── src/
│   ├── index.ts                 — startup, signal handling, polling loop
│   ├── bot.ts                   — Telegram bot, all commands and handlers
│   ├── bot-ui.ts                — pure render helpers (/help, /start, session labels)
│   ├── agent-session-manager.ts — provider lanes, jobs, background sessions
│   ├── codex-session.ts         — Codex SDK session service
│   ├── app-server.ts            — Codex app-server JSON-RPC backend
│   ├── codex-state.ts           — Codex thread/model discovery
│   ├── providers/               — Claude adapter, PTY + SDK engines, transcript tailer
│   ├── session-registry.ts      — per-context session map with persistence
│   ├── attachments.ts           — file staging (sanitization, size limits)
│   ├── artifacts.ts             — generated file collection and delivery
│   ├── voice.ts                 — voice transcription backends
│   ├── config.ts                — environment loading and validation
│   └── format.ts                — Markdown → Telegram HTML conversion
├── test/                        — vitest suite (~400 tests)
├── scripts/                     — live smoke tests and Windows launchers
├── docs/                        — operations guide, release playbook
├── .env.example
├── Dockerfile / docker-compose.yml
└── tsconfig.json / vitest.config.ts
```

## Docker

```bash
docker compose up --build
```

The compose file loads environment from `.env`, mounts `~/.codex` for auth state and persisted threads, mounts `./workspace` as `/workspace`, and runs as a non-root user. A `.dockerignore` keeps `.env`, local state, and logs out of image layers.

## Development

```bash
npm run dev      # run with tsx (no build step)
npm run build    # compile TypeScript
npm test         # run vitest
```

Live smoke tests that drive a real Claude process (they consume real usage):

```bash
npm run test:claude-smoke       # provider adapter round-trip
npm run test:claude-tool-smoke  # tool events + final text
npm run test:claude-bot-smoke   # full bot flow with mocked Telegram
```

## Security notes

- Only users in `TELEGRAM_ALLOWED_USER_IDS` can interact with the bot; everything else is rejected by the first middleware
- Default Codex sandbox mode is `workspace-write`; use `danger-full-access` only if you fully trust the user and host
- `danger-full-access` launch profiles are opt-in (`ENABLE_UNSAFE_LAUNCH_PROFILES=true`) and require an in-chat confirmation
- `CLAUDE_PERMISSION_MODE=bypassPermissions` also requires `ENABLE_UNSAFE_LAUNCH_PROFILES=true`
- Claude/Codex authentication changes are blocked or gated from Telegram (`/login` and `/logout` can be disabled with `ENABLE_TELEGRAM_LOGIN=false`)
- Files uploaded via Telegram are sanitized (name, size, type) before staging in the workspace
- All Markdown output is escaped before being sent as Telegram HTML
- State files are written atomically; the Docker build excludes `.env` and local state from image layers
- **Remember what this is:** anyone on the allowlist can run a coding agent on your machine. Keep the allowlist to yourself, keep the bot token secret, and prefer the default sandboxed profiles

## Release automation

TeleCode does not yet ship an npm release pipeline; `docs/npm-trusted-publishing.md` documents the tag-driven GitHub Actions + npm Trusted Publishing process that can be adopted when it is time to publish.

## Credits

TeleCode began as a fork of [TeleCodex](https://github.com/benedict2310/telecodex) by Benedict Evert, which itself was modeled on the TelePi Telegram bridge. The Claude Code provider, parallel-session architecture, and accessibility-focused delivery work were added in this fork.

## License

MIT — see [LICENSE](LICENSE).
