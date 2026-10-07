# Claude and TeleCode Operations

This project has two safe Claude Code modes.

1. Integrated Claude through TeleCode

Use this when you want to talk to Claude from Telegram while TeleCode remains the Telegram bot.

Commands:

```text
/claude
hello
```

or:

```text
/claude hello
```

Model selection:

```text
/new claude opus
/model opus
```

Default integrated Claude model:

```text
claude-sonnet-5
```

`/new claude <model>` starts a fresh Claude session with that model. `/model <model>` sends Claude Code's model selection through the active Claude integration. Common values are `fable`, `best`, `claude-fable-5`, `claude-sonnet-5`, `sonnet`, `opus`, `haiku`, and `default`. If Claude Code rejects a model because it is unavailable, blocked by the account or organization, or requires usage credits, TeleCode reports the CLI error instead of saying the model changed.

If `CLAUDE_DEFAULT_MODEL=default` is explicitly set, TeleCode omits `--model` and lets Claude Code choose its local default. Because that local default varies per machine and account, the built-in TeleCode default is explicitly `claude-sonnet-5`.

Runtime rules:

- SDK sessions and model discovery use the executable bundled with the pinned Agent SDK. `CLAUDE_SDK_BIN` overrides it; `CLAUDE_BIN` applies to PTY sessions. SDK children have background auto-updates disabled so a dependency rollout controls their CLI version.
- `ENABLE_CLAUDE_PROVIDER=true` must be set in `.env`.
- `CLAUDE_STRICT_MCP_CONFIG=true` should stay set while using the real `~/.claude` config.
- TeleCode strips inherited `CLAUDECODE` and `CLAUDE_CODE_*` variables before spawning Claude.
- TeleCode strips inherited `CLAUDE_CONFIG_DIR` unless an isolated config is explicitly configured.
- TeleCode scans Claude transcripts by file growth, not just by guessed session ID.
- If a persisted Claude session has no transcript file, TeleCode starts fresh instead of resuming a stale UUID.
- If Claude is working and another normal message arrives, TeleCode queues it as the next Claude turn instead of dropping it.
- If Claude is working and `/steer <instruction>` arrives, TeleCode sends it into the active Claude turn. PTY sessions type the instruction into the running Claude Code TUI; SDK sessions push it through the SDK streaming-input channel. If the turn is still starting and cannot accept live input yet, TeleCode falls back to queueing it as the next Claude follow-up.
- In the foreground, Claude model fallbacks and safeguard refusals are reported before held narration, including the models and reason when supplied. Background status notices and commentary stay buffered for `/replay`.
- If Claude finishes while another provider or Claude session is selected, TeleCode sends the final answer directly with a session header. This also applies to follow-up work from a kept-alive SDK query. Select the session and use `/replay all` to read its interim messages; selecting it alone does not release background commentary.
- SDK idle and running session-state events determine whether a kept-alive Claude query is working. Idle metadata and task progress do not start a new turn.
- Background task snapshots keep SDK queries alive for tools moved into the background by steering. Ambient watchers do not hold them open. Once snapshots arrive, independently ordered task bookends cannot revive finished work.
- Task completion starts a bounded handoff wait until Claude begins its follow-up turn. A running follow-up survives quiet model and tool intervals, subject to the park's hard deadline.
- PTY startup waits for substantial redraws to settle before typing. The SDK bot-flow smoke rejects an automatic SDK fallback during its PTY checks.
- Background reply headers use the current title of the conversation that produced the reply, including native transcript titles and names set with `/rename`. Renaming during a running turn or while output is awaiting delivery keeps the new name. Restoring another Codex thread does not reuse an old conversation's record or title.

Self-test:

`npm run test:provider-compat` runs a live upgrade canary against both providers using temporary workspaces and no Telegram API. It checks Codex initialization, tools, resume, fork, steering, stopping, compaction and MCP server status, plus Claude model discovery, narration, resume, fork, live steering, delayed background answers, stopping and compaction. Set `TELECODE_CANARY_PYTHON` if the bounded shell tests need a different Python executable. Run it serially with the Claude bot-flow smoke tests. For a focused rerun, use `node scripts/provider-compat-smoke.mjs --codex-only`, `--steer-only`, or `--background-only`.

`npm run test:claude-sdk-smoke` verifies PTY to SDK and back with conversation memory preserved. It repeats narration checks after a live `/steer` and separately after background command completion, requiring each narration block and final answer to arrive as a separate mocked Telegram message in order. Its steering stimulus waits for the bounded shell command to write a start marker before sending `/steer`, proving the command is actually running, and requires its finish marker to prove steering preserved the command. Claude may apply the steer at a safe tool boundary instead of answering during the command.

```powershell
npm run test:claude-tool-smoke
```

That test builds TeleCode, spawns Claude through the same provider adapter, makes Claude run a harmless PowerShell command, verifies tool events and final text, then kills the Claude process.

The bot-flow smoke test builds TeleCode, creates a local in-process bot with mocked Telegram sends, simulates `/claude <prompt>`, sends a second normal message to the active Claude session, verifies `/sessions` exposes a useful title, runs `/exit`, verifies the Claude PID registry is empty, starts Claude again and verifies a post-exit reply, then checks `/new claude opus` with a real response. It does not poll Telegram and does not send any real Telegram messages.

Run the live Claude smoke tests serially. They both drive real interactive Claude processes and scan Claude's transcript directory, so running them in parallel can create false failures. The individual smoke scripts also share a lock under `.telecode/locks` to prevent accidental parallel runs from colliding.

2. Standalone Claude Code on the TeleCode repo

Use this when Claude should work directly in a normal interactive terminal session, separate from Telegram.

Safe launcher:

```powershell
scripts\start-claude-telecode.bat
```

Optional arguments:

```powershell
scripts\start-claude-telecode.bat -Model opus -PermissionMode acceptEdits
```

The launcher:

- Starts in the repository root.
- Removes `CLAUDECODE`, `CLAUDE_CODE_*`, and `CLAUDE_CONFIG_DIR` from the environment.
- Uses `--strict-mcp-config`.
- Does not enable the Claude Telegram plugin.

A Claude Code launched with `plugin:telegram@claude-plugins-official` can run at the same time as TeleCode if that plugin uses a different Telegram bot token. It is unsafe only if it uses the same bot token as TeleCode, because Telegram long polling conflicts per bot token.

For TeleCode repo development, prefer `scripts\start-claude-telecode.bat` anyway. It avoids the Telegram plugin entirely, strips inherited Claude/Codex session variables, and is easier to reason about when debugging transcripts.

TeleCode prints a startup notice if it sees a running Claude command line that includes `plugin:telegram`. That notice is informational unless the token is shared.

Operational rule

Only one process should own Telegram polling for the same bot token at a time.

- Normal operation: TeleCode owns Telegram polling. Integrated Claude runs as a child without the Telegram plugin.
- Standalone terminal Claude: no Telegram plugin. It can edit and test files directly.
- Legacy Claude Telegram bridge: can run alongside TeleCode if it uses a different bot token.

Current automated checks

```powershell
npm test
npm run test:claude-tool-smoke
```

`npm test` includes an offline bot-flow replay that verifies `/claude`, then normal text, routes to Claude, and `/claude <text>` runs as an inline Claude prompt without contacting Telegram.
