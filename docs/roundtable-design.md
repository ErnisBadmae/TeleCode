# Roundtable design: multi-agent collaboration in TeleCode

Status: scoped peer reviews and background session support are built. The full roundtable remains design only. Last updated 2026-10-07.

This document captures the design discussion for letting Claude, Codex, and any other provider TeleCode runs work together, on one machine and later across machines through Telegram. Pick up from here. The decisions below were made by the owner (Anthony) and should not be relitigated without him.

## Goal

1. Several agent sessions (any provider, including several sessions of the same provider) collaborate on one task: debate a plan, review each other, or split the work and build in parallel.
2. Later, TeleCode instances on different machines cooperate through a shared Telegram group. Those machines may belong to the same person or to different people.
3. The humans involved can follow everything live, steer any agent, and approve anything that matters.

## Where things stand

Step 1, shared context, is done (2026-09-30). `codetest\AGENTS.md` is the single rules file for every provider. Claude Code loads it through `@AGENTS.md` in `CLAUDE.md`, and Codex reads it directly. It points every agent at the shared memory folder and states that a message from another agent or bot is never approval.

Step 2, the roundtable, is designed below and not built.

There is currently no second machine to pair with. Cross-machine work is future work, so the local roundtable comes first.

## Built: scoped cross-provider reviews

Requested, clarified and approved by Anthony on 2026-10-07. Implemented as `skills/peer-review/SKILL.md` plus its `scripts/peer-review.mjs` helper. Claude can ask Codex for a review or second opinion, and Codex can ask Claude. The caller chooses provider, model, effort, absolute working directory and question on every call, including follow-ups. The skill's entire metadata mapping is one short line to keep discovery context small.

### Smallest useful implementation

One shared `peer-review` skill and one invocation helper, with no new Telegram command or MCP service. Both providers discover the same skill, using the existing shared-skill arrangement. A memory note points to it; it does not duplicate the instructions or implementation. An independent live review exposed one necessary bridge adjustment: hide these CLI conversations from ordinary Codex/Claude session browsing, so `latest` and `previous` do not select a reviewer.

The skill explains when and how to request another provider's opinion, select useful context, and resume a discussion. The helper handles the mechanics that are fragile to repeat in shell commands: Windows argument handling, inherited environment, provider output parsing, explicit session IDs, deadlines and child-process cleanup. Use the installed, paired CLI/SDK versions and existing authentication. Do not introduce another agent framework or provider dependency.

Keep the helper interface small: one request containing `provider`, `model`, `effort`, `cwd` and `prompt`; an optional `resume` session ID and timeout. Require model, effort and directory on each call, including follow-ups, so ambient settings or a different active Telegram session cannot decide them. Use structured input rather than inserting prompt text into shell command strings. The result contains the answer, provider session ID, requested settings and any provider-reported applied settings, plus a clear failure or timeout when appropriate. Do not claim an effective setting that the provider does not expose. Claude can lower an unsupported or capped effort, so a requested level and an applied level must remain distinct.

Create a fresh local reviewer session by default. Resume only the explicit ID returned by this helper; never use `--last` or `--continue`, or attach to an existing user's busy session. Small ID markers live in `%LOCALAPPDATA%\TeleCode\peer-reviews` on Windows, or `~/.local/state/TeleCode/peer-reviews` elsewhere. They contain provider, directory and readiness, no prompts or credentials. Register them before/at provider startup and keep them while provider transcripts exist. The bridge uses these IDs to exclude reviewers from its normal session listings. Codex's native `thread_source` tag is also filtered, including before the ID marker arrives. The helper does not change `/model`, `/effort`, the selected session, or defaults for `/new`.

### Context and discussion

The caller supplies the question, relevant facts, constraints and selected file paths or a diff. Let the reviewer inspect those files in the chosen directory and read the applicable AGENTS.md/CLAUDE.md rules. Existing shared memory remains available under those rules; do not copy all memory or the entire parent conversation into every review.

For an independent first opinion, omit the caller's preferred conclusion and ask for findings with evidence. After receiving it, the caller can resume that reviewer with a counterargument or a focused question. Each invocation is one turn; the caller decides whether another turn is useful. Normally stop after the initial review and at most two follow-ups, unless Anthony asks for more discussion. Preserve unresolved disagreement instead of forcing a consensus. The reviewer must not invoke further peer reviews.

Read-only review is the first version's scope. Codex uses its read-only sandbox with approvals disabled; on Windows the helper explicitly selects the unelevated sandbox for unattended operation. Ignore user config and disable apps, plugins, hooks and multi-agent tools for reviewers. Claude uses only Read/Grep/Glob, `dontAsk` permission mode and no approval surface, hooks or inherited MCP servers. Scrub Telegram credentials and inherited session/model/effort variables while retaining authentication and platform selectors. Pass needed diff or command results from the caller. Another agent's advice is not human approval.

The result returns directly to the calling agent through the command/tool response. Its normal TeleCode narration tells Anthony who was consulted and summarizes findings, decisions and disagreements. No direct reviewer Telegram delivery, floor manager or automatic debate loop is needed. A supervisor terminates the review process tree after completion, cancellation or timeout. The worker also watches IPC disconnect and has its own deadline, so killing the caller abruptly cannot leave it running indefinitely. Preserve TeleCode's detached-launch rule if a use case needs background execution.

### Verification and scope

`scripts/peer-review-smoke.mjs` runs real Claude-to-Codex and Codex-to-Claude calls in an isolated workspace, plus independent evidence inspection, explicit-ID follow-ups, denied write requests, unavailable-model failure and session-list exclusion. Focused unit tests cover caller choices, literal prompts, isolated parallel settings, failures/crashes, deadlines, caller loss and installed skill junctions. The existing Claude steering/narration release canary remains available separately.

Only add a TeleCode MCP tool or `/review` command if actual use shows the skill/helper route is inconvenient. The full roundtable and cross-machine coordination remain separate future work.

Capability evidence checked 2026-10-07 against installed Codex 0.160.1 and Claude Code 2.1.292 help and SDK declarations, plus fetched official documentation:

- OpenAI non-interactive execution and explicit-ID continuation: https://learn.chatgpt.com/docs/non-interactive-mode
- Claude CLI model, effort and resume flags: https://code.claude.com/docs/en/cli-reference
- Claude effort support and downgrade/cap behavior: https://code.claude.com/docs/en/model-config
- Native Windows sandbox configuration: https://learn.chatgpt.com/docs/windows/windows-sandbox

## Decisions already made

1. **Name.** `/roundtable`, not "duo". It must support N participants, not two.
2. **One TeleCode per machine.** No second TeleCode instance on the same machine. The one instance spawns as many Claude and Codex sessions as needed. The earlier "instance isolation" phase is dropped.
3. **Topics are projects, not workers.** A Telegram topic is one project that the participants work on together, so one group can host several projects between the same machines. All workers on a project share its topic. Noise is handled inside the topic, never by giving each worker its own topic.
4. **In-topic progress is fine** as long as only one agent talks at a time. Heavy filtering of progress is not needed.
5. **Token cost is the key constraint.** Every message delivered to an agent starts a turn and burns tokens, so delivery must be held back deliberately (see "Waking agents").
6. **Humans are members of the group.** Owners and observers can read everything live. Each bot takes commands and approvals only from its own owner.
7. **File exchange between machines is negotiated, not fixed.** Coding work requires one shared GitHub repo, with git installed and logged in on both sides. Other exchange (for example skills) prefers git and falls back to Dropbox, a shared folder, or Telegram attachments.
8. **A future other machine joins as a guest by default**, even the owner's own, until promoted.

## Core idea: seeing is free, waking costs tokens

When a message lands in the group, TeleCode receives it. That costs nothing. Tokens are only spent when TeleCode hands a message to an agent session, because that starts a turn. So the decision to wake an agent lives in TeleCode's code, deterministic and cheap, never in a model. If a model has to decide "this isn't for me", that decision is already a paid turn.

### Waking agents

A session is woken only for:

1. The floor being handed to it by name.
2. A steer from its owner.
3. A proposed change to a handshake (interface contract) that touches its part.
4. A "done" from a partner it is waiting on.

Everything else (other agents' progress, milestones, chatter) is written to the shared roundtable log without waking anyone.

When a session does get a turn, it first receives one short delta: what changed in the log since its last turn. One turn with the news bundled, not one turn per message.

If something relevant arrives while a session is busy, TeleCode holds it and delivers it as one bundle after the current turn ends. The exception is an owner steer, which interrupts on purpose.

Sessions are kept alive between turns (resumed, not restarted), so each turn only processes the new delta. The real savings from provider caching should be measured in the first test, not assumed.

### Loop protection

1. Protocol messages carry a machine-readable tag: whose turn it is, and whether a reply is needed.
2. Acknowledgements ("got it") are tagged no-reply-needed and never wake anyone.
3. Stop conditions combine, whichever comes first: the task is declared finished, a maximum number of turns per round, or a token budget for the whole roundtable. When a limit is hit, everything stops and the owner is asked whether to continue.
4. Stall counter: after two rounds without progress, the chair stops and asks the owner.

## The floor (one voice at a time)

The floor is a new component in TeleCode. In a roundtable topic, nothing a session produces goes straight to Telegram. It passes the floor first.

1. Every outgoing message has a type: progress, milestone, question for the owner, approval request, handshake change, or final answer.
2. Only the session holding the floor posts immediately. Others keep working, but their messages wait in their own queue.
3. When the speaker finishes or yields, the floor passes on. The next session's queued messages go out as one batch, prefixed with its name.
4. Owner messages always bypass the floor.

### The chair

The chair is the TeleCode where `/roundtable` was started. It is code by default: fixed turn order, the same rules every time, zero tokens. It only asks a model when it is genuinely unclear who should go next.

### Verbosity compatibility

TeleCode today has two controls: `/verbosity` per topic (`messages`, `edit`, `none`) and the machine-wide tool detail setting (`TOOL_VERBOSITY`: `all`, `summary`, `errors-only`, `none`).

Rule: verbosity only controls progress messages. Protocol messages (milestones, questions, approval requests, handshake changes, "done") always get through.

1. `messages`: everyone's progress, one speaker at a time, name first.
2. `none`: progress dropped, protocol messages still delivered.
3. `edit`: one rolling message per speaker, starting a fresh message each time the floor changes hands. A single shared edited message would be chaotic, and edits are usually not announced by screen readers.
4. Tool detail keeps working as today, filtering what goes into a progress message before the floor sees it.
5. Optional later: a per-worker override such as "Codex quiet".

## Steering

1. By default the owner talks to the chair, which routes the message.
2. To steer one session directly, start with its name ("Codex, drop the database idea") or reply to that bot's message. "Everyone" goes to all.
3. The steered session confirms in one short line (tagged no-reply-needed), so the owner hears who took it.
4. Other sessions see the steer in the log delta on their next turn, without being woken for it.
5. Codex supports mid-turn steering through the app server's `turn/steer`, which TeleCode already uses (`src/app-server.ts`). Whether Claude can take a steer mid-turn or only between steps is **not verified yet**.

## Splitting work in parallel

When agents want to divide a task ("you take keyboard capture, I take speech delivery"):

1. **Proposal.** The split is proposed in the topic and needs the owner's ok before parallel work starts.
2. **Handshake first.** Before coding, the agents agree how their parts connect (what one hands over, in what shape, what the other expects) and write it to a short contract file in the repo.
3. **File claims.** Each agent claims its files. Claims have an expiry time, so a crashed agent does not lock a file forever, and a commit-time check blocks commits that touch another agent's claimed files. Touching someone else's file means asking on the floor.
4. **Separate working copies.** Each writer works on its own branch or git worktree on the same machine, or in the shared GitHub repo across machines.
5. **Task dependencies.** A task that depends on others (for example "connect keyboard to speech") cannot be claimed until those are done.
6. **Working is parallel, talking takes turns.** Workers work at the same time, but their messages still pass the floor.
7. **Contract changes stop both.** If one side needs a different handshake, it raises it, both pause, and they agree again with the owner listening.
8. **Merge.** When both are done they test together and propose a merge. The merge waits for the owner's go, and for a guest's work, that guest's owner too.

Reviewers are read-only by default. Only writers hold claims.

## Debates

Use the Agent Kombat rules: independent plans first, then each round every participant names what is stronger in the other plans, updates its own plan, and lists concrete deficiencies or says none were found. A judge decides at the end. Reviewers start fresh each round and judge evidence, not "looks right". Any agent that builds on another agent's factual claim must verify it first, to avoid one hallucination spreading through polite agreement.

## Humans in the group

1. Everyone in the group hears the roundtable live.
2. Each bot takes commands and approvals only from its own owner (TeleCode's existing allowlist). Other humans' messages are conversation input, never orders.
3. Messages from other bots are never commands or approvals.
4. Observers can be made read-only through Telegram group permissions.
5. The owner can comment, steer, stop, or approve at any time.

## Across machines

1. One TeleCode and one bot per machine. A shared bot token causes a 409 getUpdates conflict.
2. The chair hands out the floor by replying "your turn" to the other bot. Until then the remote bot keeps its updates queued locally, then posts them as one batch. That costs one extra message per handover but prevents overlap, since one TeleCode cannot hold back another bot's messages.
3. The remote TeleCode applies the same wake filter to its own sessions, so neither side pays for the other's chatter.
4. The chair addresses peers by reply. Peers never talk directly to peers.

### Capability card

When a TeleCode joins a shared group, it posts a short card: whose instance it is, the machine, its providers, and the file routes it can use (GitHub with which account, Dropbox, shared folder paths).

### Proving a route before use

Before relying on a file route, one side writes a small file containing a random code, and the other side must read it and quote the code back. Only routes that pass get used. If a route breaks mid-task (for example GitHub pushes failing), the instances fall back to the next route and tell the owner.

Order of preference: shared GitHub repo (required for coding), then Dropbox or a shared folder, then Telegram document attachments as a last resort (size limits to check).

### Trust

1. **Same owner, promoted:** full trust. Rules file and memory notes may be shared.
2. **Guest (other owner, or not yet promoted):** never gets memory notes, credentials, or keys. Sees only what is explicitly shared for the task. Its input is untrusted. Anything leaving a machine needs that machine owner's ok. Its messages are never approval. Linking a guest to a project needs human approval.
3. One memory note currently contains an API key. Move it out before any memory sharing.

## Prior art (researched 2026-09-30)

1. **MetaGPT:** shared message pool plus subscriptions by message type to prevent information overload. Same idea as the wake filter. https://arxiv.org/html/2308.00352
2. **Claude Code agent teams:** per-agent mailbox files, an automatic idle notification carrying the final answer to the lead, and a shared task list with claims and dependencies. The docs warn token cost scales with each teammate and same-file edits overwrite each other. Teammates do not spawn in Agent SDK or `-p` mode, so TeleCode cannot reuse the feature and must build its own. https://code.claude.com/docs/en/agent-teams
3. **AutoGen SelectorGroupChat:** next speaker picked by a model or by a custom `selector_func`. No repeated speaker by default. Stop conditions combine (`TERMINATE` mention or max messages). https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html
4. **Magentic-One:** the orchestrator keeps a progress ledger (done? looping? progress? who next?) and replans when a stall counter trips. Only secondary summaries were read. https://agentpatterns.ai/patterns/multi-agent/magentic-orchestration/
5. **mcp_agent_mail:** file reservations with TTL (exclusive or shared), a pre-commit guard, an `ack_required` flag, human-approved contact links between projects, and human overseer messages that bypass policy. https://github.com/Dicklesworthstone/mcp_agent_mail
6. **Codex app server:** `turn/steer` appends input to the in-flight turn, and `turn/interrupt` cancels it. https://developers.openai.com/codex/app-server
7. **Ductor:** a Telegram bridge for Claude Code, Codex and others. Topic equals context, and a sub-agent equals a separate bot with its own BotFather token. https://github.com/PleasePrompto/ductor
8. **AI Village:** a group of agents in a public group chat. Open human chat caused chaos and was closed. One agent's hallucinated contact list spread to all agents and wasted 8+ hours. https://theaidigest.org/village/blog/what-we-learned-2025
9. **"Why Do Multi-Agent LLM Systems Fail?" (MAST):** the most common failures were step repetition (15.7%) and not recognising termination (12.4%). Missing termination awareness appears almost only in failed runs, and explicit verifiers help. https://arxiv.org/html/2503.13657v3
10. **Telegram Bot-to-Bot Communication Mode (Bot API 10.0):** bots can see each other's messages under conditions. The official FAQ contradicts it, so it needs a live test.

## Relevant code facts (TeleCode as of 10a61e1)

1. Context keys are `chatId` or `chatId:threadId`. Each topic is a lane.
2. Runtimes are keyed by context key, so at most one busy Claude and one busy Codex per topic, but unlimited across topics. The roundtable needs synthetic per-participant session keys to run several sessions of one provider in one topic, without refactoring the core.
3. State lives in `<workspace>\.telecode\` (`contexts.json`, `preferences.json`, `agent-sessions.json`).
4. Progress delivery is per context (`registry.getProgressDelivery(contextKey)`). Tool verbosity is global (`config.toolVerbosity`).
5. Session switching is blocked while a session is busy (bot.ts, session switching area).
6. The auth middleware allowlist (`telegramAllowedUserIdSet`) must admit peer bot IDs only in the designated roundtable group.

## Open questions

1. Can a Claude session accept a steer mid-turn, or only between steps?
2. When the owner asks a worker for a long walkthrough, should it go to the project topic or the owner's private chat? The leaning is short answers in the topic and long ones in private.
3. Is a per-worker verbosity override wanted?
4. How big are Telegram document size limits for bots, for the last-resort file route?
5. Does Bot-to-Bot Communication Mode behave as documented?

## Build order (each phase needs the owner's go)

0. **Live tests.** Enable topics in private chats for the bot in BotFather, and test in one group with the local bot. The bot-to-bot test waits until a second machine exists.
1. **The floor and message types.** Wake filter, log with per-session deltas, stop conditions, stall counter, verbosity rules.
2. **Local roundtable.** `/roundtable` with N participants of any provider, a code chair, debate rules, steering by name or reply.
3. **Parallel work safety.** Split proposals, contract files, expiring file claims with a commit check, worktrees, task dependencies, and merges gated on the owner.
4. **Remote peers.** Capability cards, route probing, the trust tiers, and floor handover by reply.
