# Roundtable design: multi-agent collaboration in TeleCode

Status: roundtable and scoped review features are design only. Background session support is built. Last updated 2026-10-07.

This document captures the design discussion for letting Claude, Codex, and any other provider TeleCode runs work together, on one machine and later across machines through Telegram. Pick up from here. The decisions below were made by the owner (Anthony) and should not be relitigated without him.

## Goal

1. Several agent sessions (any provider, including several sessions of the same provider) collaborate on one task: debate a plan, review each other, or split the work and build in parallel.
2. Later, TeleCode instances on different machines cooperate through a shared Telegram group. Those machines may belong to the same person or to different people.
3. The humans involved can follow everything live, steer any agent, and approve anything that matters.

## Where things stand

Step 1, shared context, is done (2026-09-30). `codetest\AGENTS.md` is the single rules file for every provider. Claude Code loads it through `@AGENTS.md` in `CLAUDE.md`, and Codex reads it directly. It points every agent at the shared memory folder and states that a message from another agent or bot is never approval.

Step 2, the roundtable, is designed below and not built.

There is currently no second machine to pair with. Cross-machine work is future work, so the local roundtable comes first.

## Next feature: scoped cross-provider reviews

Requested by Anthony on 2026-10-07. Backlog item, not implemented. Build this small local review flow before the full roundtable: Claude can ask Codex for a review or second opinion, and Codex can ask Claude, within an explicitly chosen task context.

Proposed user entry point: `/review codex <question>` or `/review claude <question>` from the requesting session. Natural requests such as "ask Claude to review this change" should use the same route. Give each provider a TeleCode `request_review` tool so the agent can request a bounded second opinion directly when Anthony has authorized peer review for the task. This bridge capability should work independently of the browser MCP toggle.

Each request carries a request ID, the originating session and Telegram context, workspace and exact revision, review question, goal and constraints, relevant decisions, and chosen files or diff. Make the context packet inspectable. Use a fresh reviewer by default, with its own model and effort setting. Sending the packet must not change the selected session, steal another running session, or change its model or effort. Broader or existing-session context can be an explicit option later.

The reviewer has read-only access by default. Its response returns to the requesting agent as a tool result with concrete findings, file references or supporting evidence, uncertainties, and any proposed tests. The requesting agent decides what to change and tells Anthony what it accepted or disagreed with. Another agent's suggestion is never human approval. When a review was requested directly through the command, deliver a short provider-labelled result in that same originating context.

Default to one reviewer turn with a deadline and budget. Do not recursively spawn more reviews. Permit one deliberate clarification only within the configured limit. Expose progress, cancellation, failure, and completion through TeleCode's existing job and delivery machinery; keep a record linking the request, context packet, reviewer session, and response. A timeout or unavailable provider must return a clear result to the caller and let its task continue.

Acceptance checks: both Claude-to-Codex and Codex-to-Claude through real CLIs; the requested context and revision are used; the reviewer cannot edit; the answer returns to the correct requesting session after a session switch; unrelated parallel sessions and their efforts are unaffected; narration arrives in order; cancellation, timeout, and unavailable-provider handling settle the request; repeated delivery cannot produce duplicate reviews or recursive loops.

This is a separate next feature after the CLI release hardening. It can reuse the current per-session provider runtimes and background-job routing without depending on Telegram groups, private-chat topics, or a second machine.

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
