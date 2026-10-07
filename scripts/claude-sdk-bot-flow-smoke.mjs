// Live smoke for the Claude Agent SDK backend (phase plan C3).
// Proves, through the full bot pipeline:
//   1. pty turn → /backend sdk → next turn RESUMES THE SAME CONVERSATION (memory recall)
//   2. on sdk, every interim narration block reaches Telegram as its own message, in order
//      (the D3 fix — the PTY smoke cannot pass this)
//   3. /backend pty rollback drill: a further turn still works and still recalls
//   4. live steering preserves a running command and ordered narration
//   5. background completion delivers ordered narration from the parked query
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBot } from "../dist/bot.js";
import { createDefaultLaunchProfile } from "../dist/codex-launch.js";
import { loadConfig } from "../dist/config.js";
import { SessionRegistry } from "../dist/session-registry.js";
import { acquireClaudeLiveLock } from "./claude-live-lock.mjs";

process.env.ENABLE_CLAUDE_PROVIDER = "true";

const baseConfig = loadConfig();
const tempWorkspace = mkdtempSync(path.join(tmpdir(), "telecode-sdk-smoke-"));
const memoryWord = "ZEBRAFISH";
let registry;
let bot;
let config;
let releaseLock;

try {
  releaseLock = await acquireClaudeLiveLock(baseConfig.workspace, "claude-sdk-bot-flow-smoke");
  config = createSmokeConfig(baseConfig, tempWorkspace);
  registry = new SessionRegistry(config);
  bot = createBot(config, registry);
  const sent = installMockTelegramApi(bot, config);
  installBotInfo(bot);

  console.log("[claude-sdk-smoke] state workspace:", tempWorkspace);
  console.log("[claude-sdk-smoke] default engine:", config.claudeBackend);

  // 1. First turn on the PTY engine, planting a memory.
  await bot.handleUpdate(textUpdate(1, `/claude Remember the secret word ${memoryWord}. Reply with exactly PTY_TURN_OK and nothing else.`, config));
  await waitForCapturedText(sent, "PTY_TURN_OK", 240000);
  assertNoPtyFallback(sent);
  console.log("[claude-sdk-smoke] pty turn: PASS");

  // 2. Switch the engine live.
  await bot.handleUpdate(textUpdate(2, "/backend sdk", config));
  await waitForCapturedText(sent, "Claude engine for this Telegram context is now sdk", 30000);
  console.log("[claude-sdk-smoke] live switch to sdk: PASS");

  // 3. Same conversation must continue on the SDK engine.
  await bot.handleUpdate(textUpdate(3, "What is the secret word I asked you to remember? Reply with just that word.", config));
  await waitForCapturedText(sent, memoryWord, 240000);
  console.log("[claude-sdk-smoke] cross-engine session continuity: PASS");

  // 4. Interim narration: all three texts must arrive as separate messages, in order.
  const narrationStart = sent.length;
  await bot.handleUpdate(textUpdate(4, [
    "Reply with exactly INTERIM_ONE.",
    'Then run the shell command "echo ok" using Bash.',
    "Then reply with exactly INTERIM_TWO.",
    'Then run "echo ok2" using Bash.',
    "Then finish by replying with exactly FINAL_MARK.",
  ].join(" "), config));
  await waitForCapturedText(sent, "FINAL_MARK", 240000);
  const markers = ["INTERIM_ONE", "INTERIM_TWO", "FINAL_MARK"];
  const indexes = markers.map((marker) => sent.findIndex(
    (entry, index) => index >= narrationStart && entry.method === "sendMessage" && entry.text?.includes(marker),
  ));
  for (const [order, marker] of markers.entries()) {
    if (indexes[order] === -1) {
      throw new Error(`Narration marker ${marker} never arrived as its own message`);
    }
  }
  if (!(indexes[0] < indexes[1] && indexes[1] < indexes[2])) {
    throw new Error(`Narration markers out of order: ${JSON.stringify(indexes)}`);
  }
  console.log("[claude-sdk-smoke] interim narration delivery (D3 fix): PASS");

  // Exercise Telegram /steer while Bash is running, and repeat narration checks
  // on the steered response before separately testing the parked-query path.
  const steerStart = sent.length;
  const python = process.env.TELECODE_CANARY_PYTHON
    ?? (process.platform === "win32" ? path.join(baseConfig.workspace, "venv", "Scripts", "python.exe") : "python3");
  const startedFile = path.join(tempWorkspace, "steer-started.txt");
  const boundedCommand = `"${python.replaceAll("\\", "/")}" -c "from pathlib import Path; p=Path('${startedFile.replaceAll("\\", "/")}'); p.write_text('running'); import time; time.sleep(12); p.write_text('finished'); print('STEER_COMMAND_DONE')"`;
  await bot.handleUpdate(textUpdate(5, `Reply STEER_BEFORE. Use Bash in the foreground to run exactly: ${boundedCommand}. Then reply ORIGINAL_REPLY.`, config));
  await waitFor(() => sent.some((entry, index) => index >= steerStart && entry.text?.includes("Claude started Bash")), 60_000);
  await waitFor(() => existsSync(startedFile), 60_000);
  await bot.handleUpdate(textUpdate(6, "/steer Keep the command running to completion. Replace ORIGINAL_REPLY with this sequence: reply STEER_NARRATION_ONE, then use Bash to run echo steer_ok, then reply STEER_NARRATION_TWO, then use Bash to run echo steer_ok2, then finish with exactly STEER_FINAL.", config));
  await waitForCapturedText(sent, "Steer sent to the active Claude turn.", 30_000);
  await waitForCapturedText(sent, "STEER_FINAL", 120_000);
  if (readFileSync(startedFile, "utf8") !== "finished") throw new Error("Steering killed the running command");
  const steerMarkers = ["STEER_BEFORE", "STEER_NARRATION_ONE", "STEER_NARRATION_TWO", "STEER_FINAL"];
  const steerIndexes = steerMarkers.map((marker) => sent.findIndex(
    (entry, index) => index >= steerStart && entry.method === "sendMessage" && entry.text?.includes(marker),
  ));
  if (steerIndexes.some((index, position) => index < 0 || (position > 0 && index <= steerIndexes[position - 1]))) {
    console.log("[claude-sdk-smoke] steering messages:", JSON.stringify(sent.slice(steerStart).filter((entry) => entry.method === "sendMessage").map((entry) => entry.text)));
    throw new Error(`Steered narration missing, merged or out of order: ${JSON.stringify(steerIndexes)}`);
  }
  console.log("[claude-sdk-smoke] live steering + repeated narration block delivery: PASS");

  const backgroundStart = sent.length;
  const backgroundCommand = `"${python.replaceAll("\\", "/")}" -c "import time; time.sleep(15); print('BG_COMMAND_DONE')"`;
  await bot.handleUpdate(textUpdate(7, `Use Bash with run_in_background:true to run exactly: ${backgroundCommand}. Reply with exactly BG_STARTED immediately. When its completion notification arrives, reply BG_NARRATION_ONE, then use Bash to run echo bg_ok, then reply BG_NARRATION_TWO, then use Bash to run echo bg_ok2, then finish with exactly BG_FINAL.`, config));
  await waitForCapturedText(sent, "BG_FINAL", 120_000);
  const backgroundMarkers = ["BG_STARTED", "BG_NARRATION_ONE", "BG_NARRATION_TWO", "BG_FINAL"];
  const backgroundIndexes = backgroundMarkers.map((marker) => sent.findIndex(
    (entry, index) => index >= backgroundStart && entry.method === "sendMessage" && entry.text?.trim() === marker,
  ));
  if (backgroundIndexes.some((index, position) => index < 0 || (position > 0 && index <= backgroundIndexes[position - 1]))) {
    console.log("[claude-sdk-smoke] background messages:", JSON.stringify(sent.slice(backgroundStart).filter((entry) => entry.method === "sendMessage").map((entry) => entry.text)));
    throw new Error(`Background narration missing, merged or out of order: ${JSON.stringify(backgroundIndexes)}`);
  }
  console.log("[claude-sdk-smoke] parked background narration block delivery: PASS");

  // 5. Rollback drill: back to pty, same conversation, still recalls.
  await bot.handleUpdate(textUpdate(8, "/backend pty", config));
  await waitForCapturedText(sent, "Claude engine for this Telegram context is now pty", 30000);
  const recallStart = sent.length;
  await bot.handleUpdate(textUpdate(9, "One more time: what was the secret word? Reply with just that word.", config));
  await waitFor(() => sent.some(
    (entry, index) => index >= recallStart && entry.text?.includes(memoryWord),
  ), 240000);
  assertNoPtyFallback(sent);
  console.log("[claude-sdk-smoke] rollback to pty + continuity: PASS");

  console.log("[claude-sdk-smoke] messages sent:", sent.filter((entry) => entry.method === "sendMessage").length);
  console.log("[claude-sdk-smoke] RESULT: PASS");
} catch (error) {
  console.error("[claude-sdk-smoke] RESULT: FAIL");
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await bot?.disposeProviders();
    if (config) {
      assertPidRegistryEmpty(config.workspace, "after disposeProviders");
    }
  } catch (error) {
    console.error("[claude-sdk-smoke] dispose failed:", error);
    process.exitCode = 1;
  }
  releaseLock?.();
  try {
    registry?.disposeAll();
  } catch {
    // Best effort cleanup for smoke-test state.
  }
  rmSync(tempWorkspace, { recursive: true, force: true });
}

process.exit(process.exitCode ?? 0);

function createSmokeConfig(base, workspace) {
  const launchProfile = createDefaultLaunchProfile("danger-full-access", "never");
  return {
    ...base,
    telegramAllowedUserIds: [base.telegramAllowedUserIds[0]],
    telegramAllowedUserIdSet: new Set([base.telegramAllowedUserIds[0]]),
    workspace,
    codexBackend: "app-server",
    codexSandboxMode: "danger-full-access",
    codexApprovalPolicy: "never",
    launchProfiles: [launchProfile],
    defaultLaunchProfileId: launchProfile.id,
    enableUnsafeLaunchProfiles: true,
    streamAssistantText: false,
    progressDelivery: "messages",
    toolVerbosity: "all",
    showTurnTokenUsage: false,
    enableTelegramLogin: false,
    enableTelegramReactions: false,
    enableClaudeProvider: true,
    claudeWorkspace: base.claudeWorkspace,
    claudePermissionMode: "bypassPermissions",
    claudeBackend: "pty",
  };
}

function installMockTelegramApi(bot, config) {
  const sent = [];
  let messageId = 1000;
  bot.api.config.use(async (_prev, method, payload = {}) => {
    if (method === "sendMessage") {
      sent.push({ method, text: payload.text, payload });
      return { ok: true, result: textMessage(messageId++, payload.text ?? "", config) };
    }
    if (method === "editMessageText") {
      sent.push({ method, text: payload.text, payload });
      return { ok: true, result: true };
    }
    if (
      method === "sendChatAction" ||
      method === "answerCallbackQuery" ||
      method === "setMessageReaction"
    ) {
      sent.push({ method, payload });
      return { ok: true, result: true };
    }
    throw new Error(`Unhandled Telegram API method in smoke test: ${method}`);
  });
  return sent;
}

function installBotInfo(bot) {
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "TeleCode",
    username: "TeleCodeBot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
}

function textUpdate(updateId, text, config) {
  return {
    update_id: updateId,
    message: textMessage(updateId, text, config),
  };
}

function textMessage(messageId, text, config) {
  const commandMatch = text.match(/^\/\S+/u);
  const userId = config.telegramAllowedUserIds[0];
  return {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: userId, type: "private" },
    from: { id: userId, is_bot: false, first_name: "Tester" },
    text,
    entities: commandMatch
      ? [{ type: "bot_command", offset: 0, length: commandMatch[0].length }]
      : undefined,
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for Claude SDK smoke condition");
}

async function waitForCapturedText(sent, expected, timeoutMs) {
  await waitFor(() => sent.some((entry) => entry.text?.toUpperCase().includes(expected.toUpperCase())), timeoutMs);
  return sent
    .map((entry) => entry.text ?? "")
    .find((text) => text.toUpperCase().includes(expected.toUpperCase()));
}

function assertNoPtyFallback(sent) {
  if (sent.some((entry) => entry.text?.includes("switched this chat to the SDK engine for the retry"))) {
    throw new Error("PTY continuity check used the automatic SDK fallback instead of the PTY engine");
  }
}

function assertPidRegistryEmpty(workspace, label) {
  const registryPath = path.join(workspace, ".telecode", "provider-state", "claude-pids.json");
  if (!existsSync(registryPath)) {
    return;
  }
  const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  if (Array.isArray(parsed.processes) && parsed.processes.length === 0) {
    return;
  }
  throw new Error(`Claude PID registry not empty ${label}: ${readFileSync(registryPath, "utf8")}`);
}
