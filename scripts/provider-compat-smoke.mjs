// Live upgrade canary. Uses temporary workspaces, real providers, and no Telegram API.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppServerSessionService } from "../dist/app-server-session.js";
import { CodexAppServerClient, probeCodexAppServer } from "../dist/app-server.js";
import { loadConfig } from "../dist/config.js";
import { createDefaultLaunchProfile } from "../dist/codex-launch.js";
import { listConfiguredCodexMcpServers, setCodexMcpEnabled } from "../dist/codex-mcp-toggle.js";
import {
  ClaudeSdkInputController, probeClaudeModels, runClaudeSdkCompact, runClaudeSdkTurn,
} from "../dist/providers/claude-sdk-engine.js";
import { acquireClaudeLiveLock } from "./claude-live-lock.mjs";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

const base = loadConfig();
const backgroundOnly = process.argv.includes("--background-only");
const codexOnly = process.argv.includes("--codex-only");
const steerOnly = process.argv.includes("--steer-only");
assert.ok([backgroundOnly, codexOnly, steerOnly].filter(Boolean).length <= 1, "Choose at most one focused mode");
const expectedCodexVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["@openai/codex-sdk"];
const workspace = mkdtempSync(path.join(tmpdir(), "telecode-provider-compat-"));
const profile = createDefaultLaunchProfile("danger-full-access", "never");
const config = {
  ...base, workspace, claudeWorkspace: workspace, claudeDefaultModel: "sonnet",
  launchProfiles: [profile], defaultLaunchProfileId: profile.id,
  codexSandboxMode: "danger-full-access", codexApprovalPolicy: "never",
};
const clients = [];
const closing = [];
const parks = new Set();
const controllers = new Set();
const threads = new Set();
const notifications = [];
const serviceOptions = {
  appServerClientFactory: (options) => {
    const client = new CodexAppServerClient(options);
    client.onNotification((notification) => notifications.push(notification));
    const close = client.close.bind(client);
    client.close = () => { const promise = close(); closing.push(promise); return promise; };
    clients.push(client);
    return client;
  },
};
let service;
let releaseLock;
const watchdog = setTimeout(() => {
  console.error("[compat] FAIL: overall 12-minute deadline");
  for (const park of parks) park.close();
  for (const controller of controllers) controller.abort();
  service?.dispose();
  for (const client of clients) void client.close();
  setTimeout(() => process.exit(1), 2000);
}, 12 * 60_000);
watchdog.unref();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await sleep(100);
  }
}
async function step(label, fn) {
  console.log(`[compat] START ${label}`);
  await fn();
  console.log(`[compat] PASS ${label}`);
}
function startCodex(text) {
  const state = { text: "", tools: 0 };
  state.done = service.prompt({ text }, {
    onTextDelta: (delta, meta) => { if (meta?.phase !== "commentary") state.text += delta; },
    onToolStart: () => { state.tools++; }, onToolUpdate: () => { }, onToolEnd: () => { },
    onAgentEnd: (final) => { if (final) state.text = final; },
  });
  // Attach immediately: interrupted prompts may reject before the test awaits them.
  state.done.catch(() => { });
  return state;
}
async function codexReply(text, marker) {
  const state = startCodex(text);
  await state.done;
  assert.ok(state.text.includes(marker), `Expected ${marker}; got ${state.text}`);
  return state;
}
const claudeOptions = {
  sessionId: "compat-claude", jobId: "compat-job", cwd: workspace,
  claudeBin: config.claudeSdkBin, model: "sonnet", permissionMode: "bypassPermissions",
  ...(process.argv.includes("--trace-sdk") ? {
    queryFn: (input) => {
      const raw = sdkQuery(input);
      return {
        async *[Symbol.asyncIterator]() {
          for await (const message of raw) {
            console.log("[compat] SDK", JSON.stringify({
              type: message.type, subtype: message.subtype, state: message.state,
              tasks: message.tasks, task_id: message.task_id, result: message.result,
              toolResults: message.type === "user" ? message.message?.content?.filter((b) => b.type === "tool_result").map((b) => String(b.content).slice(-600)) : undefined,
              text: message.type === "assistant" ? message.message?.content?.filter((b) => b.type === "text").map((b) => b.text).join(" ") : undefined,
            }));
            yield message;
          }
        },
        close: () => raw.close(),
      };
    },
  } : {}),
};
async function claudeTurn(promptText, overrides = {}, onEvent = () => { }) {
  const events = [];
  const abortController = overrides.abortController ?? new AbortController();
  controllers.add(abortController);
  let providerSessionId = overrides.resume;
  for await (const event of runClaudeSdkTurn({
    ...claudeOptions, promptText, ...overrides, abortController,
    onProviderSessionId: (id) => { providerSessionId = id; },
  })) {
    events.push(event); onEvent(event);
    if (event.type === "error" && !abortController.signal.aborted) throw new Error(event.message);
  }
  return { providerSessionId, events, text: events.findLast((e) => e.type === "assistant_message_complete")?.text ?? "" };
}
const python = process.env.TELECODE_CANARY_PYTHON
  ?? (process.platform === "win32" ? path.join(base.workspace, "venv", "Scripts", "python.exe") : "python3");
const shellCommand = (seconds, marker, powershell = false) => `${powershell && process.platform === "win32" ? "& " : ""}"${python.replaceAll("\\", "/")}" -c "import time; time.sleep(${seconds}); print('${marker}')"`;

try {
  writeFileSync(path.join(workspace, "AGENTS.md"), "This is an isolated compatibility test. Follow the test prompt. Do not send messages or edit external files.\n");
  writeFileSync(path.join(workspace, "canary.txt"), "COMPAT_MEMORY_7391\n");
  console.log(`[compat] workspace ${workspace}`);
  if (!backgroundOnly && !steerOnly) {
    await step("Codex initialization, model catalog and history", async () => {
      const result = await probeCodexAppServer(config);
      assert.equal(result.ok, true, result.error);
      assert.ok(result.userAgent.includes(`/${expectedCodexVersion} `), result.userAgent);
      assert.ok(result.modelCount > 0);
      console.log(`[compat] Codex ${result.userAgent}`);
    });
    await step("Codex tool execution and first turn", async () => {
      service = await AppServerSessionService.create(config, serviceOptions);
      threads.add(service.getInfo().threadId);
      const state = await codexReply("Read canary.txt using a tool. Remember its word. Reply with exactly that word.", "COMPAT_MEMORY_7391");
      assert.ok(state.tools > 0);
      assert.equal(await service.getThreadGoal(), null);
    });
    const originalThread = service.getInfo().threadId;
    await step("Codex resume after process teardown", async () => {
      service.dispose(); await Promise.allSettled(closing);
      service = await AppServerSessionService.create(config, { ...serviceOptions, resumeThreadId: originalThread });
      await codexReply("What word did you read from canary.txt? Do not reread it. Reply with just the word.", "COMPAT_MEMORY_7391");
    });
    await step("Codex fork and model setting", async () => {
      const fork = await service.forkThread();
      assert.notEqual(fork.threadId, originalThread); threads.add(fork.threadId);
      service.setModel(config.codexModel);
      await codexReply("What is the remembered word? Reply with just it.", "COMPAT_MEMORY_7391");
    });
    await step("Codex steering during a shell tool", async () => {
      const state = startCodex(`Use a shell tool to run this bounded command: ${shellCommand(6, "COMPAT_CODEX_SHELL", true)}. Then reply ORIGINAL_REPLY.`);
      await waitFor(() => state.tools > 0, "Codex tool start");
      await service.steer({ text: "After the command finishes, reply with exactly CODEX_STEER_OK instead." });
      await state.done; assert.ok(state.text.includes("CODEX_STEER_OK"), state.text);
    });
    await step("Codex stop and subsequent recovery", async () => {
      const state = startCodex(`Run this bounded shell command: ${shellCommand(25, "COMPAT_CODEX_STOP", true)}. Then reply COMMAND_FINISHED.`);
      await waitFor(() => state.tools > 0, "Codex stop tool start");
      await service.abort(); await Promise.allSettled([state.done]);
      assert.equal(service.isProcessing(), false);
      await codexReply("Reply with exactly CODEX_AFTER_STOP.", "CODEX_AFTER_STOP");
    });
    await step("Codex compaction retains session continuity", async () => {
      const offset = notifications.length;
      await service.compactThread();
      await waitFor(() => notifications.slice(offset).some((n) =>
        n.method === "thread/compacted" ||
        (n.method === "item/completed" && n.params?.item?.type === "contextCompaction")), "Codex compaction", 120_000);
      await codexReply("What word did you read from canary.txt? Do not reread it. Reply with just it.", "COMPAT_MEMORY_7391");
    });
    service.dispose(); await Promise.allSettled(closing);
    await step("Codex initialization with configured MCP servers enabled", async () => {
      setCodexMcpEnabled(true);
      const client = new CodexAppServerClient({ cwd: workspace });
      try {
        await client.start(); await client.initialize(); client.notifyInitialized();
        const status = await client.request("mcpServerStatus/list", { limit: 100 });
        assert.ok(Array.isArray(status.data));
        const expected = listConfiguredCodexMcpServers();
        for (const name of expected) assert.ok(status.data.some((server) => server.name === name), `Missing MCP server ${name}`);
        console.log(`[compat] MCP status lists ${status.data.length} servers`);
      } finally { await client.close(); setCodexMcpEnabled(false); }
    });
  }
  if (!codexOnly) {
    releaseLock = await acquireClaudeLiveLock(base.workspace, "provider-compat-smoke");
    let claudeSession;
    if (!backgroundOnly && !steerOnly) {
      await step("Claude bundled CLI model discovery", async () => {
        const models = await probeClaudeModels({ cwd: workspace, claudeBin: config.claudeSdkBin });
        assert.ok(models.length > 0);
      });
      await step("Claude tools and interim/final narration", async () => {
        const result = await claudeTurn("Say CLAUDE_INTERIM before using a tool to read canary.txt. Remember its word. Then reply with exactly CLAUDE_READ_OK.");
        claudeSession = result.providerSessionId; assert.ok(claudeSession);
        assert.ok(result.text.includes("CLAUDE_READ_OK"), result.text);
        assert.ok(result.events.some((e) => e.type === "tool_started"));
        assert.ok(result.events.some((e) => e.type === "assistant_text_delta" && e.text.includes("CLAUDE_INTERIM")));
      });
      await step("Claude resume and fork", async () => {
        const resumed = await claudeTurn("What word did you read? Do not reread it. Reply with just the word.", { resume: claudeSession });
        assert.ok(resumed.text.includes("COMPAT_MEMORY_7391"), resumed.text);
        const forked = await claudeTurn("What is the remembered word? Reply with just it.", { resume: claudeSession, forkSession: true });
        assert.notEqual(forked.providerSessionId, claudeSession);
        assert.ok(forked.text.includes("COMPAT_MEMORY_7391"), forked.text);
      });
    }
    if (!backgroundOnly) {
      await step("Claude live steering preserves running tool completion", async () => {
        const inputController = new ClaudeSdkInputController();
        const parkedEvents = [];
        let handle;
        const startedFile = path.join(workspace, "steer-started.txt");
        const command = `"${python.replaceAll("\\", "/")}" -c "from pathlib import Path; p=Path('${startedFile.replaceAll("\\", "/")}'); p.write_text('running'); import time; time.sleep(12); p.write_text('finished'); print('COMPAT_STEER_TOOL_DONE')"`;
        const pending = claudeTurn(
          `Use Bash in the foreground to run exactly: ${command}. Then reply ORIGINAL_REPLY.`,
          {
            inputController, parkIdleMs: 500, parkHardCapMs: 90_000,
            onParkedEvent: (event) => parkedEvents.push(event),
            onParkStateChanged: (parked, query) => { if (parked) { handle = query; parks.add(query); } },
          },
        );
        pending.catch(() => { });
        await waitFor(() => existsSync(startedFile), "Claude foreground command actually running");
        console.log("[compat] steering a running command", new Date().toISOString());
        inputController.push("Keep the running command alive until it finishes. Reply with exactly STEER_TOOL_COMPLETE instead of ORIGINAL_REPLY.", "now");
        const result = await pending;
        if (!result.text.includes("STEER_TOOL_COMPLETE")) {
          await waitFor(() => parkedEvents.some((e) => e.type === "assistant_message_complete" && e.text.includes("STEER_TOOL_COMPLETE")), "Claude steered tool completion");
        }
        assert.equal(readFileSync(startedFile, "utf8"), "finished");
        handle?.close();
      });
    }
    if (!steerOnly) {
      await step("Claude parked query receives delayed background completion", async () => {
        const parkedEvents = [];
        let handle;
        const result = await claudeTurn(
          `Use Bash with run_in_background:true to run this exact bounded command: ${shellCommand(8, "COMPAT_BG_DONE")}. Reply CLAUDE_BG_STARTED immediately. When the task finishes, reply with exactly CLAUDE_BG_COMPLETE.`,
          {
            inputController: new ClaudeSdkInputController(), parkIdleMs: 500, parkHardCapMs: 90_000,
            onParkedEvent: (event) => { parkedEvents.push(event); console.log("[compat] parked", event.type, event.text ?? ""); },
            onParkStateChanged: (parked, query) => { if (parked) { handle = query; parks.add(query); } },
          },
        );
        assert.ok(result.text.includes("CLAUDE_BG_STARTED"), result.text);
        assert.ok(handle && !handle.isClosed, "Background query was not parked");
        await waitFor(() => parkedEvents.some((e) => e.type === "assistant_message_complete" && e.text.includes("CLAUDE_BG_COMPLETE")), "Claude delayed background answer");
        handle.close();
      });
    }
    if (!backgroundOnly && !steerOnly) {
      await step("Claude stop and subsequent recovery", async () => {
        const abortController = new AbortController();
        let toolStarted = false;
        const pending = claudeTurn(`Run this bounded shell command: ${shellCommand(25, "COMPAT_CLAUDE_STOP")}. Then reply COMMAND_FINISHED.`,
          { inputController: new ClaudeSdkInputController(), abortController },
          (event) => { if (event.type === "tool_started") toolStarted = true; });
        pending.catch(() => { });
        await waitFor(() => toolStarted, "Claude stop tool start");
        abortController.abort(); await Promise.allSettled([pending]);
        const result = await claudeTurn("Reply with exactly CLAUDE_AFTER_STOP.", { resume: claudeSession });
        assert.ok(result.text.includes("CLAUDE_AFTER_STOP"), result.text);
      });
      await step("Claude compaction retains session continuity", async () => {
        const compact = await runClaudeSdkCompact({ ...claudeOptions, resume: claudeSession, timeoutMs: 120_000 });
        assert.equal(compact.providerSessionId, claudeSession);
        const result = await claudeTurn("What word was read from canary.txt before compaction? Do not reread it. Reply with just it.", { resume: claudeSession });
        assert.ok(result.text.includes("COMPAT_MEMORY_7391"), result.text);
      });
    }
  }
} catch (error) {
  console.error("[compat] RESULT: FAIL", error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const park of parks) park.close();
  for (const controller of controllers) controller.abort();
  service?.dispose();
  await Promise.allSettled(clients.map((client) => client.close()));
  releaseLock?.();
  // Archive only threads created by this test, keeping canaries out of normal lists.
  if (threads.size) {
    const client = new CodexAppServerClient({ cwd: workspace });
    try {
      await client.start(); await client.initialize(); client.notifyInitialized();
      for (const threadId of threads) await client.request("thread/archive", { threadId });
    } catch (error) { console.error("[compat] archive cleanup:", error.message); process.exitCode = 1; }
    finally { await client.close(); }
  }
  // SDK close is synchronous, but Windows releases the child's cwd asynchronously.
  try {
    await rm(workspace, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  } catch (error) {
    console.error("[compat] workspace cleanup:", error.message);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log("[compat] RESULT: PASS");
process.exit(process.exitCode ?? 0);
