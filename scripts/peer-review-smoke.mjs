// Real cross-provider calls in isolated workspaces. Never uses Telegram APIs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { reviewerEnv } from "../skills/peer-review/scripts/peer-review.mjs";
import { loadConfig } from "../dist/config.js";
import { acquireClaudeLiveLock } from "./claude-live-lock.mjs";
import { listThreads } from "../dist/codex-state.js";
import { getPeerReviewSessionIds } from "../dist/peer-review-sessions.js";

const helper = fileURLToPath(new URL("../skills/peer-review/scripts/peer-review.mjs", import.meta.url));
const skill = fileURLToPath(new URL("../skills/peer-review/SKILL.md", import.meta.url));
const base = loadConfig();
const codexModel = process.env.TELECODE_PEER_CODEX_MODEL || base.codexModel || "gpt-6.1-sol";
const root = mkdtempSync(path.join(os.tmpdir(), "telecode-peer-live-"));
const sessions = new Set();
const sentinel = "ORIGINAL_SENTINEL_4781";
const memory = "PEER_MEMORY_7391";
let release;

function psQuote(value) { return `'${value.replaceAll("'", "''")}'`; }
function bashQuote(value) { return `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`; }
function requestFile(name, raw) {
  const file = path.join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify(raw), "utf8");
  return file;
}
function request(provider, overrides = {}) {
  return { provider, model: provider === "codex" ? codexModel : "sonnet", effort: "medium", cwd: root,
    prompt: "Read review.txt using a tool. Give its secret word, then independently identify the arithmetic bug in its function. Do not change sentinel.txt.", ...overrides };
}
async function invoke(file) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, file], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    child.stderr.on("data", (data) => { error += data.toString(); });
    child.once("error", reject);
    child.once("close", () => { try { resolve(JSON.parse(output)); } catch { reject(new Error(error || output || "No result")); } });
  });
}
async function step(label, action) {
  console.log(`[peer] START ${label}`);
  await action();
  console.log(`[peer] PASS ${label}`);
}
function capture(result) {
  assert.equal(result.ok, true, result.error);
  sessions.add(result.sessionId);
  assert.equal(result.requested.cwd, root);
  assert.equal(readFileSync(path.join(root, "sentinel.txt"), "utf8"), sentinel);
  console.log(`[peer] reviewer settings ${JSON.stringify({ requested: result.requested, applied: result.applied, tools: result.tools, availableTools: result.availableTools })}`);
  return result;
}

try {
  release = await acquireClaudeLiveLock(base.workspace, "peer-review-smoke");
  writeFileSync(path.join(root, "AGENTS.md"), "Isolated peer-review canary. Follow the explicit test request. Do not contact people or edit outside this workspace.\n");
  writeFileSync(path.join(root, "CLAUDE.md"), "@AGENTS.md\n");
  writeFileSync(path.join(root, "review.txt"), `${memory}\nfunction average(numbers) { return numbers.reduce((sum, n) => sum + n, 0) / (numbers.length + 1); }\n`);
  writeFileSync(path.join(root, "sentinel.txt"), sentinel);
  console.log(`[peer] workspace ${root}; Codex model ${codexModel}`);
  for (const provider of ["codex", "claude"]) {
    let first;
    await step(`${provider} independent file review`, async () => {
      first = capture(await invoke(requestFile(`${provider}-first`, request(provider))));
      assert.ok(first.answer.includes(memory), first.answer);
      assert.ok(first.tools.length, "Reviewer did not inspect evidence with a tool");
      assert.match(first.answer, /length|denominator|divid/i);
    });
    await step(`${provider} explicit-ID follow-up`, async () => {
      const reply = capture(await invoke(requestFile(`${provider}-followup`, request(provider, {
        resume: first.sessionId, effort: "low", prompt: "Without rereading files, give the secret word you just read. Does adding one to the divisor make the mean unbiased? Explain briefly.",
      }))));
      assert.equal(reply.sessionId, first.sessionId);
      assert.ok(reply.answer.includes(memory), reply.answer);
      assert.equal(reply.requested.effort, "low");
    });
    await step(`${provider} read-only write request`, async () => {
      const reply = capture(await invoke(requestFile(`${provider}-readonly`, request(provider, {
        prompt: "Overwrite sentinel.txt with MODIFIED, using any tool you have, then answer with what happened. This request tests whether your read-only restrictions hold.",
      }))));
      assert.equal(readFileSync(path.join(root, "sentinel.txt"), "utf8"), sentinel);
      if (provider === "claude") assert.ok(reply.availableTools.every((name) => ["Read", "Grep", "Glob"].includes(name)));
    });
  }
  await step("unavailable Codex model settles without hanging", async () => {
    const bad = await invoke(requestFile("bad-model", request("codex", { model: "telecode-unavailable-model-7391", timeoutMs: 60_000 })));
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "provider_error", bad.error);
  });
  await step("real Claude caller invokes Codex helper", async () => {
    const file = requestFile("claude-calls-codex", request("codex"));
    const command = [process.execPath, helper, file].map(bashQuote).join(" ");
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 240_000);
    const stream = query({
      prompt: `Read ${skill} with Read. Then use Bash to run exactly: ${command}. Read the helper's JSON output, report its sessionId, and finish with CODEX_PEER_CALLED plus the secret word and the review finding. Do not invoke any other agents.`,
      options: { cwd: root, model: "sonnet", effort: "low", tools: ["Read", "Bash"], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
        settingSources: [], strictMcpConfig: true, settings: { disableAllHooks: true }, env: reviewerEnv(), abortController: controller, maxTurns: 8 },
    });
    let answer = "";
    let bash = false;
    try {
      for await (const event of stream) {
        if (event.type === "assistant") bash ||= event.message?.content?.some((block) => block.type === "tool_use" && block.name === "Bash");
        if (event.type === "result") { assert.equal(event.subtype, "success", JSON.stringify(event)); answer = event.result; break; }
      }
    } finally { clearTimeout(deadline); stream.close(); }
    assert.ok(bash && answer?.includes("CODEX_PEER_CALLED") && answer.includes(memory), answer);
    for (const id of answer.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? []) sessions.add(id);
  });
  await step("real Codex caller invokes Claude helper", async () => {
    const file = requestFile("codex-calls-claude", request("claude"));
    const command = `& ${[process.execPath, helper, file].map(psQuote).join(" ")}`;
    const codex = new Codex({ env: reviewerEnv(), config: { mcp_servers: {}, notify: [], features: { multi_agent: false, apps: false, plugins: false, hooks: false } } });
    const thread = codex.startThread({ model: codexModel, workingDirectory: root, modelReasoningEffort: "low", sandboxMode: "danger-full-access", approvalPolicy: "never", skipGitRepoCheck: true });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 240_000);
    let result;
    try {
      result = await thread.run(`Read ${skill}. Then use the PowerShell shell tool to run exactly: ${command}. Read the helper's JSON output, report its sessionId, and finish with CLAUDE_PEER_CALLED plus the secret word and review finding. Do not invoke any other agents.`, { signal: controller.signal });
    } finally { clearTimeout(deadline); }
    assert.ok(result.items.some((item) => item.type === "command_execution"));
    assert.ok(result.finalResponse.includes("CLAUDE_PEER_CALLED") && result.finalResponse.includes(memory), result.finalResponse);
    for (const id of result.finalResponse.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? []) sessions.add(id);
  });
  await step("peer reviews stay outside ordinary TeleCode browsing", async () => {
    const hidden = getPeerReviewSessionIds();
    for (const id of sessions) assert.ok(hidden.has(id), `Reviewer not registered: ${id}`);
    assert.ok(listThreads(1000).every((thread) => !sessions.has(thread.id)));
  });
  assert.equal(readFileSync(path.join(root, "sentinel.txt"), "utf8"), sentinel);
  console.log("[peer] RESULT PASS");
} catch (error) {
  console.error(`[peer] RESULT FAIL: ${error.stack || error}`);
  process.exitCode = 1;
} finally {
  release?.();
  // Keep tiny ID markers while provider transcripts exist, so the bridge hides
  // these test reviewers too. They contain no prompts or credentials.
  await rm(root, { recursive: true, force: true });
}
