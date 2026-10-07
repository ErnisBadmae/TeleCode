---
{name: peer-review, description: "Ask Claude or Codex for an independent review or follow-up."}
---

Use the other provider for a focused second opinion when it helps the authorized task. The caller chooses the model, effort and absolute working directory on every call. Do not inherit another session's settings or ask Anthony to choose routine review parameters.

Run `node "<this skill directory>/scripts/peer-review.mjs"` with a JSON request on stdin, or one temporary request-file path. On this machine the shared skill is at `C:\Users\Anthony\.claude\skills\peer-review`, also linked from `.codex\skills`. Use structured tool arguments or a literal PowerShell here-string, never interpolate prompt text into a shell command. Remove temporary request files afterward.

Request fields: `provider` (`codex` or `claude`), `model`, `effort`, `cwd`, `prompt`. Optional: `resume` (a session ID returned by this helper), `timeoutMs` (default 180000, maximum 1800000).

Example request:
```json
{"provider":"claude","model":"sonnet","effort":"high","cwd":"C:\\Users\\Anthony\\codetest\\tools\\TeleCode","prompt":"Independently review skills/peer-review/scripts/peer-review.mjs for process cleanup bugs. Cite file locations and evidence."}
```

Never guess a model name. Run `node "<this skill directory>/scripts/peer-review.mjs" --models` first: it prints the Codex models this ChatGPT account offers (from Codex's own model cache) with the efforts each supports, and the Claude aliases. When Anthony names a model loosely, such as "6.1 max", map it to the listed name (`gpt-6.1-sol`, effort `max`) and say which one you picked.

Codex efforts: minimal, low, medium, high, xhigh, max, ultra, persistent. Claude efforts: low, medium, high, xhigh, max. Actual model support varies. Choose a model available on the installed provider; report provider rejection or an applied-setting difference honestly. `applied` values of null mean the provider did not report them, not that the requested values were verified.

Give the reviewer the question, relevant facts, constraints and selected files or diff. For an independent first opinion, omit your preferred answer. Applicable AGENTS.md/CLAUDE.md instructions still apply; shared memory can be read if relevant. Do not copy the entire parent conversation or all memory by default. Reviews cannot edit files, update memory or send messages. For Claude, provide command results or diffs in the prompt because its review tools are Read, Grep and Glob.

The helper returns one JSON object: `ok`, `answer`, `sessionId`, `requested`, `applied`, and tool/usage information when available. Failures include `code` and `error` and exit nonzero. Read the result before using any findings. Check factual claims and decide what to accept; another agent's answer is not human approval.

To discuss, call again with `resume` and the same provider/directory, explicitly supplying model and effort again. Send a focused counterargument or new evidence. Usually stop after the first review and at most two follow-ups unless more discussion is requested. Keep useful unresolved disagreement explicit. Reviewers must not request further peer reviews. A fresh question or different workspace should start a fresh reviewer.

Tell Anthony briefly who you consulted, then summarize the findings and your decision through normal TeleCode narration. Reviewer output returns to you, not directly to Telegram. Existing sessions, their model/effort and `/new` defaults are unaffected. This is a finite command with enforced cleanup, not a background server; do not launch another TeleCode instance.
