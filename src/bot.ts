import { randomUUID } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import * as pty from "node-pty";

import { bridgeLog, initBridgeLog } from "./bridge-log.js";
import { listConfiguredCodexMcpServers } from "./codex-mcp-toggle.js";
import { ClaudeBackendPrefs, claudeBackendPrefsPath, type ClaudeBackendChoice } from "./claude-backend-prefs.js";
import {
  probeCodexAppServer,
  readCodexAppServerRateLimits,
  runCodexAppServerSteeredTurn,
  runCodexAppServerTurn,
  type AppServerProbeResult,
  type AppServerSteerResult,
  type AppServerTurnResult,
} from "./app-server.js";
import {
  buildFileInstructions,
  cleanupInbox,
  outboxPath,
  outputFilesInstruction,
  OUTPUT_FILES_INSTRUCTION_PREFIX,
  stageFile,
  stripOutputFilesInstruction,
  type StagedFile,
} from "./attachments.js";
import { collectArtifactReport, ensureOutDir, formatArtifactSummary, pruneOldTurnDirectories } from "./artifacts.js";
import { AgentSessionManager, type AgentJobRecord, type AgentSessionRecord } from "./agent-session-manager.js";
import { agentSessionStatePath, JsonAgentSessionStore } from "./agent-session-store.js";
import {
  cleanSessionTitle,
  deriveSessionTitle,
  formatSessionLabel,
  renderHelpMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "./bot-ui.js";
import {
  type CodexPromptInput,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
} from "./codex-session.js";
import {
  ClaudePromptQueue,
  claudePromptQueuePath,
  type ClaudePromptQueueEntry,
  type ClaudeQueuedPromptKind,
} from "./claude-prompt-queue.js";
import { createCodexSession, type CodexSessionRuntime } from "./codex-backend.js";
import { checkAuthStatus, clearAuthCache, startLogin, startLogout } from "./codex-auth.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  formatLaunchProfileLabel,
} from "./codex-launch.js";
import {
  getCodexSessionsDirPath,
  getParentThread,
  getThread,
  getThreadByPrefix,
  listChildThreads,
  listSpawnedThreadIds,
  listThreads,
  readThreadHistory,
  type CodexThreadRecord,
} from "./codex-state.js";
import type { CodexBackend, ClaudePermissionMode, ProgressDelivery, TeleCodeConfig, ToolVerbosity } from "./config.js";
import { contextKeyFromCtx, isTopicContextKey, parseContextKey, type TelegramContextKey } from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML, formatTelegramHTML } from "./format.js";
import { applyGoalModeConstraints, formatThreadGoal, parseGoalModeArgument } from "./goal-mode.js";
import { OutputBuffer, type BufferedOutputEvent } from "./output-buffer.js";
import {
  CODEX_REASONING_EFFORTS,
  LEGACY_CODEX_REASONING_EFFORTS,
  isCodexReasoningEffort,
  type CodexReasoningEffort,
} from "./reasoning-effort.js";
import { ClaudeProviderAdapter, PromptNotDeliveredError } from "./providers/claude-adapter.js";
import { classifyClaudeSlashCommand } from "./providers/claude-commands.js";
import { claudeProcessRegistryPath } from "./providers/claude-process-registry.js";
import {
  ClaudeSessionStateIndex,
  ClaudeStateStore,
  claudeProviderStatePath,
  type ClaudeSessionStateRecord,
} from "./providers/claude-state.js";
import { findTranscript } from "./providers/claude-transcript.js";
import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentProviderEvent,
  AgentProviderKind,
  AgentSessionDescriptor,
} from "./providers/types.js";
import {
  CLAUDE_PERMISSION_CALLBACK,
  formatPermissionOutcome,
  formatPermissionPrompt,
  permissionCallbackData,
  PermissionPromptRegistry,
} from "./claude-permission-prompt.js";
import { createSessionSearchIndex, type SessionSearchHit } from "./session-search.js";
import { SessionRegistry } from "./session-registry.js";
import { findRunningClaudeTelegramPluginProcesses } from "./startup-safety.js";
import { mergeLiveAppServerRateLimits, readLatestCodexUsage, renderUsagePlain } from "./usage.js";
import { getAvailableBackends, transcribeAudio } from "./voice.js";
import { normalizePersistedWorkspace } from "./workspace-normalization.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const FIRST_INTERMEDIATE_UPDATE_MS = 2500;
const INTERMEDIATE_UPDATE_MIN_MS = 10000;
const SUMMARY_PROGRESS_UPDATE_MIN_MS = 10000;
const SUMMARY_PROGRESS_RECENT_LIMIT = 5;
// Budget for the rolling edit-mode progress message. Kept under Telegram's 4096-char
// edit limit so the header and HTML escaping never push a full-content render over it.
export const PROGRESS_EDIT_BUDGET_CHARS = 3500;
// A held Claude narration line is flushed after this idle gap so the first line does not
// wait for Claude's next block. Long enough that a normal turn ends (clearing it) first.
const NARRATION_IDLE_FLUSH_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;
const STREAM_MESSAGE_TARGET = 1200;
const FORMATTED_CHUNK_TARGET = 3600;
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;
const KEYBOARD_PAGE_SIZE = 6;
const CLAUDE_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CLAUDE_PERMISSION_TIMEOUT_MINUTES = 15;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\r/g;
// A 50-entry default overflows one Telegram message and pushes the list footer
// into a second chunk. Keep the default inside a single message; `/sessions all`
// is the escape hatch for the long history.
const DEFAULT_PROVIDER_SESSION_LIST_LIMIT = 20;
const MAX_PROVIDER_SESSION_LIST_LIMIT = 500;
const NOOP_PAGE_CALLBACK_DATA = "noop_page";
const LAUNCH_PROFILES_COMMAND = "/launch_profiles";
const CLAUDE_QUIET_WARNING_PREFIX = "Claude has been quiet for ";
// How long an unanswered idle-steer y/n question stays valid.
const IDLE_STEER_CONFIRM_TTL_MS = 5 * 60 * 1000;
const MAX_CLAUDE_PROMPT_DELIVERY_FAILURES = 3;
const NATIVE_CODEX_COMMANDS = [
  "compact",
  "agents",
  "diff",
  "help",
  "doctor",
  "prompts",
  "memory",
  "mentions",
  "init",
  "bug",
  "config",
  "limits",
] as const;
const TELECODE_COMMANDS_WHILE_CLAUDE_ACTIVE = new Set([
  "start",
  "help",
  "health",
  "jobs",
  "alljobs",
  "retry",
  "auth",
  "history",
  "abort",
  "stop",
  "steer",
  "claude",
  "claude-login",
  "claudelogin",
  "claude_login",
  "codex",
  "provider",
  "new",
  "fork",
  "sessions",
  "switch",
  "use",
  "find",
  "search",
  "replay",
  "copy",
  "last",
  "repeat",
  "workspaces",
  "workspace",
  "backend",
  "verbosity",
  "velocity",
  "progress",
  "voice",
  "mcp",
  "newsummary",
]);
const NEW_FROM_SUMMARY_PROMPT = [
  "Create a compact handoff summary for continuing this Codex session in a fresh thread.",
  "Include: current goal, important decisions, files changed or inspected, commands run, current state, open problems, and recommended next steps.",
  "Be specific enough that a new session can continue without reading the full transcript.",
  "Output only the summary.",
].join("\n");
const CLAUDE_NEW_FROM_SUMMARY_PROMPT = [
  "Create a compact handoff summary for continuing this Claude session in a fresh session.",
  "Include: current goal, important decisions, files changed or inspected, commands run, current state, open problems, and recommended next steps.",
  "Be specific enough that a new session can continue without reading the full transcript.",
  "Output only the summary.",
].join("\n");

type TelegramChatId = number | string;
type TelegramParseMode = "HTML";
type KeyboardItem = { label: string; callbackData: string };

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
};

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
};

type QueuedPrompt = {
  ctx: Context;
  chatId: TelegramChatId;
  session: CodexSessionRuntime;
  userInput: CodexPromptInput;
};

type ClaudePromptRunSource = {
  ctx?: Context;
  chatId: TelegramChatId;
  messageThreadId?: number;
  queueEntry?: ClaudePromptQueueEntry;
};

type PendingClaudeLogin = {
  proc: pty.IPty;
  chatId: TelegramChatId;
  messageThreadId?: number;
  buffer: string;
  urlSent: boolean;
  codeSubmitted: boolean;
  submittedCode?: string;
  timeout: ReturnType<typeof setTimeout>;
};

type ProviderSessionPick =
  | {
      kind: "agent";
      session: AgentSessionRecord;
      provider: AgentProviderKind;
      title: string;
      workspace: string;
      updatedAt: number;
      status: AgentSessionRecord["status"];
      providerSessionId?: string;
    }
  | {
      kind: "codex-thread";
      thread: CodexThreadRecord;
      provider: "codex";
      title: string;
      workspace: string;
      updatedAt: number;
      status: "old";
      providerSessionId: string;
    }
  | {
      kind: "claude-transcript";
      provider: "claude";
      title: string;
      workspace: string;
      updatedAt: number;
      status: "old";
      providerSessionId: string;
      metadata?: Record<string, unknown>;
    };

function paginateKeyboard(items: KeyboardItem[], page: number, prefix: string): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(items.length / KEYBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * KEYBOARD_PAGE_SIZE;
  const pageItems = items.slice(start, start + KEYBOARD_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  pageItems.forEach((item, index) => {
    keyboard.text(item.label, item.callbackData);
    if (index < pageItems.length - 1 || totalPages > 1) {
      keyboard.row();
    }
  });

  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ Prev", `${prefix}_page_${currentPage - 1}`);
    }
    keyboard.text(`${currentPage + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (currentPage < totalPages - 1) {
      keyboard.text("Next ▶️", `${prefix}_page_${currentPage + 1}`);
    }
  }

  return keyboard;
}

export interface TeleCodeBot extends Bot<Context> {
  disposeProviders(): Promise<void>;
  /** Kick off the initial background build of the /find session search index. */
  startSessionSearchIndexing(): void;
}

export function createBot(config: TeleCodeConfig, registry: SessionRegistry): TeleCodeBot {
  const bot = new Bot<Context>(config.telegramBotToken) as TeleCodeBot;
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));
  const startedAt = Date.now();
  initBridgeLog(config.workspace);
  bridgeLog("startup", `bridge starting; workspace=${config.workspace} claudeProvider=${config.enableClaudeProvider}`);
  const agentSessionStore = new JsonAgentSessionStore(agentSessionStatePath(config.workspace));
  const agentSessionState = agentSessionStore.load();
  for (const session of agentSessionState.sessions) {
    session.workspace = normalizePersistedWorkspace(session.workspace, config.workspace);
  }
  const agentSessions = new AgentSessionManager({ state: agentSessionState });
  applyAgentSessionRepairs(
    agentSessions,
    path.join(config.workspace, ".telecode", "provider-state", "agent-session-repair.json"),
  );
  agentSessions.abortPersistedJobs();
  const outputBuffer = new OutputBuffer();
  const busyProviders = new Map<TelegramContextKey, Set<AgentProviderKind>>();
  agentSessions.importLegacyContexts(registry.listContexts(), { defaultProvider: "codex", selectImported: true });
  persistSafe(agentSessionStore, agentSessions);

  const contextBusy = new Map<
    TelegramContextKey,
    { processing: boolean; switching: boolean; transcribing: boolean }
  >();
  const pendingSessionPicks = new Map<TelegramContextKey, string[]>();
  const pendingAgentSessionPicks = new Map<TelegramContextKey, ProviderSessionPick[]>();
  const pendingChildPicks = new Map<TelegramContextKey, string[]>();
  const pendingWorkspacePicks = new Map<TelegramContextKey, string[]>();
  const pendingSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingLaunchPicks = new Map<TelegramContextKey, string[]>();
  const pendingLaunchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUnsafeLaunchConfirmations = new Map<TelegramContextKey, string>();
  const pendingModelButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingEffortButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const claudePermissionPrompts = new PermissionPromptRegistry(CLAUDE_PERMISSION_TIMEOUT_MINUTES * 60 * 1000);
  const inspectedThreads = new Map<TelegramContextKey, { threadId: string; parentThreadId?: string }>();
  const lastPromptInput = new Map<TelegramContextKey, CodexPromptInput>();
  const lastAssistantReplyBySessionId = new Map<string, string>();
  const queuedPrompts = new Map<TelegramContextKey, QueuedPrompt>();
  const queuedClaudePrompts = new ClaudePromptQueue(claudePromptQueuePath(config.workspace));
  const liveQueuedClaudeContexts = new Map<string, Context>();
  const claudeIntakeLocks = new Map<TelegramContextKey, boolean>();
  // /steer sent while no turn is running: held here until the user answers y/n.
  const pendingIdleSteers = new Map<TelegramContextKey, {
    text: string;
    provider: "claude" | "codex";
    expiresAt: number;
  }>();
  const activeProgressRefreshers = new Map<TelegramContextKey, () => Promise<void>>();
  const pendingClaudeLogins = new Map<TelegramContextKey, PendingClaudeLogin>();
  const claudeAdapter = config.enableClaudeProvider ? new ClaudeProviderAdapter(config) : undefined;
  const claudeState = config.enableClaudeProvider
    ? new ClaudeSessionStateIndex(new ClaudeStateStore(claudeProviderStatePath(config.workspace)))
    : undefined;
  const claudeBackendPrefs = config.enableClaudeProvider
    ? new ClaudeBackendPrefs(claudeBackendPrefsPath(config.workspace))
    : undefined;
  const claudeSessions = new Map<TelegramContextKey, AgentSessionDescriptor>();
  const sessionSearch = createSessionSearchIndex({
    indexPath: path.join(config.workspace, ".telecode", "session-index.sqlite"),
    claudeProjectsDir: config.enableClaudeProvider
      ? (config.claudeStrictMcpConfig
        ? path.join(homedir(), ".claude", "projects")
        : path.join(config.claudeConfigDir, "projects"))
      : "",
    codexSessionsDir: getCodexSessionsDirPath() ?? "",
  });

  // The provider state is the authoritative pointer for the Claude conversation
  // attached to a Telegram lane. If transcript recovery ever corrected that pointer,
  // keep the parallel session index in sync on startup instead of leaving /sessions
  // pointed at a stale transcript.
  if (claudeState) {
    let repairedAgentSessionState = false;
    for (const record of claudeState.list()) {
      const laneClaudeSessions = agentSessions
        .listLaneSessions(record.telegramContextKey)
        .filter((session) => session.provider === "claude");
      const target = laneClaudeSessions.sort((left, right) =>
        Math.abs(left.createdAt - record.createdAt) - Math.abs(right.createdAt - record.createdAt)
      )[0];
      if (!target) {
        continue;
      }
      if (target.providerSessionId !== record.sessionId) {
        agentSessions.updateProviderSessionId(target.id, record.sessionId);
        repairedAgentSessionState = true;
      }
      const repairedMetadata = {
        ...target.metadata,
        model: record.model,
        permissionMode: record.permissionMode,
        transcriptPath: record.transcriptPath,
        backend: claudeBackendPrefs?.get(record.telegramContextKey) ?? config.claudeBackend,
      };
      if (JSON.stringify(target.metadata ?? {}) !== JSON.stringify(repairedMetadata)) {
        agentSessions.updateMetadata(target.id, repairedMetadata);
        repairedAgentSessionState = true;
      }
    }
    if (repairedAgentSessionState) {
      persistSafe(agentSessionStore, agentSessions);
    }
  }

  const cancelPendingClaudeLogin = (contextKey: TelegramContextKey): void => {
    const pending = pendingClaudeLogins.get(contextKey);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    pendingClaudeLogins.delete(contextKey);
    try {
      pending.proc.kill();
    } catch {
      // Best effort cleanup for a PTY that may already have exited.
    }
  };

  const runClaudeAuthStatus = async (): Promise<string> => {
    return await new Promise((resolve) => {
      const child = spawnProcess(config.claudeBin, ["auth", "status"], {
        cwd: config.workspace,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString("utf8");
      });
      child.stderr.on("data", (data: Buffer) => {
        output += data.toString("utf8");
      });
      child.on("error", (error) => {
        resolve(`Failed to run Claude auth status: ${error.message}`);
      });
      child.on("close", () => {
        resolve(output.trim() || "Claude auth status returned no output.");
      });
    });
  };

  const submitClaudeLoginCode = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    code: string,
  ): Promise<boolean> => {
    const pending = pendingClaudeLogins.get(contextKey);
    if (!pending) {
      return false;
    }
    const trimmed = code.trim();
    if (!trimmed) {
      return true;
    }
    if (pending.codeSubmitted) {
      await safeReply(ctx, escapeHTML("Claude login code was already submitted. Waiting for Claude to finish."), {
        fallbackText: "Claude login code was already submitted. Waiting for Claude to finish.",
        messageThreadId: pending.messageThreadId,
      });
      return true;
    }
    pending.codeSubmitted = true;
    pending.submittedCode = trimmed;
    pending.proc.write(`${trimmed}\r`);
    await safeReply(ctx, escapeHTML("Claude login code submitted. Checking auth status..."), {
      fallbackText: "Claude login code submitted. Checking auth status...",
      messageThreadId: pending.messageThreadId,
    });
    return true;
  };

  const startClaudeLoginFlow = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    email?: string,
  ): Promise<void> => {
    if (!config.enableClaudeProvider) {
      const message = "Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }
    // A bare command name ("claude") resolves via PATH at spawn time; only reject
    // configured absolute paths that are verifiably missing.
    if (path.isAbsolute(config.claudeBin) && !existsSync(config.claudeBin)) {
      const message = `Claude binary not found: ${config.claudeBin}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    cancelPendingClaudeLogin(contextKey);

    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }
    const messageThreadId = ctx.message?.message_thread_id;
    const args = ["auth", "login", "--claudeai"];
    if (email) {
      args.push("--email", email);
    }

    let proc: pty.IPty;
    try {
      proc = pty.spawn(config.claudeBin, args, {
        cwd: config.workspace,
        cols: 120,
        rows: 40,
        env: process.env as Record<string, string>,
        name: process.platform === "win32" ? "xterm-256color" : "xterm-color",
      });
    } catch (error) {
      const message = `Claude login failed to start: ${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }

    const pending: PendingClaudeLogin = {
      proc,
      chatId,
      messageThreadId,
      buffer: "",
      urlSent: false,
      codeSubmitted: false,
      timeout: setTimeout(() => {
        cancelPendingClaudeLogin(contextKey);
        void sendTextMessage(bot.api, chatId, "Claude login timed out. Run /claude-login to try again.", {
          parseMode: undefined,
          fallbackText: "Claude login timed out. Run /claude-login to try again.",
          messageThreadId,
        }).catch(() => {});
      }, CLAUDE_LOGIN_TIMEOUT_MS),
    };
    pendingClaudeLogins.set(contextKey, pending);

    proc.onData((data) => {
      pending.buffer += data;
      if (pending.buffer.length > 32000) {
        pending.buffer = pending.buffer.slice(-32000);
      }
      if (!pending.urlSent) {
        const url = extractClaudeLoginUrl(stripTerminalText(pending.buffer));
        if (url) {
          pending.urlSent = true;
          const message = [
            "Open this Claude login URL, finish the browser login, then send the returned code here as your next message.",
            "",
            url,
          ].join("\n");
          void sendTextMessage(bot.api, chatId, message, {
            parseMode: undefined,
            fallbackText: message,
            messageThreadId,
          }).catch(() => {});
        }
      }
    });

    proc.onExit(({ exitCode }) => {
      const current = pendingClaudeLogins.get(contextKey);
      if (current !== pending) {
        return;
      }
      clearTimeout(pending.timeout);
      pendingClaudeLogins.delete(contextKey);
      void (async () => {
        const status = await runClaudeAuthStatus();
        const loggedIn = /"loggedIn"\s*:\s*true/.test(status);
        if (exitCode === 0 && loggedIn) {
          const message = `Claude login complete.\n\n${status}`;
          await sendTextMessage(bot.api, chatId, message, {
            parseMode: undefined,
            fallbackText: message,
            messageThreadId,
          });
          return;
        }

        const tail = redactClaudeLoginSecrets(stripTerminalText(pending.buffer), pending.submittedCode).slice(-1200).trim();
        const message = [
          "Claude login failed.",
          `Exit code: ${exitCode ?? "unknown"}`,
          "",
          tail || status,
        ].join("\n");
        await sendTextMessage(bot.api, chatId, message, {
          parseMode: undefined,
          fallbackText: message,
          messageThreadId,
        });
      })().catch((error) => {
        console.warn("Failed to report Claude login result", error);
      });
    });

    await safeReply(ctx, escapeHTML("Claude login started. Waiting for the browser login URL..."), {
      fallbackText: "Claude login started. Waiting for the browser login URL...",
      messageThreadId,
    });
  };

  const disposeClaudeDescriptor = async (descriptor: AgentSessionDescriptor | undefined): Promise<void> => {
    if (!descriptor || !claudeAdapter) {
      return;
    }
    await claudeAdapter.dispose(descriptor.id);
  };

  const disposeProviderSessions = async (): Promise<void> => {
    bridgeLog("shutdown", "disposing provider sessions");
    if (!claudeAdapter) {
      return;
    }
    await claudeAdapter.dispose();
    claudeSessions.clear();
  };

  bot.disposeProviders = disposeProviderSessions;

  // Deliberately not started from createBot: tests build bots without wanting a
  // background crawl of the real transcript directories. index.ts triggers this
  // once the bot is otherwise ready.
  bot.startSessionSearchIndexing = () => {
    if (!sessionSearch) {
      return;
    }
    void sessionSearch.refresh()
      .then(() => {
        console.log(`Session search index ready (${sessionSearch.status().indexedFiles} sessions).`);
      })
      .catch((error) => {
        console.warn(
          "Initial session search index build failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
  };

  registry.onRemove((key) => {
    contextBusy.delete(key);
    busyProviders.delete(key);
    pendingSessionPicks.delete(key);
    pendingAgentSessionPicks.delete(key);
    pendingChildPicks.delete(key);
    pendingSessionButtons.delete(key);
    pendingLaunchPicks.delete(key);
    pendingLaunchButtons.delete(key);
    pendingUnsafeLaunchConfirmations.delete(key);
    inspectedThreads.delete(key);
    lastPromptInput.delete(key);
    for (const session of agentSessions.listLaneSessions(key)) {
      lastAssistantReplyBySessionId.delete(session.id);
    }
    queuedPrompts.delete(key);
    for (const entry of queuedClaudePrompts.list(key)) {
      liveQueuedClaudeContexts.delete(entry.id);
    }
    queuedClaudePrompts.removeContext(key);
    claudeIntakeLocks.delete(key);
    pendingIdleSteers.delete(key);
    activeProgressRefreshers.delete(key);
    cancelPendingClaudeLogin(key);
    void disposeClaudeDescriptor(claudeSessions.get(key)).catch((error) => {
        console.warn("Failed to dispose Claude session after context removal", error);
      });
    claudeSessions.delete(key);
    claudeState?.remove(key);
  });

  const getBusyState = (
    contextKey: TelegramContextKey,
  ): { processing: boolean; switching: boolean; transcribing: boolean } => {
    let state = contextBusy.get(contextKey);
    if (!state) {
      state = { processing: false, switching: false, transcribing: false };
      contextBusy.set(contextKey, state);
    }
    return state;
  };

  const markProviderBusy = (
    contextKey: TelegramContextKey,
    provider: AgentProviderKind,
    busy: boolean,
  ): void => {
    const providers = busyProviders.get(contextKey) ?? new Set<AgentProviderKind>();
    if (busy) {
      providers.add(provider);
    } else {
      providers.delete(provider);
    }

    if (providers.size > 0) {
      busyProviders.set(contextKey, providers);
    } else {
      busyProviders.delete(contextKey);
    }
  };

  const isProviderBusy = (contextKey: TelegramContextKey, provider: AgentProviderKind): boolean =>
    busyProviders.get(contextKey)?.has(provider) ?? false;

  const isAnyProviderBusy = (contextKey: TelegramContextKey): boolean =>
    (busyProviders.get(contextKey)?.size ?? 0) > 0;

  const isBusy = (
    contextKey: TelegramContextKey,
    provider: AgentProviderKind = registry.getActiveProvider(contextKey),
  ): boolean => {
    const state = contextBusy.get(contextKey);
    if (state?.switching || state?.transcribing) {
      return true;
    }

    if (isProviderBusy(contextKey, provider)) {
      return true;
    }

    if (provider === "codex") {
      return Boolean(registry.get(contextKey)?.isProcessing());
    }

    return false;
  };

  const isClaudeActive = (contextKey: TelegramContextKey): boolean =>
    registry.getActiveProvider(contextKey) === "claude";

  const isProviderForeground = (contextKey: TelegramContextKey, provider: AgentProviderKind): boolean =>
    registry.getActiveProvider(contextKey) === provider;

  const persistAgentSessionState = (): void => {
    try {
      agentSessionStore.save(agentSessions.serialize());
    } catch (error) {
      console.warn("Failed to persist agent session state", error);
    }
  };

  const ensureAgentSessionRecord = (
    contextKey: TelegramContextKey,
    provider: AgentProviderKind,
    options: {
      workspace: string;
      displayName?: string;
      providerSessionId?: string;
      select?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): AgentSessionRecord => {
    agentSessions.ensureLane(contextKey, { defaultProvider: provider });
    const existing = agentSessions.listLaneSessions(contextKey).find((session) => {
      if (session.provider !== provider) {
        return false;
      }
      return options.providerSessionId ? session.providerSessionId === options.providerSessionId : true;
    });

    if (existing) {
      let next = existing;
      if (
        options.displayName &&
        shouldReplaceSessionDisplayName(existing.displayName, options.displayName, existing.providerSessionId, provider)
      ) {
        next = agentSessions.updateDisplayName(existing.id, options.displayName);
      }
      if (options.metadata) {
        next = agentSessions.updateMetadata(existing.id, options.metadata);
      }
      if (options.select) {
        agentSessions.selectSession(contextKey, existing.id);
        persistAgentSessionState();
      } else if (next !== existing) {
        persistAgentSessionState();
      }
      return next;
    }

    const created = agentSessions.createSession(contextKey, provider, {
      workspace: options.workspace,
      displayName: options.displayName,
      providerSessionId: options.providerSessionId,
      select: options.select,
      metadata: options.metadata,
    });
    persistAgentSessionState();
    return created;
  };

  const getFocusedAgentSession = (contextKey: TelegramContextKey): AgentSessionRecord | undefined => {
    const activeProvider = registry.getActiveProvider(contextKey);
    const selected = agentSessions.getSelectedSession(contextKey);
    if (selected?.provider === activeProvider) {
      return selected;
    }

    const providerSessionId = activeProvider === "claude"
      ? claudeSessions.get(contextKey)?.providerSessionId ?? claudeState?.get(contextKey)?.sessionId
      : registry.get(contextKey)?.getInfo().threadId;
    if (!providerSessionId) {
      return undefined;
    }

    return agentSessions.listLaneSessions(contextKey).find((session) =>
      session.provider === activeProvider && session.providerSessionId === providerSessionId,
    );
  };

  const getFocusedAssistantReply = (contextKey: TelegramContextKey): string | undefined => {
    const focusedSession = getFocusedAgentSession(contextKey);
    return focusedSession ? lastAssistantReplyBySessionId.get(focusedSession.id) : undefined;
  };

  const startAgentJob = (sessionId: string, jobId: string): void => {
    const session = agentSessions.getSession(sessionId);
    if (session?.currentJobId) {
      agentSessions.abortJob(session.currentJobId);
    }
    agentSessions.startJob(sessionId, { id: jobId });
    persistAgentSessionState();
  };

  const finishAgentJob = (
    jobId: string,
    status: "completed" | "failed" | "aborted",
    error?: string,
  ): void => {
    try {
      if (status === "completed") {
        agentSessions.completeJob(jobId);
      } else if (status === "aborted") {
        agentSessions.abortJob(jobId);
      } else {
        agentSessions.failJob(jobId, error ?? "failed");
      }
      persistAgentSessionState();
    } catch (finishError) {
      console.warn("Failed to finish agent job", finishError);
    }
  };

  const buildClaudeDescriptor = (record: ClaudeSessionStateRecord): AgentSessionDescriptor => ({
    id: `claude-${record.sessionId.slice(0, 12)}`,
    provider: "claude",
    workspace: record.workspace,
    displayName: record.displayName,
    providerSessionId: record.sessionId,
    status: "idle",
    capabilities: claudeAdapter?.capabilities ?? {
      streamingText: true,
      streamingInput: true,
      abort: true,
      fork: false,
      rename: false,
      compact: true,
      usage: true,
      context: true,
      slashCommands: true,
      permissions: false,
      userQuestions: false,
      artifacts: false,
    },
    createdAt: record.createdAt,
    updatedAt: record.lastUsedAt,
    metadata: {
      model: record.model,
      permissionMode: record.permissionMode,
      transcriptPath: record.transcriptPath,
    },
  });

  const getClaudeBackend = (contextKey: TelegramContextKey): ClaudeBackendChoice =>
    claudeBackendPrefs?.get(contextKey) ?? config.claudeBackend;

  const canResumePersistedClaudeSession = (record: ClaudeSessionStateRecord): boolean => (
    record.permissionMode === config.claudePermissionMode &&
    record.workspace === config.claudeWorkspace
  );

  const persistClaudeSession = (
    contextKey: TelegramContextKey,
    descriptor: AgentSessionDescriptor,
  ): void => {
    if (!claudeState || !descriptor.providerSessionId) {
      return;
    }
    claudeState.upsert({
      telegramContextKey: contextKey,
      sessionId: descriptor.providerSessionId,
      workspace: descriptor.workspace,
      displayName: descriptor.displayName,
      model: String(descriptor.metadata?.model ?? config.claudeDefaultModel),
      permissionMode: asClaudePermissionMode(descriptor.metadata?.permissionMode) ?? config.claudePermissionMode,
      transcriptPath: typeof descriptor.metadata?.transcriptPath === "string"
        ? descriptor.metadata.transcriptPath
        : undefined,
      createdAt: descriptor.createdAt,
      lastUsedAt: Date.now(),
    });
  };

  const ensureClaudeSession = async (
    contextKey: TelegramContextKey,
    onStartupStatus?: (text: string) => void | Promise<void>,
  ): Promise<AgentSessionDescriptor> => {
    if (!claudeAdapter) {
      throw new Error("Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.");
    }
    const existing = claudeSessions.get(contextKey);
    if (existing) {
      return existing;
    }

    const persisted = claudeState?.get(contextKey);
    let resumablePersisted = persisted && canResumePersistedClaudeSession(persisted)
      ? persisted
      : undefined;
    if (persisted && !resumablePersisted) {
      claudeState?.remove(contextKey);
    }
    let persistedTranscript = resumablePersisted
      ? await findTranscript(
          resumablePersisted.sessionId,
          250,
          config.claudeStrictMcpConfig ? undefined : config.claudeConfigDir,
        )
      : null;
    if (resumablePersisted && persistedTranscript) {
      const transcriptPermissionMode = readClaudeTranscriptLastPermissionMode(persistedTranscript);
      if (transcriptPermissionMode && transcriptPermissionMode !== config.claudePermissionMode) {
        claudeState?.remove(contextKey);
        resumablePersisted = undefined;
        persistedTranscript = null;
      }
    }
    const backend = getClaudeBackend(contextKey);
    let descriptor = resumablePersisted && persistedTranscript
      ? await claudeAdapter.resumeSession({
          ...buildClaudeDescriptor(resumablePersisted),
          metadata: {
            model: resumablePersisted.model,
            permissionMode: resumablePersisted.permissionMode,
            transcriptPath: resumablePersisted.transcriptPath,
            backend,
          },
        }, onStartupStatus)
      : await claudeAdapter.createSession({
          workspace: config.claudeWorkspace,
          displayName: `TeleCode ${contextKey}`,
          metadata: {
            model: config.claudeDefaultModel,
            permissionMode: config.claudePermissionMode,
            backend,
          },
        }, onStartupStatus);
    const actualBackend = claudeAdapter.getBackend(descriptor.id);
    if (actualBackend !== backend) {
      bridgeLog("backend", `correcting claude engine lane=${contextKey} requested=${backend} actual=${actualBackend}`);
      await claudeAdapter.setBackend(descriptor.id, backend);
      descriptor = await claudeAdapter.getSessionInfo(descriptor.id);
    } else {
      bridgeLog("backend", `claude engine selected lane=${contextKey} engine=${backend}`);
    }
    claudeSessions.set(contextKey, descriptor);
    persistClaudeSession(contextKey, descriptor);
    return descriptor;
  };

  const createFreshClaudeSession = async (
    contextKey: TelegramContextKey,
    options: { model?: string } = {},
  ): Promise<AgentSessionDescriptor> => {
    if (!claudeAdapter) {
      throw new Error("Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.");
    }

    const model = options.model ?? config.claudeDefaultModel;
    const previous = claudeSessions.get(contextKey);
    const descriptor = await claudeAdapter.createSession({
      workspace: config.claudeWorkspace,
      displayName: `TeleCode ${contextKey}`,
      metadata: {
        model,
        permissionMode: config.claudePermissionMode,
        backend: getClaudeBackend(contextKey),
      },
    });
    if (previous && previous.id !== descriptor.id) {
      await disposeClaudeDescriptor(previous);
    }
    claudeSessions.set(contextKey, descriptor);
    persistClaudeSession(contextKey, descriptor);
    ensureAgentSessionRecord(contextKey, "claude", {
      workspace: descriptor.workspace,
      displayName: descriptor.displayName ?? "Claude Code",
      providerSessionId: descriptor.providerSessionId,
      select: true,
      metadata: descriptor.metadata,
    });
    return descriptor;
  };

  const forkClaudeConversation = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    title?: string,
    messageThreadId?: number,
  ): Promise<void> => {
    if (!claudeAdapter) {
      const message = "Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }
    if (isProviderBusy(contextKey, "claude")) {
      const message = "Cannot fork while Claude is running. Wait for the turn to finish, then /fork again.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }
    const current = claudeSessions.get(contextKey);
    if (!current?.providerSessionId) {
      const message = "No Claude conversation to fork yet. Send Claude a message first.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }
    try {
      const forked = await claudeAdapter.forkSession(current.id, title);
      claudeSessions.set(contextKey, forked);
      ensureAgentSessionRecord(contextKey, "claude", {
        workspace: forked.workspace,
        displayName: forked.displayName ?? "Claude (fork)",
        providerSessionId: forked.providerSessionId,
        select: true,
        metadata: forked.metadata,
      });
      persistClaudeSession(contextKey, forked);
      const message = "Forked this conversation. You are now on the fork; the original stays available under /sessions. Your next message continues from the fork point.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
    } catch (error) {
      const message = `Fork failed: ${friendlyErrorText(error)}`;
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: message,
        messageThreadId,
      });
    }
  };

  const resumeClaudeAgentSession = async (
    contextKey: TelegramContextKey,
    session: AgentSessionRecord,
  ): Promise<AgentSessionDescriptor> => {
    if (!claudeAdapter || !session.providerSessionId) {
      throw new Error("Claude session cannot be resumed.");
    }

    const previous = claudeSessions.get(contextKey);
    const descriptor = await claudeAdapter.resumeSession({
      id: `claude-${session.providerSessionId.slice(0, 12)}`,
      provider: "claude",
      workspace: session.workspace,
      displayName: session.displayName,
      providerSessionId: session.providerSessionId,
      status: session.status === "running" ? "running" : "idle",
      capabilities: claudeAdapter.capabilities,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      metadata: { ...session.metadata, backend: getClaudeBackend(contextKey) },
    });
    if (previous && previous.id !== descriptor.id) {
      await disposeClaudeDescriptor(previous);
    }
    claudeSessions.set(contextKey, descriptor);
    persistClaudeSession(contextKey, descriptor);
    return descriptor;
  };

  const forgetClaudeSession = async (contextKey: TelegramContextKey): Promise<void> => {
    const descriptor = claudeSessions.get(contextKey);
    if (descriptor && claudeAdapter) {
      await claudeAdapter.dispose(descriptor.id);
    }
    claudeSessions.delete(contextKey);
    claudeState?.remove(contextKey);
  };

  const pauseActiveGoalForTakeover = async (
    contextKey: TelegramContextKey,
    session: CodexSessionRuntime,
  ): Promise<boolean> => {
    if (!isBusy(contextKey)) {
      if (session.hasActiveThread() && session.getThreadGoal && session.setThreadGoal) {
        try {
          const goal = await session.getThreadGoal();
          if (goal?.status === "active") {
            await session.setThreadGoal({ status: "paused" });
          }
        } catch (error) {
          console.warn("Failed to pause active native goal for session takeover", error);
          return false;
        }
      }
      return true;
    }

    const busyState = getBusyState(contextKey);
    if (busyState.switching || busyState.transcribing) {
      return false;
    }
    if (session.getProcessingKind?.() !== "goal" || !session.pauseActiveGoal) {
      return false;
    }

    try {
      await session.pauseActiveGoal();
      queuedPrompts.delete(contextKey);
      activeProgressRefreshers.delete(contextKey);
      busyState.processing = false;
      return true;
    } catch (error) {
      console.warn("Failed to pause active goal for session takeover", error);
      return false;
    }
  };

  const ensureSessionTakeoverAllowed = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionRuntime,
    blockedMessage: string,
  ): Promise<boolean> => {
    if (await pauseActiveGoalForTakeover(contextKey, session)) {
      return true;
    }

    await safeReply(ctx, escapeHTML(blockedMessage), { fallbackText: blockedMessage });
    return false;
  };

  const getViewedThreadId = (contextKey: TelegramContextKey, session: CodexSessionRuntime): string | null => {
    return inspectedThreads.get(contextKey)?.threadId ?? session.getInfo().threadId;
  };

  const isNativeGoalActive = async (session: CodexSessionRuntime): Promise<boolean> => {
    if (session.getProcessingKind?.() === "goal") {
      return true;
    }
    if (!session.getThreadGoal || !session.hasActiveThread()) {
      return false;
    }
    try {
      return (await session.getThreadGoal())?.status === "active";
    } catch {
      return false;
    }
  };

  const renderThreadInspection = (
    label: string,
    record: CodexThreadRecord,
    options: { parentThreadId?: string; goalIsActive: boolean },
  ): { html: string; plain: string } => {
    const title = cleanSessionTitle(record.title || record.firstUserMessage) || "(untitled)";
    const history = readThreadHistory(record.id, 6);
    const plainLines = [
      label,
      options.goalIsActive ? "Goal keeps running in its current thread." : undefined,
      options.parentThreadId ? `Parent: ${options.parentThreadId.slice(0, 8)}` : undefined,
      `Thread ID: ${record.id}`,
      `Workspace: ${record.cwd}`,
      record.model ? `Model: ${record.model}` : undefined,
      `Updated: ${formatRelativeTime(record.updatedAt)}`,
      `Title: ${title}`,
      "",
      history.length ? "Recent history:" : "No local history entries found for this thread yet.",
      ...history.map((message) => {
        const role = message.role === "assistant" ? "Assistant" : "User";
        return `${role}: ${truncateForHistory(message.text)}`;
      }),
      "",
      options.goalIsActive
        ? `Use /history to refresh this inspection. Use /use ${record.id.slice(0, 8)} to pause the goal and take control.`
        : `Use /use ${record.id.slice(0, 8)} to take control.`,
    ].filter((line): line is string => line !== undefined);

    const htmlLines = [
      `<b>${escapeHTML(label)}</b>`,
      options.goalIsActive ? "Goal keeps running in its current thread." : undefined,
      options.parentThreadId ? `Parent: <code>${escapeHTML(options.parentThreadId.slice(0, 8))}</code>` : undefined,
      `<b>Thread ID:</b> <code>${escapeHTML(record.id)}</code>`,
      `<b>Workspace:</b> <code>${escapeHTML(record.cwd)}</code>`,
      record.model ? `<b>Model:</b> <code>${escapeHTML(record.model)}</code>` : undefined,
      `<b>Updated:</b> ${escapeHTML(formatRelativeTime(record.updatedAt))}`,
      `<b>Title:</b> ${escapeHTML(title)}`,
      "",
      history.length ? "<b>Recent history:</b>" : "No local history entries found for this thread yet.",
      ...history.map((message) => {
        const role = message.role === "assistant" ? "Assistant" : "User";
        return `<b>${role}:</b> ${escapeHTML(truncateForHistory(message.text))}`;
      }),
      "",
      options.goalIsActive
        ? `Use <code>/history</code> to refresh this inspection. Use <code>/use ${escapeHTML(record.id.slice(0, 8))}</code> to pause the goal and take control.`
        : `Use <code>/use ${escapeHTML(record.id.slice(0, 8))}</code> to take control.`,
    ].filter((line): line is string => line !== undefined);

    return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
  };

  const rejectPromptWhileInspecting = async (
    ctx: Context,
    contextKey: TelegramContextKey,
  ): Promise<boolean> => {
    const inspected = inspectedThreads.get(contextKey);
    if (!inspected) {
      return false;
    }

    const thread = getThread(inspected.threadId);
    const label = thread
      ? `${thread.id.slice(0, 8)} ${cleanSessionTitle(thread.title || thread.firstUserMessage) || "(untitled)"}`
      : inspected.threadId.slice(0, 8);
    const text = [
      `You are inspecting ${label} read-only.`,
      "I did not send this as a prompt.",
      `Use /use ${inspected.threadId.slice(0, 8)} to pause the goal and take control of that thread, or /parent to return to the main session view.`,
      "/steer still goes to the active main goal turn when there is one.",
    ].join("\n");
    await safeReply(ctx, formatTelegramHTML(text), { fallbackText: text });
    return true;
  };

  const getContextSession = async (
    ctx: Context,
    options?: { deferThreadStart?: boolean; skipThreadResume?: boolean },
  ): Promise<{ contextKey: TelegramContextKey; session: CodexSessionRuntime } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return null;
    }

    const session = await registry.getOrCreate(contextKey, options);
    return { contextKey, session };
  };

  const updateSessionMetadata = (contextKey: TelegramContextKey, session: CodexSessionRuntime): void => {
    registry.updateMetadata(contextKey, session);
  };

  const isTopicContext = (contextKey: TelegramContextKey): boolean => isTopicContextKey(contextKey);

  const clearLaunchSelectionState = (contextKey: TelegramContextKey): void => {
    pendingLaunchPicks.delete(contextKey);
    pendingLaunchButtons.delete(contextKey);
    pendingUnsafeLaunchConfirmations.delete(contextKey);
  };

  const clearSessionSelectionState = (contextKey: TelegramContextKey): void => {
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);
  };

  const clearChildSelectionState = (contextKey: TelegramContextKey): void => {
    pendingChildPicks.delete(contextKey);
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<TelegramContextKey, KeyboardItem[]>,
    expiredMessage: string,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const ctxKey = contextKeyFromCtx(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
      if (!ctxKey || !messageId || Number.isNaN(page)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const buttons = buttonsMap.get(ctxKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }
      await ctx.answerCallbackQuery();
      try {
        const keyboard = paginateKeyboard(buttons, page, prefix);
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    await safeReply(ctx, escapeHTML("Still working on previous message..."), {
      fallbackText: "Still working on previous message...",
    });
  };

  const queuePromptReply = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionRuntime,
    userInput: CodexPromptInput,
  ): Promise<void> => {
    const replaced = queuedPrompts.has(contextKey);
    queuedPrompts.set(contextKey, { ctx, chatId, session, userInput });
    const text = replaced
      ? "Still working. I replaced the queued message with your latest one. Use /abort if the current task is stuck."
      : "Still working. I queued this message and will run it next. Use /abort if the current task is stuck.";
    await safeReply(ctx, escapeHTML(text), { fallbackText: text });
  };

  const enqueueClaudePromptFromSource = (
    source: ClaudePromptRunSource,
    contextKey: TelegramContextKey,
    text: string,
    options: { kind?: ClaudeQueuedPromptKind; front?: boolean; deliveryFailures?: number } = {},
  ): number => {
    const queuedText = options.kind === "steer"
      ? `Additional instruction for the previous Claude task:\n\n${text}`
      : text;
    const entry: ClaudePromptQueueEntry = {
      id: randomUUID(),
      contextKey,
      chatId: source.chatId,
      messageThreadId: source.messageThreadId ?? parseContextKey(contextKey).messageThreadId,
      text: queuedText,
      queuedAt: Date.now(),
      kind: options.kind ?? "prompt",
      deliveryFailures: options.deliveryFailures,
    };
    const depth = options.front
      ? queuedClaudePrompts.enqueueFront(entry)
      : queuedClaudePrompts.enqueue(entry);
    if (source.ctx) {
      liveQueuedClaudeContexts.set(entry.id, source.ctx);
    }
    return depth;
  };

  const queueClaudePromptReply = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    text: string,
    options: { kind?: ClaudeQueuedPromptKind; front?: boolean } = {},
  ): Promise<void> => {
    const depth = enqueueClaudePromptFromSource({
      ctx,
      chatId,
      messageThreadId: parseContextKey(contextKey).messageThreadId,
    }, contextKey, text, options);
    const replyText = options.kind === "steer"
      ? depth > 1
        ? `Claude is still working. I queued this /steer instruction as Claude follow-up #${depth}.`
        : "Claude is still working. I queued this /steer instruction as a Claude follow-up after the current turn finishes."
      : depth > 1
        ? `Claude is still working. I queued this Claude message as item #${depth}. Use /stop if the current task is stuck.`
        : "Claude is still working. I queued this Claude message and will run it next. Use /stop if the current task is stuck.";
    await safeReply(ctx, escapeHTML(replyText), { fallbackText: replyText });
  };

  const setReaction = async (ctx: Context, emoji: "👀" | "👍" | "❤" | "🔥" | "👏"): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
    } catch {
      // Reactions may not be available in all chats — fail silently.
    }
  };

  const clearReaction = async (ctx: Context): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // Fail silently.
    }
  };

  const replyToClaudeRunSource = async (
    source: ClaudePromptRunSource,
    text: string,
    options: TextOptions = {},
  ): Promise<void> => {
    if (source.ctx) {
      await safeReply(source.ctx, text, {
        ...options,
        messageThreadId: options.messageThreadId ?? source.messageThreadId,
      });
      return;
    }
    const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);
    const chunks = splitTelegramText(text);
    const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];
    for (const [index, chunk] of chunks.entries()) {
      await sendTextMessage(bot.api, source.chatId, chunk, {
        parseMode,
        fallbackText: fallbackChunks[index] ?? chunk,
        replyMarkup: index === 0 ? options.replyMarkup : undefined,
        messageThreadId: source.messageThreadId,
      });
    }
  };

  const routeClaudeSteer = async (
    source: ClaudePromptRunSource,
    contextKey: TelegramContextKey,
    prompt: string,
  ): Promise<void> => {
    const messageThreadId = source.messageThreadId ?? parseContextKey(contextKey).messageThreadId;
    if (isProviderBusy(contextKey, "claude") || getBusyState(contextKey).processing) {
      const descriptor = claudeSessions.get(contextKey);
      if (descriptor && claudeAdapter?.streamInput) {
        try {
          // SDK turns receive priority-now input. PTY turns receive normal typed
          // input, which Claude applies at its next safe interaction boundary.
          await claudeAdapter.streamInput(descriptor.id, { text: prompt });
          const sent = "Steer sent to the active Claude turn.";
          await replyToClaudeRunSource(source, escapeHTML(sent), { fallbackText: sent, messageThreadId });
          return;
        } catch (error) {
          bridgeLog("steer", `live Claude steer failed lane=${contextKey}: ${String(error)}`);
        }
      }

      if (source.ctx) {
        await queueClaudePromptReply(source.ctx, contextKey, source.chatId, prompt, { kind: "steer" });
      } else {
        enqueueClaudePromptFromSource(source, contextKey, prompt, { kind: "steer" });
      }
      return;
    }

    if (source.ctx) {
      pendingIdleSteers.set(contextKey, {
        text: prompt,
        provider: "claude",
        expiresAt: Date.now() + IDLE_STEER_CONFIRM_TTL_MS,
      });
      const message = "No Claude turn is running. Reply y to start a new turn with this steer text, or n to discard it.";
      await replyToClaudeRunSource(source, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }

    const message = "No Claude turn is running, so this steer instruction was not sent.";
    await replyToClaudeRunSource(source, escapeHTML(message), { fallbackText: message, messageThreadId });
  };

  const setClaudeRunReaction = async (
    source: ClaudePromptRunSource,
    emoji: Parameters<typeof setReaction>[1],
  ): Promise<void> => {
    if (source.ctx) {
      await setReaction(source.ctx, emoji);
    }
  };

  const clearClaudeRunReaction = async (source: ClaudePromptRunSource): Promise<void> => {
    if (source.ctx) {
      await clearReaction(source.ctx);
    }
  };

  const ensureActiveThread = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionRuntime,
  ): Promise<boolean> => {
    if (session.hasActiveThread()) {
      return true;
    }

    try {
      await session.newThread();
      updateSessionMetadata(contextKey, session);
      clearSessionSelectionState(contextKey);
      return true;
    } catch (error) {
      await safeReply(ctx, escapeHTML(`Failed to create thread: ${friendlyErrorText(error)}`), {
        fallbackText: `Failed to create thread: ${friendlyErrorText(error)}`,
      });
      return false;
    }
  };

  const handleUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionRuntime,
    userInput: CodexPromptInput,
    options: {
      execute?: (callbacks: CodexSessionCallbacks) => Promise<void>;
      finalizeOnAgentEnd?: boolean;
      addOutputInstructions?: boolean;
    } = {},
  ): Promise<void> => {
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;
    const getProgressDelivery = (): ProgressDelivery => registry.getProgressDelivery(contextKey);
    const shouldStreamAssistantText = (): boolean =>
      config.streamAssistantText && getProgressDelivery() === "messages" && !shouldHoldFinalResponse(userInput);
    const finalizeOnAgentEnd = options.finalizeOnAgentEnd ?? true;
    const addOutputInstructionsToPrompt = options.addOutputInstructions ?? true;

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.processing = true;
    markProviderBusy(contextKey, "codex", true);

    const abortKeyboard = new InlineKeyboard().text("⏹ Abort", `codex_abort:${contextKey}`);
    const toolVerbosity: ToolVerbosity = config.toolVerbosity;
    const toolStates = new Map<string, ToolState>();
    const toolCounts = new Map<string, number>();
    const recentProgressLines: string[] = [];
    const recentAssistantProgress: string[] = [];
    let accumulatedText = "";
    let pendingStreamText = "";
    let finalAnswerText = "";
    let sentResponseText = false;
    let responseMessageId: number | undefined;
    let responseMessagePromise: Promise<void> | undefined;
    let lastRenderedText = "";
    let lastEditAt = Date.now();
    let flushTimer: NodeJS.Timeout | undefined;
    let progressTimer: NodeJS.Timeout | undefined;
    let lastProgressEditAt = 0;
    let lastProgressText = "";
    let progressUpdateInFlight = false;
    let pendingProgress: RenderedText | undefined;
    let lastAssistantProgressText = "";
    let isFlushing = false;
    let flushPending = false;
    let finalized = false;
    let finalizationPromise: Promise<void> | undefined;
    let planMessageId: number | undefined;
    let lastRenderedPlan = "";
    let planMessageSending = false;
    let lastTurnUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
    let autoArtifactOutDir: string | undefined;
    const announcedChildThreads = new Set<string>();
    let codexAgentSession: AgentSessionRecord | undefined;
    let agentJobId: string | undefined;
    let completedSuccessfully = false;
    let backgroundCompletionText: string | undefined;
    const finalDelivery = { disposition: "none" as "none" | "foreground" | "buffered" };

    const isCodexForeground = (): boolean => isProviderForeground(contextKey, "codex");
    const bufferCodexOutput = (
      kind: BufferedOutputEvent["kind"],
      outputText: string,
      priority?: boolean,
      artifactPath?: string,
    ): void => {
      if (!codexAgentSession || (!outputText.trim() && !artifactPath)) {
        return;
      }

      outputBuffer.append(codexAgentSession.id, {
        kind,
        text: outputText,
        artifactPath,
        priority,
        metadata: { provider: "codex" },
      });
    };
    const sendCodexTyping = (): void => {
      if (!isCodexForeground()) {
        return;
      }
      void bot.api
        .sendChatAction(chatId, "typing", {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        })
        .catch(() => {});
    };

    const typingInterval = setInterval(sendCodexTyping, TYPING_INTERVAL_MS);
    sendCodexTyping();

    const stopTyping = (): void => {
      clearInterval(typingInterval);
    };

    const clearFlushTimer = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };

    const clearProgressTimer = (): void => {
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = undefined;
      }
    };

    const recordProgressLine = (line: string): void => {
      const trimmed = trimProgressToolName(line);
      if (!trimmed) {
        return;
      }
      recentProgressLines.push(trimmed);
      if (recentProgressLines.length > SUMMARY_PROGRESS_RECENT_LIMIT) {
        recentProgressLines.splice(0, recentProgressLines.length - SUMMARY_PROGRESS_RECENT_LIMIT);
      }
    };

    const recordAssistantProgress = (text: string): void => {
      // Narration content is never truncated or flattened; the renderer budgets
      // whole blocks and the call sites divert oversized blocks to full messages.
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      recentAssistantProgress.push(trimmed);
      if (recentAssistantProgress.length > SUMMARY_PROGRESS_RECENT_LIMIT) {
        recentAssistantProgress.splice(0, recentAssistantProgress.length - SUMMARY_PROGRESS_RECENT_LIMIT);
      }
    };

    const announceChildThreads = async (event: {
      toolName: string;
      threadIds: string[];
      prompt?: string;
    }): Promise<void> => {
      const newThreadIds = event.threadIds.filter((threadId) => {
        if (announcedChildThreads.has(threadId)) {
          return false;
        }
        announcedChildThreads.add(threadId);
        return true;
      });
      if (newThreadIds.length === 0) {
        return;
      }

      const lines = [
        `Goal spawned ${newThreadIds.length === 1 ? "a child session" : "child sessions"} for ${event.toolName}.`,
        ...newThreadIds.map((threadId) => `- ${threadId.slice(0, 8)}: /follow ${threadId.slice(0, 8)} or /use ${threadId.slice(0, 8)}`),
        "Use /children to list child sessions, /follow latest to switch to the newest child, and /parent to return.",
        event.prompt ? `Prompt: ${trimLine(event.prompt, 280)}` : "",
      ].filter(Boolean);
      const plain = lines.join("\n");
      if (!isCodexForeground()) {
        bufferCodexOutput("status", plain, false);
        return;
      }

      await sendTextMessage(bot.api, chatId, lines.map((line) => escapeHTML(line)).join("\n"), {
        parseMode: "HTML",
        fallbackText: plain,
        messageThreadId,
      });
    };

    const extractStreamParts = (force = false): string[] => {
      const parts: string[] = [];

      while (pendingStreamText.trim()) {
        let cut = -1;

        if (force) {
          cut = pendingStreamText.length;
        } else {
          const paragraph = pendingStreamText.match(/\n\s*\n/);
          if (paragraph?.index !== undefined) {
            cut = paragraph.index + paragraph[0].length;
          } else if (pendingStreamText.length >= STREAM_MESSAGE_TARGET) {
            const windowText = pendingStreamText.slice(0, STREAM_MESSAGE_TARGET);
            cut = Math.max(
              windowText.lastIndexOf("\n"),
              windowText.lastIndexOf(". "),
              windowText.lastIndexOf("? "),
              windowText.lastIndexOf("! "),
              windowText.lastIndexOf("; "),
              windowText.lastIndexOf(", "),
              windowText.lastIndexOf(" "),
            );
            cut = cut < STREAM_MESSAGE_TARGET / 2 ? STREAM_MESSAGE_TARGET : cut + 1;
          }
        }

        if (cut <= 0) {
          break;
        }

        const part = pendingStreamText.slice(0, cut).trim();
        pendingStreamText = pendingStreamText.slice(cut).replace(/^\s+/, "");
        if (part) {
          parts.push(part);
        }

        if (!force && pendingStreamText.length < STREAM_MESSAGE_TARGET) {
          break;
        }
      }

      return parts;
    };

    const buildFooterText = (): string => {
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        return usageLine;
      }

      if (toolVerbosity === "all") {
        return usageLine;
      }

      return "";
    };

    const buildFinalResponseText = (text: string): string => {
      const trimmedText = text.trim();
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        const footerLines = [usageLine].filter((line): line is string => Boolean(line));
        if (footerLines.length === 0) {
          return trimmedText;
        }

        const footer = footerLines.join("\n");
        return trimmedText ? `${trimmedText}\n\n${footer}` : footer;
      }

      if (toolVerbosity === "all" && usageLine) {
        return trimmedText ? `${trimmedText}\n\n${usageLine}` : usageLine;
      }

      return trimmedText;
    };

    const ensureResponseMessage = async (): Promise<void> => {
      if (!isCodexForeground()) {
        return;
      }
      if (responseMessageId) {
        return;
      }
      if (responseMessagePromise) {
        await responseMessagePromise;
        return;
      }

      responseMessagePromise = (async () => {
        stopTyping();
        const placeholder = renderMarkdownChunkWithinLimit("Working...");
        const message = await sendTextMessage(bot.api, chatId, placeholder.text, {
          parseMode: placeholder.parseMode,
          fallbackText: placeholder.fallbackText,
          replyMarkup: abortKeyboard,
          messageThreadId,
        });
        responseMessageId = message.message_id;
        lastRenderedText = placeholder.text;
        lastEditAt = Date.now();
      })();

      try {
        await responseMessagePromise;
      } finally {
        responseMessagePromise = undefined;
      }
    };

    const flushResponse = async (force = false): Promise<void> => {
      if (getProgressDelivery() !== "messages") {
        return;
      }
      if (!pendingStreamText) {
        return;
      }
      if (!isCodexForeground()) {
        for (const part of extractStreamParts(force)) {
          bufferCodexOutput("assistant", part, false);
        }
        return;
      }
      if (isFlushing) {
        flushPending = true;
        return;
      }

      const now = Date.now();
      const updateDelay = sentResponseText ? INTERMEDIATE_UPDATE_MIN_MS : FIRST_INTERMEDIATE_UPDATE_MS;
      if (!force && now - lastEditAt < updateDelay) {
        return;
      }

      const streamParts = extractStreamParts(force);
      if (streamParts.length === 0) {
        return;
      }

      isFlushing = true;
      try {
        stopTyping();
        for (const part of streamParts) {
          const chunks = splitMarkdownForTelegram(part);
          for (const chunk of chunks) {
            await sendTextMessage(bot.api, chatId, chunk.text, {
              parseMode: chunk.parseMode,
              fallbackText: chunk.fallbackText,
              messageThreadId,
            });
            sentResponseText = true;
          }
        }
        lastEditAt = Date.now();
      } finally {
        isFlushing = false;
        if (flushPending) {
          flushPending = false;
          scheduleFlush();
        }
      }
    };

    const scheduleFlush = (): void => {
      if (flushTimer || finalized || getProgressDelivery() !== "messages") {
        return;
      }

      const updateDelay = sentResponseText ? INTERMEDIATE_UPDATE_MIN_MS : FIRST_INTERMEDIATE_UPDATE_MS;
      const delay = Math.max(0, updateDelay - (Date.now() - lastEditAt));
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushResponse().catch((error) => {
          console.error("Failed to update Telegram response message", error);
        });
      }, delay);
    };

    const sendProgressUpdate = async (rendered: RenderedText): Promise<void> => {
      const progressDelivery = getProgressDelivery();
      if (finalized || progressDelivery === "none" || rendered.text === lastProgressText) {
        return;
      }
      if (!isCodexForeground()) {
        bufferCodexOutput("status", rendered.fallbackText ?? rendered.text, false);
        lastProgressText = rendered.text;
        lastProgressEditAt = Date.now();
        return;
      }

      if (progressUpdateInFlight) {
        pendingProgress = rendered;
        return;
      }

      const now = Date.now();
      const progressUpdateMinMs =
        progressDelivery === "edit" ? EDIT_DEBOUNCE_MS : SUMMARY_PROGRESS_UPDATE_MIN_MS;
      if (lastProgressEditAt && now - lastProgressEditAt < progressUpdateMinMs) {
        pendingProgress = rendered;
        if (!progressTimer) {
          const delay = Math.max(0, progressUpdateMinMs - (now - lastProgressEditAt));
          progressTimer = setTimeout(() => {
            progressTimer = undefined;
            const next = pendingProgress;
            pendingProgress = undefined;
            if (next) {
              void sendProgressUpdate(next).catch((error) => {
                console.error("Failed to send progress update", error);
              });
            }
          }, delay);
        }
        return;
      }

      progressUpdateInFlight = true;
      try {
        stopTyping();
        if (progressDelivery === "messages") {
          await sendTextMessage(bot.api, chatId, rendered.text, {
            parseMode: rendered.parseMode,
            fallbackText: rendered.fallbackText,
            messageThreadId,
          });
        } else if (!responseMessageId) {
          const message = await sendTextMessage(bot.api, chatId, rendered.text, {
            parseMode: rendered.parseMode,
            fallbackText: rendered.fallbackText,
            replyMarkup: abortKeyboard,
            messageThreadId,
          });
          responseMessageId = message.message_id;
        } else {
          await safeEditMessage(bot, chatId, responseMessageId, rendered.text, {
            parseMode: rendered.parseMode,
            fallbackText: rendered.fallbackText,
            replyMarkup: abortKeyboard,
          });
        }
        lastProgressText = rendered.text;
        lastRenderedText = rendered.text;
        lastProgressEditAt = Date.now();
        lastEditAt = lastProgressEditAt;
      } finally {
        progressUpdateInFlight = false;
        if (pendingProgress && !progressTimer) {
          const next = pendingProgress;
          pendingProgress = undefined;
          void sendProgressUpdate(next).catch((error) => {
            console.error("Failed to send queued progress update", error);
          });
        }
      }
    };

    const removeAbortKeyboard = async (): Promise<void> => {
      if (!responseMessageId) {
        return;
      }

      try {
        await bot.api.editMessageReplyMarkup(chatId, responseMessageId, {
          reply_markup: new InlineKeyboard(),
        });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error("Failed to clear Abort button", error);
        }
      }
    };

    const deliverRenderedChunks = async (
      chunks: RenderedChunk[],
      kind: BufferedOutputEvent["kind"] = "assistant",
      priority?: boolean,
    ): Promise<void> => {
      if (chunks.length === 0) {
        return;
      }

      if (!isCodexForeground()) {
        const text = chunks.map((chunk) => chunk.fallbackText ?? chunk.text).join("\n\n").trim();
        bufferCodexOutput(kind, text, priority);
        if (kind === "final" || kind === "error") {
          finalDelivery.disposition = "buffered";
        }
        return;
      }

      const [firstChunk, ...remainingChunks] = chunks;
      if (responseMessageId) {
        await sendTextMessage(bot.api, chatId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
          messageThreadId,
        });
        await removeAbortKeyboard();
      } else {
        const message = await sendTextMessage(bot.api, chatId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
          messageThreadId,
        });
        responseMessageId = message.message_id;
      }

      for (const chunk of remainingChunks) {
        await sendTextMessage(bot.api, chatId, chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          messageThreadId,
        });
      }
      if (kind === "final" || kind === "error") {
        finalDelivery.disposition = "foreground";
      }
    };

    const deliverFinalMarkdown = async (
      markdown: string,
      kind: BufferedOutputEvent["kind"] = "assistant",
      priority?: boolean,
    ): Promise<void> => {
      await deliverRenderedChunks(splitMarkdownForTelegram(markdown), kind, priority);
    };

    const refreshAssistantProgress = async (): Promise<void> => {
      if (getProgressDelivery() !== "edit") {
        return;
      }
      if (!isCodexForeground()) {
        return;
      }
      const text = pendingStreamText.trim();
      if (!text || text === lastAssistantProgressText) {
        return;
      }
      lastAssistantProgressText = text;
      accumulatedText = "";
      pendingStreamText = "";

      if (isOversizedProgressBlock(text)) {
        // The block alone exceeds the rolling-message budget. Freeze the current
        // progress message, deliver the block in full as ordinary messages, and let
        // subsequent lines start a fresh rolling message below it. Content is never cut.
        recentAssistantProgress.length = 0;
        if (responseMessageId) {
          await removeAbortKeyboard();
          responseMessageId = undefined;
        }
        lastProgressText = "";
        for (const chunk of splitMarkdownForTelegram(text)) {
          await sendTextMessage(bot.api, chatId, chunk.text, {
            parseMode: chunk.parseMode,
            fallbackText: chunk.fallbackText,
            messageThreadId,
          });
        }
        return;
      }

      recordAssistantProgress(text);
      await sendProgressUpdate(renderAssistantProgressMessage(recentAssistantProgress));
    };
    activeProgressRefreshers.set(contextKey, refreshAssistantProgress);

    const deliverIntermediateAssistantText = async (): Promise<void> => {
      const progressDelivery = getProgressDelivery();
      const text = accumulatedText.trim();
      if (!text || progressDelivery === "none") {
        return;
      }
      if (!isCodexForeground()) {
        accumulatedText = "";
        pendingStreamText = "";
        bufferCodexOutput("assistant", text, false);
        return;
      }

      if (progressDelivery === "messages") {
        accumulatedText = "";
        pendingStreamText = "";
        await deliverFinalMarkdown(text);
        return;
      }

      if (progressDelivery === "edit") {
        await refreshAssistantProgress();
      }
    };

    const deliverPendingProgressBeforeFinal = async (): Promise<void> => {
      if (!finalAnswerText.trim() || !pendingStreamText.trim()) {
        return;
      }

      const progressDelivery = getProgressDelivery();
      if (progressDelivery === "messages") {
        await flushResponse(true);
      } else if (progressDelivery === "edit") {
        await refreshAssistantProgress();
      }

      accumulatedText = "";
      pendingStreamText = "";
    };

    const finalizeResponse = async (): Promise<void> => {
      if (finalized) {
        return;
      }
      finalized = true;

      stopTyping();
      clearFlushTimer();
      clearProgressTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // If the initial send failed, we will fall back to sending the final response below.
        }
      }

      await deliverPendingProgressBeforeFinal();

      const finalSourceText = finalAnswerText.trim() ? finalAnswerText : pendingStreamText;
      const rememberedText = finalAnswerText.trim() ? finalAnswerText : accumulatedText;
      if (codexAgentSession) {
        lastAssistantReplyBySessionId.set(codexAgentSession.id, buildFinalResponseText(rememberedText));
      }
      const finalUndeliveredText = buildFinalResponseText(finalSourceText);
      if (finalUndeliveredText) {
        pendingStreamText = "";
        finalAnswerText = "";
        if (isCodexForeground() && getProgressDelivery() === "edit" && responseMessageId && !sentResponseText) {
          const completed = renderProgressCompletedMessage();
          await safeEditMessage(bot, chatId, responseMessageId, completed.text, {
            parseMode: completed.parseMode,
            fallbackText: completed.fallbackText,
            replyMarkup: new InlineKeyboard(),
          }).catch((error) => {
            console.error("Failed to complete progress message", error);
          });
        }
        await deliverFinalMarkdown(finalUndeliveredText, "final", true);
        sentResponseText = true;
      }

      if (!sentResponseText) {
        if (!isCodexForeground()) {
          bufferCodexOutput("status", "Codex finished without text.", true);
          return;
        }

        const html = "<b>✅ Done</b>";
        const plainText = "✅ Done";

        if (responseMessageId) {
          await safeEditMessage(bot, chatId, responseMessageId, html, { fallbackText: plainText });
          await removeAbortKeyboard();
        } else {
          await safeReply(ctx, html, { fallbackText: plainText });
        }
        return;
      }

    };

    const requestFinalization = (): Promise<void> => {
      finalizationPromise ??= finalizeResponse();
      return finalizationPromise;
    };

    const callbacks: CodexSessionCallbacks = {
      onTextDelta: (delta: string, metadata) => {
        const phase = metadata?.phase ?? null;
        if (phase === "final_answer" || phase === "final") {
          finalAnswerText += delta;
          return;
        }
        accumulatedText += delta;
        pendingStreamText += delta;
        if (shouldStreamAssistantText()) {
          scheduleFlush();
        }
      },
      onToolStart: (toolName: string, toolCallId: string) => {
        const streamAssistantText = shouldStreamAssistantText();
        if (streamAssistantText && pendingStreamText.trim()) {
          void flushResponse(true).catch((error) => {
            console.error("Failed to flush assistant progress before tool start", error);
          });
        } else if (!streamAssistantText && pendingStreamText.trim()) {
          void deliverIntermediateAssistantText().catch((error) => {
            console.error("Failed to deliver assistant progress before tool start", error);
          });
        }

        const progressDelivery = getProgressDelivery();
        if (progressDelivery === "none" || toolVerbosity === "none") {
          return;
        }

        if (progressDelivery === "edit") {
          return;
        }

        toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
        recordProgressLine(`Started ${toolName}`);

        if (toolVerbosity === "summary") {
          // Summary mode is deliberately quiet during the turn. It records tool
          // activity for internal accounting without sending "Working: bash"
          // chatter as separate Telegram messages.
          return;
        }

        toolStates.set(toolCallId, { toolName, partialResult: "" });

        if (toolVerbosity !== "all") {
          return;
        }

        const messageText = renderToolStartMessage(toolName);
        if (!isCodexForeground()) {
          bufferCodexOutput("tool", messageText.fallbackText, false);
          return;
        }

        void (async () => {
          const message = await sendTextMessage(bot.api, chatId, messageText.text, {
            parseMode: messageText.parseMode,
            fallbackText: messageText.fallbackText,
            messageThreadId,
          });
          const state = toolStates.get(toolCallId);
          if (!state) {
            return;
          }

          state.messageId = message.message_id;
          if (state.finalStatus) {
            await safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
              parseMode: state.finalStatus.parseMode,
              fallbackText: state.finalStatus.fallbackText,
            });
          }
        })().catch((error) => {
          console.error(`Failed to send tool start message for ${toolName}`, error);
        });
      },
      onToolUpdate: (toolCallId: string, partialResult: string) => {
        if (getProgressDelivery() !== "messages") {
          return;
        }

        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state || !partialResult) {
          return;
        }

        state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
      },
      onToolEnd: (toolCallId: string, isError: boolean) => {
        const progressDelivery = getProgressDelivery();
        if (progressDelivery === "none" || toolVerbosity === "none") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }

        if (progressDelivery === "edit") {
          return;
        }

        if (toolVerbosity === "summary") {
          return;
        }

        state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
        if (toolVerbosity === "errors-only") {
          if (!isError) {
            return;
          }

          if (!isCodexForeground()) {
            bufferCodexOutput("tool", state.finalStatus.fallbackText, true);
            return;
          }

          void sendTextMessage(bot.api, chatId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
            messageThreadId,
          }).catch((error) => {
            console.error(`Failed to send tool error message for ${state.toolName}`, error);
          });
          return;
        }

        if (!isCodexForeground()) {
          bufferCodexOutput("tool", state.finalStatus.fallbackText, isError);
          return;
        }

        if (!state.messageId) {
          return;
        }

        void safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        }).catch((error) => {
          console.error(`Failed to update tool message for ${state.toolName}`, error);
        });
      },
      onChildThreads: (event) => {
        recordProgressLine(`Child sessions: ${event.threadIds.map((id) => id.slice(0, 8)).join(", ")}`);
        void announceChildThreads(event).catch((error) => {
          console.error("Failed to announce child sessions", error);
        });
      },
      onTodoUpdate: (items) => {
        const progressDelivery = getProgressDelivery();
        if (toolVerbosity === "none" || progressDelivery === "none") {
          return;
        }

        if (progressDelivery === "edit") {
          return;
        }

        const rendered = renderTodoList(items);
        if (rendered === lastRenderedPlan) {
          return;
        }

        lastRenderedPlan = rendered;
        if (!isCodexForeground()) {
          bufferCodexOutput("status", rendered, false);
          return;
        }

        if (!planMessageId) {
          if (planMessageSending) return;
          planMessageSending = true;
          void sendTextMessage(bot.api, chatId, rendered, { parseMode: "HTML", messageThreadId })
            .then((msg) => {
              planMessageId = msg.message_id;
            })
            .catch((err) => {
              console.error("Failed to send plan message", err);
            })
            .finally(() => {
              planMessageSending = false;
            });
        } else {
          void safeEditMessage(bot, chatId, planMessageId, rendered, { parseMode: "HTML" }).catch((err) => {
            console.error("Failed to update plan message", err);
          });
        }
      },
      onTurnComplete: (usage) => {
        lastTurnUsage = usage;
      },
      onAgentEnd: () => {
        if (finalizeOnAgentEnd) {
          void requestFinalization().catch((error) => {
            console.error("Failed to finalize Telegram response message", error);
          });
        } else {
          void deliverIntermediateAssistantText().catch((error) => {
            console.error("Failed to deliver intermediate goal response", error);
          });
        }
      },
    };

    try {
      const authStatus = await checkAuthStatus(config.codexApiKey);
      if (!authStatus.authenticated) {
        await safeReply(
          ctx,
          [
            "<b>⚠️ Codex is not authenticated.</b>",
            "",
            `<code>${escapeHTML(authStatus.detail)}</code>`,
            "",
            "Use /login to start authentication, or set CODEX_API_KEY on the host.",
          ].join("\n"),
          {
            fallbackText: [
              "⚠️ Codex is not authenticated.",
              "",
              authStatus.detail,
              "",
              "Use /login to start authentication, or set CODEX_API_KEY on the host.",
            ].join("\n"),
          },
        );
        return;
      }

      if (!(await ensureActiveThread(ctx, contextKey, session))) {
        return;
      }

      const promptInput = !addOutputInstructionsToPrompt || userInputHasOutputInstructions(userInput)
        ? userInput
        : await (async (): Promise<CodexPromptInput> => {
            const turnId = randomUUID().slice(0, 12);
            autoArtifactOutDir = outboxPath(session.getCurrentWorkspace(), turnId);
            await ensureOutDir(autoArtifactOutDir);
            return addOutputInstructions(userInput, autoArtifactOutDir);
          })();

      const infoBeforePrompt = session.getInfo();
      const agentSession = ensureAgentSessionRecord(contextKey, "codex", {
        workspace: infoBeforePrompt.workspace,
        displayName: resolveCodexSessionDisplayName(infoBeforePrompt.threadId, "Codex"),
        providerSessionId: infoBeforePrompt.threadId ?? undefined,
        select: isProviderForeground(contextKey, "codex"),
        metadata: {
          model: infoBeforePrompt.model,
          reasoningEffort: infoBeforePrompt.reasoningEffort,
          backend: registry.getBackend(contextKey),
        },
      });
      codexAgentSession = agentSession;
      agentJobId = `codex-job-${randomUUID().slice(0, 12)}`;
      startAgentJob(agentSession.id, agentJobId);

      if (options.execute) {
        await options.execute(callbacks);
      } else {
        await session.prompt(promptInput, callbacks);
      }
      updateSessionMetadata(contextKey, session);
      await requestFinalization();
      backgroundCompletionText = codexAgentSession
        ? lastAssistantReplyBySessionId.get(codexAgentSession.id) ?? "Codex finished."
        : "Codex finished.";
      completedSuccessfully = true;
    } catch (error) {
      stopTyping();
      clearFlushTimer();
      clearProgressTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // Ignore; we will send an error message below.
        }
      }

      if (finalized) {
        console.error("Codex prompt error after finalization:", formatError(error));
      } else {
        finalized = true;

        const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
        backgroundCompletionText = combinedText;
        try {
          await deliverFinalMarkdown(combinedText, "error", true);
        } catch (telegramError) {
          console.error("Failed to send error message to Telegram:", telegramError);
        }
      }
    } finally {
      stopTyping();
      clearFlushTimer();
      if (autoArtifactOutDir) {
        try {
          if (isCodexForeground()) {
            await deliverArtifacts(ctx, chatId, autoArtifactOutDir, messageThreadId);
          } else {
            const { artifacts, skippedCount } = await collectArtifactReport(autoArtifactOutDir);
            const summary = formatArtifactSummary(artifacts, skippedCount);
            if (summary) {
              bufferCodexOutput("status", summary, artifacts.length > 0 || skippedCount > 0);
            }
            for (const artifact of artifacts) {
              bufferCodexOutput("artifact", artifact.name, true, artifact.localPath);
            }
            if (skippedCount > 0) {
              bufferCodexOutput("status", `${skippedCount} generated file${skippedCount === 1 ? "" : "s"} too large to send.`, true);
            }
          }
        } catch (artifactError) {
          console.error("Failed to deliver artifacts:", artifactError);
        }
      }
      if (codexAgentSession && backgroundCompletionText && finalDelivery.disposition === "buffered") {
        try {
          const delivered = isCodexForeground()
            ? await (async (): Promise<boolean> => {
                await deliverFinalMarkdown(
                  backgroundCompletionText,
                  completedSuccessfully ? "final" : "error",
                  true,
                );
                return true;
              })()
            : await sendBackgroundCompletionNotice(
                ctx,
                contextKey,
                codexAgentSession,
                backgroundCompletionText,
                messageThreadId,
              );
          if (delivered) {
            clearDeliveredCompletionFromBuffer(codexAgentSession.id, backgroundCompletionText);
          }
        } catch (noticeError) {
          console.error("Failed to send Codex background completion notice:", noticeError);
        }
      } else if (codexAgentSession && backgroundCompletionText && finalDelivery.disposition === "foreground") {
        clearDeliveredCompletionFromBuffer(codexAgentSession.id, backgroundCompletionText);
      }
      activeProgressRefreshers.delete(contextKey);
      if (agentJobId) {
        finishAgentJob(agentJobId, completedSuccessfully ? "completed" : "failed");
      }
      markProviderBusy(contextKey, "codex", false);
      busyState.processing = false;
    }
  };

  const startUserPrompt = (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionRuntime,
    userInput: CodexPromptInput,
    options: {
      execute?: (callbacks: CodexSessionCallbacks) => Promise<void>;
      finalizeOnAgentEnd?: boolean;
      addOutputInstructions?: boolean;
      setSuccessReaction?: boolean;
      onFinally?: () => Promise<void>;
    } = {},
  ): void => {
    const setSuccessReaction = options.setSuccessReaction ?? true;

    void (async () => {
      try {
        await handleUserPrompt(ctx, contextKey, chatId, session, userInput, {
          execute: options.execute,
          finalizeOnAgentEnd: options.finalizeOnAgentEnd,
          addOutputInstructions: options.addOutputInstructions,
        });
        if (setSuccessReaction) {
          await setReaction(ctx, "👍");
        }
      } catch (error) {
        console.error("Prompt task failed:", error);
        await clearReaction(ctx);
      } finally {
        if (options.onFinally) {
          try {
            await options.onFinally();
          } catch (cleanupError) {
            console.error("Prompt cleanup failed:", cleanupError);
          }
        }

        const queued = queuedPrompts.get(contextKey);
        if (queued) {
          queuedPrompts.delete(contextKey);
          await setReaction(queued.ctx, "👀");
          startUserPrompt(queued.ctx, contextKey, queued.chatId, queued.session, queued.userInput);
        }
      }
    })();
  };

  const handleClaudePrompt = async (
    source: ClaudePromptRunSource,
    contextKey: TelegramContextKey,
    text: string,
  ): Promise<void> => {
    const messageThreadId = source.messageThreadId ?? parseContextKey(contextKey).messageThreadId;
    const steerPrompt = parseSteerCommandText(text);
    if (steerPrompt !== undefined) {
      if (!steerPrompt) {
        const usage = "Usage: /steer <instruction>";
        await replyToClaudeRunSource(source, escapeHTML(usage), { fallbackText: usage, messageThreadId });
      } else {
        // Defensive routing for restored or externally injected Telegram updates:
        // never paste the Telegram /steer command itself into Claude Code.
        await routeClaudeSteer(source, contextKey, steerPrompt);
      }
      return;
    }
    const busyState = getBusyState(contextKey);
    bridgeLog("intake", `message received lane=${contextKey} chars=${text.length}`);

    if (claudeIntakeLocks.get(contextKey)) {
      bridgeLog("intake", `queued (intake lock held) lane=${contextKey}`);
      if (source.ctx) {
        lastPromptInput.set(contextKey, text);
        await queueClaudePromptReply(source.ctx, contextKey, source.chatId, text);
      } else {
        enqueueClaudePromptFromSource(source, contextKey, text, { front: true });
      }
      return;
    }

    let claimedBusy = false;
    claudeIntakeLocks.set(contextKey, true);
    try {
      if (busyState.switching || busyState.transcribing) {
        if (source.ctx) {
          await sendBusyReply(source.ctx);
        } else {
          const message = "Still working on previous message...";
          await replyToClaudeRunSource(source, escapeHTML(message), { fallbackText: message, messageThreadId });
        }
        return;
      }
      if (isProviderBusy(contextKey, "claude")) {
        bridgeLog("intake", `queued (provider busy) lane=${contextKey} depth=${queuedClaudePrompts.depth(contextKey) + 1}`);
        if (source.ctx) {
          lastPromptInput.set(contextKey, text);
          await queueClaudePromptReply(source.ctx, contextKey, source.chatId, text);
        } else {
          enqueueClaudePromptFromSource(source, contextKey, text, { front: true });
        }
        return;
      }
      busyState.processing = true;
      markProviderBusy(contextKey, "claude", true);
      claimedBusy = true;
      bridgeLog("intake", `dispatched lane=${contextKey}`);
    } finally {
      claudeIntakeLocks.delete(contextKey);
    }

    const turnStartedAt = Date.now();
    const releaseClaimedBusy = (): void => {
      if (!claimedBusy) {
        return;
      }
      markProviderBusy(contextKey, "claude", false);
      busyState.processing = false;
      claimedBusy = false;
    };

    if (!claudeAdapter) {
      releaseClaimedBusy();
      const message = "Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.";
      await replyToClaudeRunSource(source, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }
    const embeddedCommand = findEmbeddedClaudeCommandLine(text);
    if (embeddedCommand && !isStandaloneClaudeDispatchPrompt(text)) {
      releaseClaimedBusy();
      const message = [
        `I did not send this to Claude because it contains ${embeddedCommand} on its own line.`,
        "Send the text first, then send the command as a separate Telegram message.",
      ].join("\n");
      await replyToClaudeRunSource(source, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }

    const typingInterval = setInterval(() => {
      if (!isProviderForeground(contextKey, "claude")) {
        return;
      }
      void bot.api.sendChatAction(source.chatId, "typing", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      }).catch(() => {});
    }, TYPING_INTERVAL_MS);

    let finalText = "";
    let streamedText = "";
    let pendingAssistantProgressText = "";
    let sentAssistantProgress = false;
    // The last interim assistant block, still held (not yet streamed) when the turn ends.
    // When narration was streamed as its own messages, this is the only piece of the final
    // answer not yet delivered, so it becomes the final delivery instead of re-posting the
    // whole answer on top of the narration.
    let finalAssistantBlock = "";
    let progressMessageId: number | undefined;
    // Rolling window of recent Claude narration lines, mirroring the Codex progress buffer.
    const recentClaudeProgress: string[] = [];
    let descriptor: AgentSessionDescriptor | undefined;
    let claudeAgentSession: AgentSessionRecord | undefined;
    let agentJobId: string | undefined;
    let completedSuccessfully = false;
    let deferQueuedDispatch = false;
    let sawAssistantCompletion = false;
    let providerTurnError: string | undefined;

    const bufferClaudeOutput = (
      kind: BufferedOutputEvent["kind"],
      outputText: string,
      priority?: boolean,
      artifactPath?: string,
    ): void => {
      if (!descriptor || !outputText.trim()) {
        return;
      }
      outputBuffer.append(claudeAgentSession?.id ?? descriptor.id, {
        kind,
        text: outputText,
        priority,
        artifactPath,
        metadata: { provider: "claude" },
      });
    };

    // Per-turn outbox for generated files, mirroring the Codex artifact flow: the
    // prompt tells Claude where to write user-facing files, and the turn's finally
    // block delivers whatever landed there. Undefined for slash-command turns.
    let claudeArtifactOutDir: string | undefined;

    const deliverClaudeArtifacts = async (): Promise<void> => {
      if (!claudeArtifactOutDir) {
        return;
      }
      const { artifacts, skippedCount } = await collectArtifactReport(claudeArtifactOutDir);
      if (artifacts.length === 0 && skippedCount === 0) {
        return;
      }
      if (!isProviderForeground(contextKey, "claude")) {
        const summary = formatArtifactSummary(artifacts, skippedCount);
        if (summary) {
          bufferClaudeOutput("status", summary, artifacts.length > 0 || skippedCount > 0);
        }
        for (const artifact of artifacts) {
          bufferClaudeOutput("artifact", artifact.name, true, artifact.localPath);
        }
        return;
      }
      await bot.api
        .sendChatAction(source.chatId, "upload_document", {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        })
        .catch(() => {});
      let failedCount = 0;
      for (const artifact of artifacts) {
        try {
          await bot.api.sendDocument(source.chatId, new InputFile(artifact.localPath, artifact.name), {
            ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
          });
        } catch (error) {
          failedCount += 1;
          console.error(`Failed to send Claude artifact ${artifact.name}:`, error);
        }
      }
      const summary = formatArtifactSummary(artifacts, skippedCount + failedCount);
      if (summary) {
        await replyToClaudeRunSource(source, escapeHTML(summary), { fallbackText: summary, messageThreadId });
      }
    };

    // Deliver one Claude narration line, matching the Codex progress pipeline so both
    // providers behave identically. In `edit` mode a single message is kept and edited in
    // place, showing the rolling last-N narration lines (oldest rolls off). In `messages`
    // mode each line is its own message. `none` suppresses narration entirely.
    const deliverClaudeAssistantProgress = async (progressText: string): Promise<void> => {
      const trimmed = progressText.trim();
      if (!trimmed) {
        return;
      }
      const mode = registry.getProgressDelivery(contextKey);
      if (mode === "none") {
        return;
      }

      if (!isProviderForeground(contextKey, "claude")) {
        bufferClaudeOutput("assistant", trimmed, false);
        return;
      }

      if (mode === "edit" && isOversizedProgressBlock(trimmed)) {
        // The block alone exceeds the rolling-message budget. Freeze the current
        // progress message, deliver the block in full as ordinary messages, and let
        // subsequent lines start a fresh rolling message below it. Content is never cut.
        recentClaudeProgress.length = 0;
        progressMessageId = undefined;
        for (const chunk of splitMarkdownForTelegram(trimmed)) {
          await sendTextMessage(bot.api, source.chatId, chunk.text, {
            parseMode: chunk.parseMode,
            fallbackText: chunk.fallbackText,
            messageThreadId,
          });
        }
        sentAssistantProgress = true;
        return;
      }

      recentClaudeProgress.push(trimmed);
      if (recentClaudeProgress.length > SUMMARY_PROGRESS_RECENT_LIMIT) {
        recentClaudeProgress.splice(0, recentClaudeProgress.length - SUMMARY_PROGRESS_RECENT_LIMIT);
      }

      if (mode === "edit") {
        const rendered = renderAssistantProgressMessage(recentClaudeProgress);
        if (!progressMessageId) {
          const message = await sendTextMessage(bot.api, source.chatId, rendered.text, {
            parseMode: rendered.parseMode,
            fallbackText: rendered.fallbackText,
            messageThreadId,
          });
          progressMessageId = message.message_id;
        } else {
          await safeEditMessage(bot, source.chatId, progressMessageId, rendered.text, {
            parseMode: rendered.parseMode,
            fallbackText: rendered.fallbackText,
          }).catch(() => {});
        }
      } else {
        for (const chunk of splitMarkdownForTelegram(trimmed)) {
          await sendTextMessage(bot.api, source.chatId, chunk.text, {
            parseMode: chunk.parseMode,
            fallbackText: chunk.fallbackText,
            messageThreadId,
          });
        }
      }
      sentAssistantProgress = true;
    };

    let narrationIdleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearNarrationIdleTimer = (): void => {
      if (narrationIdleTimer) {
        clearTimeout(narrationIdleTimer);
        narrationIdleTimer = undefined;
      }
    };

    const flushPendingClaudeAssistantProgress = async (): Promise<void> => {
      const pending = pendingAssistantProgressText;
      if (!pending.trim()) {
        return;
      }
      // Clear synchronously before the async send so the idle timer and the next-delta flush
      // can never deliver the same block twice.
      pendingAssistantProgressText = "";
      clearNarrationIdleTimer();
      await deliverClaudeAssistantProgress(pending);
    };

    // A held narration line would otherwise wait for Claude's next block before appearing.
    // Flush it after a short idle so the first "let me..." line reaches Telegram promptly.
    // The timer is cleared at turn end, so the final answer block is never flushed this way.
    const scheduleNarrationIdleFlush = (): void => {
      clearNarrationIdleTimer();
      narrationIdleTimer = setTimeout(() => {
        narrationIdleTimer = undefined;
        void flushPendingClaudeAssistantProgress().catch(() => {});
      }, NARRATION_IDLE_FLUSH_MS);
    };

    const deliverClaudeStatusMessage = async (message: string): Promise<void> => {
      const trimmed = message.trim();
      if (!trimmed) {
        return;
      }
      const quietWarning = isClaudeQuietWarning(trimmed);
      if (quietWarning || isProviderForeground(contextKey, "claude")) {
        await replyToClaudeRunSource(source, escapeHTML(trimmed), {
          fallbackText: trimmed,
          messageThreadId,
        });
      } else {
        bufferClaudeOutput("status", trimmed, false);
      }
    };

    try {
      descriptor = await ensureClaudeSession(contextKey, deliverClaudeStatusMessage);
      const jobId = `claude-job-${randomUUID().slice(0, 12)}`;
      const agentSession = ensureAgentSessionRecord(contextKey, "claude", {
        workspace: descriptor.workspace,
        displayName: descriptor.displayName ?? "Claude Code",
        providerSessionId: descriptor.providerSessionId,
        select: isProviderForeground(contextKey, "claude"),
        metadata: descriptor.metadata,
      });
      claudeAgentSession = agentSession;
      const provisionalTitle = provisionalClaudeTitle(text);
      if (provisionalTitle && isGenericClaudeDisplayName(descriptor.displayName, contextKey)) {
        descriptor = { ...descriptor, displayName: provisionalTitle };
        claudeSessions.set(contextKey, descriptor);
        agentSessions.updateDisplayName(agentSession.id, provisionalTitle);
        persistAgentSessionState();
        persistClaudeSession(contextKey, descriptor);
      }
      agentJobId = jobId;
      startAgentJob(agentSession.id, jobId);
      let promptText = text;
      if (!text.trimStart().startsWith("/")) {
        const turnId = randomUUID().slice(0, 12);
        claudeArtifactOutDir = outboxPath(descriptor.workspace, turnId);
        await ensureOutDir(claudeArtifactOutDir);
        promptText = `${text}\n\n${outputFilesInstruction(claudeArtifactOutDir)}`;
      }
      const askClaudePermission = (request: AgentPermissionRequest): Promise<AgentPermissionDecision> => {
        const prompt = formatPermissionPrompt(request);
        let promptMessageId: number | undefined;
        return claudePermissionPrompts.request(
          request,
          async (id) => {
            const keyboard = new InlineKeyboard()
              .text("✅ Allow", permissionCallbackData("a", id))
              .text("❌ Deny", permissionCallbackData("d", id));
            if (request.canAllowAlways) {
              keyboard.row().text("♾ Always allow", permissionCallbackData("s", id));
            }
            const sent = await sendTextMessage(bot.api, source.chatId, prompt.html, {
              fallbackText: prompt.plain,
              replyMarkup: keyboard,
              messageThreadId,
            });
            promptMessageId = sent.message_id;
          },
          async (decision, reason) => {
            if (promptMessageId === undefined) {
              return;
            }
            const outcome = formatPermissionOutcome(decision, reason, CLAUDE_PERMISSION_TIMEOUT_MINUTES);
            // Editing without reply_markup also removes the buttons.
            await safeEditMessage(bot, source.chatId, promptMessageId, `${prompt.html}\n\n${escapeHTML(outcome)}`, {
              fallbackText: `${prompt.plain}\n\n${outcome}`,
            });
          },
        );
      };
      for await (const event of claudeAdapter.sendPrompt({
        sessionId: descriptor.id,
        jobId,
        input: { text: promptText },
        onPermissionRequest: askClaudePermission,
      })) {
        switch (event.type) {
          case "assistant_text_delta": {
            // Each delta is a complete narration block. Flush the previously held block as
            // progress (edit or messages) and hold this one; the last held block becomes the
            // final answer rather than a progress line, so the answer is never posted twice.
            const progressMode = registry.getProgressDelivery(contextKey);
            if ((progressMode === "messages" || progressMode === "edit") && pendingAssistantProgressText.trim()) {
              await flushPendingClaudeAssistantProgress();
            }
            pendingAssistantProgressText = event.text;
            streamedText += event.text;
            scheduleNarrationIdleFlush();
            break;
          }
          case "assistant_message_complete":
            clearNarrationIdleTimer();
            sawAssistantCompletion = true;
            finalText = event.text.trim() || streamedText.trim() || pendingAssistantProgressText.trim();
            finalAssistantBlock = pendingAssistantProgressText.trim() || remainingCompletionText(finalText, streamedText);
            pendingAssistantProgressText = "";
            break;
          case "session_title_changed":
            descriptor = { ...descriptor, displayName: cleanProviderSessionTitle(event.title) };
            claudeSessions.set(contextKey, descriptor);
            agentSessions.updateDisplayName(agentSession.id, descriptor.displayName ?? event.title);
            persistAgentSessionState();
            persistClaudeSession(contextKey, descriptor);
            break;
          case "tool_started":
            await flushPendingClaudeAssistantProgress();
            if (registry.getProgressDelivery(contextKey) !== "none" && config.toolVerbosity === "all") {
              const line = event.text ? `Claude started ${event.toolName}: ${event.text}` : `Claude started ${event.toolName}`;
              if (isProviderForeground(contextKey, "claude")) {
                await replyToClaudeRunSource(source, escapeHTML(line), { fallbackText: line, messageThreadId });
              } else {
                bufferClaudeOutput("tool", line, false);
              }
            }
            break;
          case "status_message":
            await flushPendingClaudeAssistantProgress();
            await deliverClaudeStatusMessage(event.text);
            break;
          case "tool_failed": {
            await flushPendingClaudeAssistantProgress();
            if (config.toolVerbosity !== "all" && config.toolVerbosity !== "errors-only") {
              break;
            }
            const message = `Claude tool failed: ${event.toolName}${event.text ? `: ${event.text}` : ""}`;
            if (isProviderForeground(contextKey, "claude")) {
              await replyToClaudeRunSource(source, escapeHTML(message), { fallbackText: message, messageThreadId });
            } else {
              bufferClaudeOutput("tool", message, true);
            }
            break;
          }
          case "error": {
            // B1 invariant: a held narration block must not be lost when the turn
            // errors mid-way; flush it as progress before reporting the failure.
            await flushPendingClaudeAssistantProgress();
            providerTurnError ??= event.message;
            break;
          }
          default:
            break;
        }
      }

      if (providerTurnError) {
        throw new Error(providerTurnError);
      }
      if (!sawAssistantCompletion) {
        throw new Error("Claude provider ended the turn without a completion event.");
      }

      // Claude reveals its real session id only once the first turn runs (it ignores the
      // id we launch with), so the adapter reconciles it mid-turn. Pull the refreshed
      // descriptor and propagate the real id into both state stores so --resume works.
      try {
        const refreshed = await claudeAdapter.getSessionInfo(descriptor.id);
        const providerSessionChanged = Boolean(
          refreshed.providerSessionId &&
            refreshed.providerSessionId !== descriptor.providerSessionId,
        );
        const refreshedDisplayName = refreshed.displayName &&
          shouldReplaceSessionDisplayName(
            descriptor.displayName,
            refreshed.displayName,
            refreshed.providerSessionId,
            "claude",
          )
          ? refreshed.displayName
          : descriptor.displayName;
        descriptor = {
          ...refreshed,
          displayName: refreshedDisplayName,
        };
        claudeSessions.set(contextKey, descriptor);
        if (providerSessionChanged && refreshed.providerSessionId) {
          agentSessions.updateProviderSessionId(agentSession.id, refreshed.providerSessionId);
        }
        if (refreshedDisplayName) {
          agentSessions.updateDisplayName(agentSession.id, refreshedDisplayName);
        }
        agentSessions.updateMetadata(agentSession.id, refreshed.metadata);
        persistAgentSessionState();
        persistClaudeSession(contextKey, descriptor);
      } catch {
        // Non-fatal: keep the existing descriptor if the adapter cannot be queried.
      }

      finalText = finalText.trim() || (sentAssistantProgress ? "" : streamedText.trim());
      if (finalText && claudeAgentSession) {
        lastAssistantReplyBySessionId.set(claudeAgentSession.id, finalText);
      }
      // Decide what still needs delivering. When interim narration was streamed as its own
      // messages, every block but the last was already sent; only the held final block
      // remains, so deliver just that and never re-post the whole answer. Otherwise (edit
      // or none delivery, or a single-block turn) deliver the full answer.
      let finalTextToDeliver = sentAssistantProgress ? finalAssistantBlock.trim() : finalText;
      if (!finalTextToDeliver && !sentAssistantProgress) {
        finalText = "Claude finished without text.";
        finalTextToDeliver = finalText;
      }
      const deliverClaudeFinal = async (outputText: string, header?: string): Promise<void> => {
        const textToSend = header ? `${header}\n\n${outputText}` : outputText;
        for (const chunk of splitMarkdownForTelegram(textToSend)) {
          await sendTextMessage(bot.api, source.chatId, chunk.text, {
            parseMode: chunk.parseMode,
            fallbackText: chunk.fallbackText,
            messageThreadId,
          });
        }
      };

      let finalDelivered = false;
      if (finalTextToDeliver) {
        if (isProviderForeground(contextKey, "claude")) {
          await deliverClaudeFinal(finalTextToDeliver);
          finalDelivered = true;
        } else {
          finalDelivered = source.ctx && descriptor
            ? await sendBackgroundCompletionNotice(
                source.ctx,
                contextKey,
                descriptor,
                finalTextToDeliver,
                messageThreadId,
              )
            : false;
          if (!finalDelivered && isProviderForeground(contextKey, "claude")) {
            await deliverClaudeFinal(finalTextToDeliver);
            finalDelivered = true;
          } else if (!finalDelivered && !source.ctx) {
            const label = descriptor?.displayName || descriptor?.providerSessionId?.slice(0, 8);
            const header = label
              ? `Claude Code finished in background: ${label}`
              : "Claude Code finished in background.";
            await deliverClaudeFinal(finalTextToDeliver, header);
            finalDelivered = true;
          } else if (!finalDelivered) {
            bufferClaudeOutput("final", finalTextToDeliver, true);
          }
        }
      }
      if (descriptor && finalDelivered) {
        clearDeliveredCompletionFromBuffer(claudeAgentSession?.id ?? descriptor.id, finalTextToDeliver);
      }
      if (descriptor) {
        persistClaudeSession(contextKey, descriptor);
      }
      completedSuccessfully = true;
      await setClaudeRunReaction(source, "👍");
    } catch (error) {
      console.error("Claude prompt failed:", error);
      bridgeLog("error", `claude turn failed lane=${contextKey}: ${String(error)}`);
      if (error instanceof PromptNotDeliveredError) {
        const deliveryFailures = (source.queueEntry?.deliveryFailures ?? 0) + 1;
        const terminalCommandFailure = /Unknown command:|Args from unknown skill:/i.test(error.message);
        if (!terminalCommandFailure && deliveryFailures < MAX_CLAUDE_PROMPT_DELIVERY_FAILURES) {
          // Requeue the user's text, not the delivered prompt: the delivered prompt carries
          // this turn's outbox instruction, and the retry turn appends its own.
          enqueueClaudePromptFromSource(source, contextKey, stripOutputFilesInstruction(error.promptText), {
            front: true,
            deliveryFailures,
          });
          deferQueuedDispatch = true;
          // A delivery failure means the terminal engine's paste+submit dance broke, which
          // historically happens when a Claude CLI update changes the TUI under the bridge.
          // The SDK engine delivers prompts programmatically, so switch this context over
          // (sticky; /backend pty reverts) instead of burning every retry on the same bug.
          // PromptNotDeliveredError is emitted only by the PTY path. Apply this even if
          // the persisted preference already says sdk, because a long-lived runtime can
          // temporarily disagree with the preference that will be used after restart.
          claudeBackendPrefs?.set(contextKey, "sdk");
          const activeDescriptor = claudeSessions.get(contextKey);
          if (activeDescriptor && claudeAdapter) {
            try {
              await claudeAdapter.setBackend?.(activeDescriptor.id, "sdk");
              const refreshed = await claudeAdapter.getSessionInfo(activeDescriptor.id);
              claudeSessions.set(contextKey, refreshed);
              persistClaudeSession(contextKey, refreshed);
            } catch (switchError) {
              console.warn("Failed to switch the live Claude session to the SDK engine", switchError);
            }
          }
          bridgeLog("backend", `auto-switch to sdk after delivery failure lane=${contextKey}`);
          const engineNote = " The terminal engine keeps mangling the message, so I switched this chat to the SDK engine for the retry. Use /backend pty to switch back later.";
          const queuedMessage = `Claude did not accept the message yet. I will retry when the session is idle, attempt ${deliveryFailures + 1} of ${MAX_CLAUDE_PROMPT_DELIVERY_FAILURES}.${engineNote}`;
          await replyToClaudeRunSource(source, escapeHTML(queuedMessage), {
            fallbackText: queuedMessage,
            messageThreadId,
          });
          const retryTimer = setTimeout(() => {
            dispatchNextQueuedClaudePrompt(contextKey);
          }, 30000);
          retryTimer.unref?.();
        } else {
          const stoppedMessage = terminalCommandFailure
            ? "Claude rejected that input as an invalid command. I stopped automatic retries. Use /retry after correcting the message."
            : `Claude did not accept the message after ${MAX_CLAUDE_PROMPT_DELIVERY_FAILURES} attempts. I stopped automatic retries. Use /retry to try it again manually.`;
          await replyToClaudeRunSource(source, escapeHTML(stoppedMessage), {
            fallbackText: stoppedMessage,
            messageThreadId,
          });
        }
        await clearClaudeRunReaction(source);
        return;
      }
      const message = `Claude failed: ${friendlyErrorText(error)}`;
      if (isProviderForeground(contextKey, "claude")) {
        await replyToClaudeRunSource(source, escapeHTML(message), { fallbackText: message, messageThreadId });
      } else {
        bufferClaudeOutput("error", message, true);
        if (descriptor) {
          if (source.ctx) {
            await sendBackgroundCompletionNotice(source.ctx, contextKey, descriptor, message, messageThreadId);
          } else {
            const label = descriptor.displayName || descriptor.providerSessionId?.slice(0, 8);
            const header = label
              ? `Claude Code finished in background: ${label}`
              : "Claude Code finished in background.";
            await replyToClaudeRunSource(source, formatTelegramHTML(`${header}\n\n${message}`), {
              fallbackText: `${header}\n\n${message}`,
              messageThreadId,
            });
          }
        }
      }
      await clearClaudeRunReaction(source);
    } finally {
      clearInterval(typingInterval);
      clearNarrationIdleTimer();
      try {
        await deliverClaudeArtifacts();
      } catch (artifactError) {
        console.error("Failed to deliver Claude artifacts:", artifactError);
      }
      if (agentJobId) {
        finishAgentJob(agentJobId, completedSuccessfully ? "completed" : "failed");
      }
      bridgeLog(
        "turn",
        `end lane=${contextKey} ok=${completedSuccessfully} durationMs=${Date.now() - turnStartedAt} queueDepth=${queuedClaudePrompts.depth(contextKey)}`,
      );
      markProviderBusy(contextKey, "claude", false);
      busyState.processing = false;
      if (!deferQueuedDispatch) {
        dispatchNextQueuedClaudePrompt(contextKey);
      }
    }
  };

  const startClaudePrompt = (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    text: string,
  ): void => {
    void handleClaudePrompt({
      ctx,
      chatId,
      messageThreadId: parseContextKey(contextKey).messageThreadId,
    }, contextKey, text).catch((error) => {
      console.error("Claude prompt task failed:", error);
    });
  };

  const startQueuedClaudePrompt = (entry: ClaudePromptQueueEntry): void => {
    const ctx = liveQueuedClaudeContexts.get(entry.id);
    liveQueuedClaudeContexts.delete(entry.id);
    void handleClaudePrompt({
      ctx,
      chatId: entry.chatId,
      messageThreadId: entry.messageThreadId,
      queueEntry: entry,
    }, entry.contextKey, entry.text).catch((error) => {
      console.error("Queued Claude prompt task failed:", error);
    });
  };

  const dispatchNextQueuedClaudePrompt = (contextKey: TelegramContextKey): void => {
    if (!claudeAdapter || isProviderBusy(contextKey, "claude") || getBusyState(contextKey).processing) {
      return;
    }
    const queued = queuedClaudePrompts.dequeue(contextKey);
    if (!queued) {
      return;
    }
    lastPromptInput.set(contextKey, queued.text);
    const ctx = liveQueuedClaudeContexts.get(queued.id);
    if (ctx) {
      void setReaction(ctx, "👀").catch(() => {});
    }
    startQueuedClaudePrompt(queued);
  };

  const recoverPersistedClaudeQueue = (): void => {
    if (!claudeAdapter) {
      return;
    }
    for (const contextKey of queuedClaudePrompts.contextKeys()) {
      const first = queuedClaudePrompts.peek(contextKey);
      if (!first) {
        continue;
      }
      const depth = queuedClaudePrompts.depth(contextKey);
      const message = depth === 1
        ? "One queued Claude message from before the restart will be sent now."
        : `${depth} queued Claude messages from before the restart will be sent now.`;
      void sendTextMessage(bot.api, first.chatId, escapeHTML(message), {
        fallbackText: message,
        messageThreadId: first.messageThreadId,
      }).catch((error) => {
        console.warn("Failed to report recovered Claude queue", error);
      });
      dispatchNextQueuedClaudePrompt(contextKey);
    }
  };

  const clearDeliveredCompletionFromBuffer = (sessionId: string, deliveredText: string): void => {
    const normalizedDeliveredText = deliveredText.trim();
    outputBuffer.drainWhere(
      sessionId,
      (event) => event.kind === "final" || (
        event.kind === "error" && event.text?.trim() === normalizedDeliveredText
      ),
    );
  };

  const outputBufferSessionId = (
    contextKey: TelegramContextKey,
    descriptor: AgentSessionDescriptor | AgentSessionRecord,
  ): string => {
    if (agentSessions.getSession(descriptor.id)) {
      return descriptor.id;
    }
    const matchingSession = agentSessions.listLaneSessions(contextKey).find((session) =>
      session.provider === descriptor.provider &&
      Boolean(descriptor.providerSessionId) &&
      session.providerSessionId === descriptor.providerSessionId,
    );
    return matchingSession?.id ?? descriptor.id;
  };

  const sendBackgroundCompletionNotice = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    descriptor: AgentSessionDescriptor | AgentSessionRecord,
    finalText: string,
    messageThreadId?: number,
  ): Promise<boolean> => {
    if (isProviderForeground(contextKey, descriptor.provider)) {
      return false;
    }

    const lane = agentSessions.getLane(contextKey);
    if (lane?.notifyOnBackgroundCompletion === false) {
      return false;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      return false;
    }

    const providerName = descriptor.provider === "claude"
      ? "Claude Code"
      : formatProviderDisplayName(descriptor.provider);
    const label = descriptor.displayName || descriptor.providerSessionId?.slice(0, 8) || descriptor.id;
    const completionText = `${providerName} finished in background: ${label}\n\n${finalText}`.trim();
    for (const chunk of splitMarkdownForTelegram(completionText)) {
      await sendTextMessage(ctx.api, chatId, chunk.text, {
        parseMode: chunk.parseMode,
        fallbackText: chunk.fallbackText,
        messageThreadId,
      });
    }
    return true;
  };

  const flushBufferedPriority = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    descriptor: AgentSessionDescriptor | AgentSessionRecord,
    messageThreadId?: number,
  ): Promise<void> => {
    const events = outputBuffer.drainWhere(
      outputBufferSessionId(contextKey, descriptor),
      (event) => event.priority,
    );
    if (events.length === 0) {
      return;
    }

    const lines = events
      .map((event) => formatBufferedOutputEvent(event))
      .filter((line) => line.trim());
    if (lines.length > 0) {
      const plain = [`Buffered ${formatProviderDisplayName(descriptor.provider)} output:`, ...lines].join("\n\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain, messageThreadId });
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const artifactEvents = events.filter((event) => event.kind === "artifact" && event.artifactPath);
    for (const event of artifactEvents) {
      try {
        await ctx.api.sendDocument(chatId, new InputFile(event.artifactPath!), {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        });
      } catch (error) {
        console.error(`Failed to send buffered artifact ${event.artifactPath}:`, error);
      }
    }
  };

  const handleClaudeSlashCommand = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    text: string,
  ): Promise<boolean> => {
    const classified = classifyClaudeSlashCommand(text);
    if (!classified) {
      return false;
    }

    const { parsed, spec } = classified;
    if (TELECODE_COMMANDS_WHILE_CLAUDE_ACTIVE.has(parsed.name)) {
      return false;
    }

    const messageThreadId = parseContextKey(contextKey).messageThreadId;

    if (!spec) {
      const message = `Claude command /${parsed.name} is not classified yet, so I did not run it.`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return true;
    }

    if (spec.class === "dispatch" || spec.class === "dispatch_arg") {
      if (spec.class === "dispatch_arg" && !parsed.argument) {
        const hint = renderClaudeArgumentCommandHint(parsed.name);
        await safeReply(ctx, formatTelegramHTML(hint), { fallbackText: hint, messageThreadId });
        return true;
      }

      if (parsed.name === "compact") {
        await compactClaudeSession(ctx, contextKey, messageThreadId, parsed.argument);
        return true;
      }

      if (parsed.name === "model") {
        const descriptor = await ensureClaudeSession(contextKey);
        const nextDescriptor = {
          ...descriptor,
          metadata: {
            ...descriptor.metadata,
            model: parsed.argument,
          },
        };
        claudeSessions.set(contextKey, nextDescriptor);
        persistClaudeSession(contextKey, nextDescriptor);
      }

      await setReaction(ctx, "👀");
      startClaudePrompt(ctx, contextKey, chatId, text.trim());
      return true;
    }

    if (spec.class === "surface") {
      await handleClaudeSurfaceCommand(ctx, contextKey, parsed.name, messageThreadId);
      return true;
    }

    if (spec.class === "emulate") {
      await handleClaudeEmulatedCommand(ctx, contextKey, parsed.name, parsed.argument, messageThreadId);
      return true;
    }

    if (spec.class === "na") {
      const message = `/${parsed.name} is recognized, but it is not applicable over Telegram. ${spec.description}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return true;
    }

    if (spec.class === "block") {
      const message = `/${parsed.name} is blocked from Telegram. ${spec.description}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return true;
    }

    return false;
  };

  const compactClaudeSession = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    messageThreadId?: number,
    instructions?: string,
  ): Promise<void> => {
    if (!claudeAdapter) {
      const message = "Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }
    if (isBusy(contextKey)) {
      const message = "Cannot compact Claude while a prompt is running.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }

    try {
      const descriptor = await ensureClaudeSession(contextKey);
      await safeReply(ctx, escapeHTML("Compacting Claude session..."), {
        fallbackText: "Compacting Claude session...",
        messageThreadId,
      });
      await claudeAdapter.compact?.(descriptor.id, instructions);
      const message = "Claude compaction completed.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      persistClaudeSession(contextKey, descriptor);
    } catch (error) {
      const message = `Failed: ${friendlyErrorText(error)}`;
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: message,
        messageThreadId,
      });
    }
  };

  const handleClaudeSurfaceCommand = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    commandName: string,
    messageThreadId?: number,
  ): Promise<void> => {
    if (commandName === "usage" || commandName === "cost") {
      await sendClaudeUsageReport(ctx, contextKey, messageThreadId);
      return;
    }

    if (["context", "stats"].includes(commandName)) {
      await sendClaudeUsage(ctx, contextKey, messageThreadId);
      return;
    }

    if (commandName === "heapdump") {
      const message = "Claude heapdump is not available over Telegram.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }

    if (commandName === "doctor" || commandName === "debug") {
      const descriptor = claudeSessions.get(contextKey);
      const persisted = claudeState?.get(contextKey);
      const pidRegistryPath = claudeProcessRegistryPath(config.workspace);
      const pidRegistryCount = readClaudePidRegistryCount(pidRegistryPath);
      const legacyPluginProcesses = await findRunningClaudeTelegramPluginProcesses();
      const transcriptRoot = config.claudeStrictMcpConfig
        ? path.join(homedir(), ".claude", "projects")
        : path.join(config.claudeConfigDir, "projects");
      const lines = [
        "Claude provider diagnostics:",
        `Enabled: ${config.enableClaudeProvider}`,
        `Binary: ${config.claudeBin}`,
        `Binary exists: ${path.isAbsolute(config.claudeBin) ? existsSync(config.claudeBin) : "resolved via PATH"}`,
        `Workspace: ${config.claudeWorkspace}`,
        `Default model: ${config.claudeDefaultModel}`,
        `Strict MCP config: ${config.claudeStrictMcpConfig}`,
        `Transcript root: ${transcriptRoot}`,
        `Transcript root exists: ${existsSync(transcriptRoot)}`,
        `PID registry: ${pidRegistryPath}`,
        `Registered Claude PIDs: ${pidRegistryCount}`,
        `Legacy Claude Telegram plugin processes: ${legacyPluginProcesses.length}`,
        `Permission mode: ${config.claudePermissionMode}`,
        `Attached session: ${descriptor?.providerSessionId ?? "(none)"}`,
        `Attached model: ${String(descriptor?.metadata?.model ?? "(none)")}`,
        `Persisted session: ${persisted?.sessionId ?? "(none)"}`,
        `Persisted model: ${persisted?.model ?? "(none)"}`,
        `Persisted permission mode: ${persisted?.permissionMode ?? "(none)"}`,
      ];
      const plain = lines.join("\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain, messageThreadId });
      return;
    }

    await sendClaudeSessionStatus(ctx, contextKey, messageThreadId);
  };

  const handleClaudeEmulatedCommand = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    commandName: string,
    argument: string,
    messageThreadId?: number,
  ): Promise<void> => {
    if (commandName === "stop" || commandName === "abort") {
      await abortClaudeSession(ctx, contextKey, messageThreadId);
      return;
    }

    if (commandName === "clear") {
      if (isBusy(contextKey)) {
        const message = "Cannot clear while a Claude prompt is running. Use /stop first.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
        return;
      }
      await forgetClaudeSession(contextKey);
      const message = "Cleared this Claude session. The next message will start a fresh Claude session.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }

    if (commandName === "copy" || commandName === "last" || commandName === "repeat") {
      const reply = getFocusedAssistantReply(contextKey);
      if (!reply) {
        const message = "No assistant reply is available for the selected provider session yet.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
        return;
      }
      const rendered = formatMarkdownMessage(reply);
      await safeReply(ctx, rendered.text, {
        parseMode: rendered.parseMode,
        fallbackText: rendered.fallbackText,
        messageThreadId,
      });
      return;
    }

    if (commandName === "exit") {
      const descriptor = claudeSessions.get(contextKey);
      if (descriptor && claudeAdapter) {
        await claudeAdapter.dispose(descriptor.id);
        claudeSessions.delete(contextKey);
      }
      const message = "Claude process disposed. The saved session will resume on the next message.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }

    if (commandName === "fork" || commandName === "branch") {
      await forkClaudeConversation(ctx, contextKey, argument.trim() || undefined, messageThreadId);
      return;
    }

    if (commandName === "resume") {
      if (!argument) {
        const plain = renderUnifiedSessions(contextKey);
        await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain, messageThreadId });
        return;
      }
      await selectUnifiedAgentSession(ctx, contextKey, argument);
      return;
    }

    if (commandName === "rename") {
      const name = argument.trim();
      if (!name) {
        const message = "Usage: /rename <new title>";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
        return;
      }
      const descriptor = claudeSessions.get(contextKey);
      if (!descriptor) {
        const message = "No Claude session here yet. Send a message to Claude first, then rename it.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
        return;
      }
      const renamed = { ...descriptor, displayName: name };
      claudeSessions.set(contextKey, renamed);
      const selected = agentSessions.getSelectedSession(contextKey);
      if (selected && selected.provider === "claude") {
        agentSessions.updateDisplayName(selected.id, name);
        persistAgentSessionState();
      }
      persistClaudeSession(contextKey, renamed);
      const message = `Renamed this Claude session to: ${name}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }

    if (commandName === "export") {
      const descriptor = claudeSessions.get(contextKey);
      const persisted = claudeState?.get(contextKey);
      const sessionId = descriptor?.providerSessionId ?? persisted?.sessionId;
      if (!sessionId) {
        const message = "No Claude session to export yet.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
        return;
      }
      const transcriptRoot = config.claudeStrictMcpConfig
        ? path.join(homedir(), ".claude", "projects")
        : path.join(config.claudeConfigDir, "projects");
      const lines = [
        "Claude session export:",
        `Session UUID: ${sessionId}`,
        `Workspace: ${descriptor?.workspace ?? persisted?.workspace ?? config.claudeWorkspace}`,
        `Transcript directory: ${transcriptRoot}`,
        "The full transcript JSONL lives under that directory, named <session-uuid>.jsonl.",
      ];
      const plain = lines.join("\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain, messageThreadId });
      return;
    }

    const message = `/${commandName} is recognized for Claude, but it is not supported over Telegram yet. No action was taken.`;
    await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
  };

  const abortClaudeSession = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    messageThreadId?: number,
  ): Promise<void> => {
    const descriptor = claudeSessions.get(contextKey);
    if (!descriptor || !claudeAdapter) {
      const message = "No Claude operation is active here.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }

    try {
      await claudeAdapter.abort(descriptor.id);
      await safeReply(ctx, escapeHTML("Abort sent to Claude."), {
        fallbackText: "Abort sent to Claude.",
        messageThreadId,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
        messageThreadId,
      });
    } finally {
      getBusyState(contextKey).processing = false;
    }
  };

  const sendClaudeSessionStatus = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    messageThreadId?: number,
  ): Promise<void> => {
    const descriptor = claudeSessions.get(contextKey);
    const persisted = claudeState?.get(contextKey);
    const lines = descriptor
      ? renderClaudeSessionPlain(descriptor, await claudeAdapter?.getContext(descriptor.id))
      : persisted
        ? [
            "Claude session:",
            `Session UUID: ${persisted.sessionId}`,
            `Workspace: ${persisted.workspace}`,
            `Model: ${persisted.model}`,
            `Permission mode: ${persisted.permissionMode}`,
            "Status: not attached, will resume on next message",
          ].join("\n")
        : [
            "Claude session:",
            "Status: not started yet",
            `Workspace: ${config.claudeWorkspace}`,
            `Model: ${config.claudeDefaultModel}`,
            `Permission mode: ${config.claudePermissionMode}`,
          ].join("\n");
    await safeReply(ctx, formatTelegramHTML(lines), { fallbackText: lines, messageThreadId });
  };

  const sendClaudeUsageReport = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    messageThreadId?: number,
  ): Promise<void> => {
    if (!claudeAdapter) {
      const message = "Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }
    if (isBusy(contextKey)) {
      const message = "Cannot read Claude usage while a prompt is running. Try again once it finishes.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }

    await safeReply(ctx, escapeHTML("Reading Claude usage limits..."), {
      fallbackText: "Reading Claude usage limits...",
      messageThreadId,
    });

    try {
      const descriptor = await ensureClaudeSession(contextKey);
      const report = await claudeAdapter.getUsageReport(descriptor.id);
      const context = await claudeAdapter.getContext(descriptor.id);
      const used = Number(context.usedTokens ?? 0);
      const window = Number(context.contextWindow ?? config.claudeContextWindow);
      const autoCompactWindow = Number(
        context.autoCompactWindow ?? config.claudeAutoCompactWindow,
      );
      const sections = [
        report ?? "Could not read the Claude usage panel this time. Try again in a moment.",
        formatClaudeContextLine(used, window, autoCompactWindow)
          .replace(/^Context:/u, "Session context:"),
      ];
      const plain = sections.join("\n\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain, messageThreadId });
    } catch (error) {
      const message = `Failed to read Claude usage: ${friendlyErrorText(error)}`;
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: message,
        messageThreadId,
      });
    }
  };

  const sendClaudeUsage = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    messageThreadId?: number,
  ): Promise<void> => {
    const descriptor = claudeSessions.get(contextKey);
    if (!descriptor || !claudeAdapter) {
      const message = "No Claude usage is available yet. Send a message to Claude first.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message, messageThreadId });
      return;
    }

    const usage = await claudeAdapter.getUsage(descriptor.id);
    const context = await claudeAdapter.getContext(descriptor.id);
    const used = Number(context.usedTokens ?? 0);
    const window = Number(context.contextWindow ?? config.claudeContextWindow);
    const autoCompactWindow = Number(
      context.autoCompactWindow ?? config.claudeAutoCompactWindow,
    );
    const plain = [
      formatClaudeContextLine(used, window, autoCompactWindow),
      `Last turn: in ${Number(usage.inputTokens ?? 0)}, cached ${Number(usage.cachedInputTokens ?? 0)}, out ${Number(usage.outputTokens ?? 0)}.`,
    ].join("\n");
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain, messageThreadId });
  };

  const mirrorCurrentCodexAgentSession = (contextKey: TelegramContextKey, select?: boolean): AgentSessionRecord | undefined => {
    const codexSession = registry.get(contextKey);
    if (!codexSession) {
      return undefined;
    }

    const info = codexSession.getInfo();
    return ensureAgentSessionRecord(contextKey, "codex", {
      workspace: info.workspace,
      displayName: resolveCodexSessionDisplayName(info.threadId, "Codex"),
      providerSessionId: info.threadId ?? undefined,
      select,
      metadata: {
        model: info.model,
        reasoningEffort: info.reasoningEffort,
        backend: registry.getBackend(contextKey),
      },
    });
  };

  const buildRecentProviderSessionPicks = (
    contextKey: TelegramContextKey,
    limit: number,
  ): ProviderSessionPick[] => {
    const selectedSessionId = agentSessions.getLane(contextKey)?.selectedSessionId;
    const picksByKey = new Map<string, ProviderSessionPick>();
    const spawnedCodexThreadIds = new Set(listSpawnedThreadIds());
    const codexThreads = listThreads(MAX_PROVIDER_SESSION_LIST_LIMIT);
    const codexThreadsById = new Map(codexThreads.map((thread) => [thread.id, thread]));
    const claudeTranscriptRoot = config.claudeStrictMcpConfig
      ? path.join(homedir(), ".claude", "projects")
      : path.join(config.claudeConfigDir, "projects");
    const claudeTranscripts = config.enableClaudeProvider
      ? listClaudeTranscriptSessions(MAX_PROVIDER_SESSION_LIST_LIMIT, claudeTranscriptRoot)
      : [];
    const claudeTranscriptsBySessionId = new Map(
      claudeTranscripts.map((transcript) => [transcript.sessionId, transcript]),
    );
    let repairedClaudeTitle = false;

    for (const session of agentSessions.listLaneSessions(contextKey)) {
      if (session.provider === "codex" && session.providerSessionId && spawnedCodexThreadIds.has(session.providerSessionId)) {
        continue;
      }
      let sessionForPick = session;
      if (session.provider === "claude" && session.providerSessionId) {
        const transcript = claudeTranscriptsBySessionId.get(session.providerSessionId);
        if (transcript && shouldPreferClaudeTranscriptTitle(session.displayName, transcript.title)) {
          sessionForPick = agentSessions.updateDisplayName(session.id, transcript.title);
          repairedClaudeTitle = true;
        }
      }
      let pick = providerSessionPickFromAgentSession(sessionForPick);
      if (session.provider === "codex" && session.providerSessionId) {
        const thread = codexThreadsById.get(session.providerSessionId);
        if (thread) {
          pick = {
            ...pick,
            title: resolveCodexThreadTitle(thread),
            workspace: thread.cwd,
            updatedAt: thread.updatedAt.getTime(),
          };
        }
      } else if (session.provider === "claude" && session.providerSessionId) {
        const transcript = claudeTranscriptsBySessionId.get(session.providerSessionId);
        if (transcript) {
          pick = {
            ...pick,
            title: transcript.title,
            workspace: transcript.workspace,
            updatedAt: transcript.updatedAt,
          };
        }
      }
      picksByKey.set(providerSessionPickKey(pick), pick);
    }
    if (repairedClaudeTitle) {
      persistAgentSessionState();
    }

    for (const thread of codexThreads) {
      const pick = providerSessionPickFromCodexThread(thread);
      if (!picksByKey.has(providerSessionPickKey(pick))) {
        picksByKey.set(providerSessionPickKey(pick), pick);
      }
    }

    if (config.enableClaudeProvider) {
      for (const transcript of claudeTranscripts) {
        const pick = providerSessionPickFromClaudeTranscript(transcript, {
          model: config.claudeDefaultModel,
          permissionMode: config.claudePermissionMode,
        });
        if (!picksByKey.has(providerSessionPickKey(pick))) {
          picksByKey.set(providerSessionPickKey(pick), pick);
        }
      }
    }

    return [...picksByKey.values()]
      .sort((left, right) => {
        const selectedDelta = Number(providerSessionPickAgentId(right) === selectedSessionId) - Number(providerSessionPickAgentId(left) === selectedSessionId);
        if (selectedDelta !== 0) {
          return selectedDelta;
        }
        return right.updatedAt - left.updatedAt;
      })
      .slice(0, limit);
  };

  const materializeProviderSessionPick = async (
    contextKey: TelegramContextKey,
    pick: ProviderSessionPick,
  ): Promise<AgentSessionRecord> => {
    if (pick.kind === "agent") {
      return pick.session;
    }

    if (pick.kind === "codex-thread") {
      return ensureAgentSessionRecord(contextKey, "codex", {
        workspace: pick.workspace,
        displayName: pick.title,
        providerSessionId: pick.providerSessionId,
        select: true,
        metadata: {
          model: pick.thread.model,
          importedFrom: "codex-state",
        },
      });
    }

    return ensureAgentSessionRecord(contextKey, "claude", {
      workspace: pick.workspace,
      displayName: pick.title,
      providerSessionId: pick.providerSessionId,
      select: true,
      metadata: pick.metadata,
    });
  };

  const renderUnifiedSessions = (contextKey: TelegramContextKey, rawArg = ""): string => {
    mirrorCurrentCodexAgentSession(contextKey, isProviderForeground(contextKey, "codex"));
    const lane = agentSessions.ensureLane(contextKey, { defaultProvider: registry.getActiveProvider(contextKey) });
    const limit = parseProviderSessionListLimit(rawArg);
    const picks = buildRecentProviderSessionPicks(contextKey, limit);
    if (picks.length === 0) {
      return "No recent provider sessions found. Use /new codex or /new claude.";
    }

    pendingAgentSessionPicks.set(contextKey, picks);
    const lines = [
      `Recent provider sessions (top-level only). Showing ${picks.length}. Selected: ${formatSelectedProviderSessionLabel(picks, lane.selectedSessionId)}.`,
      ...picks.map((pick, index) => formatProviderSessionPickLine(index + 1, pick, lane.selectedSessionId)),
      "",
      limit < MAX_PROVIDER_SESSION_LIST_LIMIT ? `Use /sessions all for up to ${MAX_PROVIDER_SESSION_LIST_LIMIT} sessions.` : undefined,
      "Subagent child threads are omitted here; use /children while a Codex session is selected.",
      "Use /switch 1 or /use 1. Use /session for technical IDs.",
    ];
    return lines.filter((line): line is string => Boolean(line)).join("\n");
  };

  const selectUnifiedAgentSession = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    rawSelection: string,
  ): Promise<boolean> => {
    const picks = pendingAgentSessionPicks.get(contextKey) ?? buildRecentProviderSessionPicks(contextKey, DEFAULT_PROVIDER_SESSION_LIST_LIMIT);
    const targetPick = resolveProviderSessionPick(rawSelection, picks, agentSessions.getLane(contextKey)?.selectedSessionId);
    if (!targetPick) {
      const matches = findProviderSessionPickMatches(rawSelection, picks);
      const message = matches.length > 1
        ? "Ambiguous provider session. Use more characters or a list number from /sessions."
        : "Unknown provider session. Run /sessions, then use /switch 1.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return true;
    }

    const listNumber = targetPick ? picks.indexOf(targetPick) + 1 : undefined;
    if (targetPick.provider === "claude") {
      const currentClaude = claudeSessions.get(contextKey);
      const switchingClaudeSession = currentClaude?.providerSessionId !== targetPick.providerSessionId;
      if (isProviderBusy(contextKey, "claude") && switchingClaudeSession) {
        const message = "Claude is running. You can switch to the running Claude session, but not to another Claude session until it finishes.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        return true;
      }

      const target = await materializeProviderSessionPick(contextKey, targetPick);
      registry.setActiveProvider(contextKey, "claude");
      agentSessions.selectSession(contextKey, target.id);
      persistAgentSessionState();
      const descriptor = switchingClaudeSession
        ? await resumeClaudeAgentSession(contextKey, target)
        : currentClaude ?? await resumeClaudeAgentSession(contextKey, target);
      await flushBufferedPriority(ctx, contextKey, descriptor, parseContextKey(contextKey).messageThreadId);
      const message = formatProviderSessionSelectionMessage(target, listNumber);
      await safeReply(ctx, formatTelegramHTML(message), { fallbackText: message });
      return true;
    }

    if (targetPick.provider === "codex") {
      if (isProviderBusy(contextKey, "codex")) {
        const message = "Codex is running. Switching between Codex sessions while Codex is busy is not supported yet.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        return true;
      }

      const target = await materializeProviderSessionPick(contextKey, targetPick);
      const contextSession = await getContextSession(ctx, { deferThreadStart: true });
      if (!contextSession) {
        return true;
      }
      const codexSession = contextSession.session;
      if (target.providerSessionId) {
        await codexSession.switchSession(target.providerSessionId);
        updateSessionMetadata(contextKey, codexSession);
      }
      registry.setActiveProvider(contextKey, "codex");
      agentSessions.selectSession(contextKey, target.id);
      persistAgentSessionState();
      await flushBufferedPriority(ctx, contextKey, target, parseContextKey(contextKey).messageThreadId);
      const message = formatProviderSessionSelectionMessage(target, listNumber);
      await safeReply(ctx, formatTelegramHTML(message), { fallbackText: message });
      return true;
    }

    const message = `Provider ${targetPick.provider} is not supported yet.`;
    await safeReply(ctx, escapeHTML(message), { fallbackText: message });
    return true;
  };

  const deliverArtifacts = async (
    ctx: Context,
    chatId: TelegramChatId,
    outDir: string,
    messageThreadId?: number,
  ): Promise<void> => {
    const { artifacts, skippedCount } = await collectArtifactReport(outDir);

    if (artifacts.length === 0 && skippedCount === 0) {
      return;
    }

    await ctx.api
      .sendChatAction(chatId, "upload_document", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    let failedCount = 0;
    for (const artifact of artifacts) {
      try {
        await ctx.api.sendDocument(chatId, new InputFile(artifact.localPath, artifact.name), {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        });
      } catch (error) {
        failedCount += 1;
        console.error(`Failed to send artifact ${artifact.name}:`, error);
      }
    }

    const summary = formatArtifactSummary(artifacts, skippedCount + failedCount);
    if (summary) {
      await safeReply(ctx, escapeHTML(summary), { fallbackText: summary });
    }
  };

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    await next();
  });

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text?.trim();
    const contextKey = contextKeyFromCtx(ctx);
    if (!text?.startsWith("/") || !contextKey || !isClaudeActive(contextKey) || !ctx.chat) {
      await next();
      return;
    }

    if (await handleClaudeSlashCommand(ctx, contextKey, ctx.chat.id, text)) {
      return;
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const rawContextKey = contextKeyFromCtx(ctx);
    if (rawContextKey && isClaudeActive(rawContextKey)) {
      const descriptor = claudeSessions.get(rawContextKey);
      const persisted = claudeState?.get(rawContextKey);
      const model = String(descriptor?.metadata?.model ?? persisted?.model ?? config.claudeDefaultModel);
      const lines = [
        "TeleCode is running.",
        "Active provider: Claude Code",
        `Workspace: ${descriptor?.workspace ?? persisted?.workspace ?? config.claudeWorkspace}`,
        `Model: ${model}`,
        "Use /codex to switch this context back to Codex.",
      ];
      await safeReply(ctx, lines.map((line) => escapeHTML(line)).join("\n"), {
        fallbackText: lines.join("\n"),
      });
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const authWarning = authStatus.authenticated ? undefined : "Not authenticated. Use /login or set CODEX_API_KEY.";
    const isReturning = registry.hasMetadata(contextKey);

    if (isReturning) {
      const info = session.getInfo();
      const welcome = renderWelcomeReturning(
        renderSessionInfoHTML(info),
        renderSessionInfoPlain(info),
        isTopicContext(contextKey),
        authWarning,
      );
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
    } else {
      const welcome = renderWelcomeFirstTime(authWarning);
      const info = session.getInfo();
      await safeReply(ctx, [welcome.html, "", renderLaunchSummaryHTML(info)].join("\n"), {
        fallbackText: [welcome.plain, "", renderLaunchSummaryPlain(info)].join("\n"),
      });
    }
  });

  bot.command("help", async (ctx) => {
    const help = renderHelpMessage();
    await safeReply(ctx, help.html, { fallbackText: help.plain });
  });

  bot.command("health", async (ctx) => {
    const contexts = registry.listContexts();
    const busyContexts = new Set<TelegramContextKey>();
    for (const context of contexts) {
      if (isBusy(context.contextKey)) {
        busyContexts.add(context.contextKey);
      }
    }
    for (const contextKey of busyProviders.keys()) {
      if (isAnyProviderBusy(contextKey)) {
        busyContexts.add(contextKey);
      }
    }
    for (const [contextKey, state] of contextBusy) {
      if (state.processing || state.switching || state.transcribing) {
        busyContexts.add(contextKey);
      }
    }

    const lines = [
      "Status: ok",
      `Uptime: ${formatDuration(Date.now() - startedAt)}`,
      `Known lanes: ${contexts.length}`,
      `Busy lanes: ${busyContexts.size}`,
      `Backend: ${config.codexBackend}`,
      `Workspace: ${config.workspace}`,
      `State file: ${path.join(config.workspace, ".telecode", "contexts.json")}`,
    ];
    await safeReply(ctx, lines.map((line) => escapeHTML(line)).join("\n"), {
      fallbackText: lines.join("\n"),
    });
  });

  bot.command(["jobs", "alljobs"], async (ctx) => {
    const text = ctx.message?.text ?? "";
    const wantsAll = /^\/alljobs(?:@\w+)?(?:\s|$)/i.test(text);
    const contextKey = contextKeyFromCtx(ctx);
    if (!wantsAll && !contextKey) {
      return;
    }

    const laneKey = wantsAll ? undefined : contextKey ?? undefined;
    const jobs = agentSessions
      .listJobs(laneKey)
      .filter((job) => job.status === "running" || job.status === "waiting" || job.completedAt);

    if (jobs.length === 0) {
      const message = wantsAll ? "No provider jobs recorded." : "No provider jobs recorded in this lane.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const lines = [
      wantsAll ? "Provider jobs across all lanes:" : "Provider jobs in this lane:",
      ...jobs.slice(0, 20).map((job, index) => formatAgentJobLine(index + 1, job, agentSessions.getSession(job.sessionId))),
    ];
    const plain = lines.join("\n");
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  bot.command("provider", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const rawProvider = getCommandArgument(ctx);
    if (!rawProvider) {
      const lane = agentSessions.ensureLane(contextKey, { defaultProvider: registry.getActiveProvider(contextKey) });
      const plain = [
        `Selected provider: ${registry.getActiveProvider(contextKey)}`,
        `Default provider for new sessions: ${lane.defaultProvider}`,
        "",
        "Use /provider codex or /provider claude.",
      ].join("\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    const provider = parseProviderName(rawProvider);
    if (!provider || (provider !== "codex" && provider !== "claude")) {
      const message = "Usage: /provider codex or /provider claude";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }
    if (provider === "claude" && !config.enableClaudeProvider) {
      const message = "Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    agentSessions.ensureLane(contextKey, { defaultProvider: provider });
    agentSessions.setDefaultProvider(contextKey, provider);
    registry.setActiveProvider(contextKey, provider);
    persistAgentSessionState();
    const message = `Provider set to ${provider}. New bare /new sessions will use ${provider}.`;
    await safeReply(ctx, escapeHTML(message), { fallbackText: message });
  });

  bot.command("claude", async (ctx) => {
    const chatId = ctx.chat?.id;
    const contextKey = contextKeyFromCtx(ctx);
    if (!chatId || !contextKey) {
      return;
    }
    if (!config.enableClaudeProvider) {
      const message = "Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }
    const busyState = getBusyState(contextKey);
    if (busyState.switching || busyState.transcribing) {
      await safeReply(ctx, escapeHTML("Cannot switch providers while this lane is changing state."), {
        fallbackText: "Cannot switch providers while this lane is changing state.",
      });
      return;
    }

    registry.setActiveProvider(contextKey, "claude");
    const prompt = getCommandArgument(ctx);
    const descriptor = claudeSessions.get(contextKey);
    if (descriptor) {
      ensureAgentSessionRecord(contextKey, "claude", {
        workspace: descriptor.workspace,
        displayName: descriptor.displayName ?? "Claude Code",
        providerSessionId: descriptor.providerSessionId,
        select: true,
        metadata: descriptor.metadata,
      });
      await flushBufferedPriority(ctx, contextKey, descriptor, parseContextKey(contextKey).messageThreadId);
    }
    if (prompt) {
      startClaudePrompt(ctx, contextKey, chatId, prompt);
      return;
    }
    const message = isProviderBusy(contextKey, "claude")
      ? "Claude Code selected. A Claude turn is still running and future updates will be foreground here."
      : "Claude Code selected for this Telegram context. The next normal message will start or resume Claude.";
    await safeReply(ctx, escapeHTML(message), { fallbackText: message });
  });

  const handleClaudeLoginCommand = async (ctx: Context): Promise<void> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }
    await startClaudeLoginFlow(ctx, contextKey, getCommandArgument(ctx) || undefined);
  };

  bot.command(["claude_login", "claudelogin"], handleClaudeLoginCommand);
  bot.hears(/^\/claude-login(?:@\w+)?(?:\s+.*)?$/i, handleClaudeLoginCommand);

  bot.command("codex", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }
    const busyState = getBusyState(contextKey);
    if (busyState.switching || busyState.transcribing) {
      await safeReply(ctx, escapeHTML("Cannot switch providers while this lane is changing state."), {
        fallbackText: "Cannot switch providers while this lane is changing state.",
      });
      return;
    }

    registry.setActiveProvider(contextKey, "codex");
    const codexSession = registry.get(contextKey);
    if (codexSession) {
      const info = codexSession.getInfo();
      const record = ensureAgentSessionRecord(contextKey, "codex", {
        workspace: info.workspace,
        displayName: "Codex",
        providerSessionId: info.threadId ?? undefined,
        select: true,
        metadata: {
          model: info.model,
          reasoningEffort: info.reasoningEffort,
          backend: registry.getBackend(contextKey),
        },
      });
      await flushBufferedPriority(ctx, contextKey, record, parseContextKey(contextKey).messageThreadId);
    }
    const message = isProviderBusy(contextKey, "codex")
      ? "Codex selected. A Codex turn is still running and future updates will be foreground here."
      : "Codex selected for this Telegram context.";
    await safeReply(ctx, escapeHTML(message), { fallbackText: message });
  });

  bot.command("auth", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    const icon = authStatus.authenticated ? "✅" : "❌";
    const html = [
      `<b>${icon} Auth status:</b> ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `<b>Method:</b> <code>${escapeHTML(authStatus.method)}</code>`,
      `<b>Detail:</b> <code>${escapeHTML(authStatus.detail)}</code>`,
    ].join("\n");
    const plain = [
      `${icon} Auth status: ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `Method: ${authStatus.method}`,
      `Detail: ${authStatus.detail}`,
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("login", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.authenticated) {
      await safeReply(ctx, `<b>✅ Already authenticated</b> via <code>${escapeHTML(authStatus.method)}</code>.`, {
        fallbackText: `✅ Already authenticated via ${authStatus.method}.`,
      });
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(
        ctx,
        [
          "<b>Telegram-initiated login is disabled.</b>",
          "",
          "Run <code>codex login</code> on the host, or set CODEX_API_KEY in .env.",
        ].join("\n"),
        {
          fallbackText: [
            "Telegram-initiated login is disabled.",
            "",
            "Run 'codex login' on the host, or set CODEX_API_KEY in .env.",
          ].join("\n"),
        },
      );
      return;
    }

    const result = await startLogin();
    if (result.success) {
      await safeReply(ctx, `<b>🔑 Login initiated.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
        fallbackText: `🔑 Login initiated.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Login failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Login failed.\n\n${result.message}`,
    });
  });

  bot.command("logout", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.method === "api-key") {
      await safeReply(
        ctx,
        [
          "<b>Cannot logout via Telegram when using CODEX_API_KEY.</b>",
          "",
          "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
        ].join("\n"),
        {
          fallbackText: [
            "Cannot logout via Telegram when using CODEX_API_KEY.",
            "",
            "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
          ].join("\n"),
        },
      );
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(ctx, [
        "<b>Telegram-initiated auth management is disabled.</b>",
        "",
        "Run <code>codex logout</code> on the host.",
      ].join("\n"), {
        fallbackText: [
          "Telegram-initiated auth management is disabled.",
          "",
          "Run 'codex logout' on the host.",
        ].join("\n"),
      });
      return;
    }

    if (!authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("Not currently authenticated."), {
        fallbackText: "Not currently authenticated.",
      });
      return;
    }

    const result = await startLogout();
    if (result.success) {
      await safeReply(ctx, `<b>🔓 Logged out.</b>\n\n${escapeHTML(result.message)}`, {
        fallbackText: `🔓 Logged out.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Logout failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Logout failed.\n\n${result.message}`,
    });
  });

  bot.command("voice", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const backends = await getAvailableBackends().catch(() => []);

    if (backends.length === 0) {
      await safeReply(
        ctx,
        [
          "<b>Voice transcription is not available.</b>",
          "",
          "Set <code>FASTER_WHISPER_PYTHON</code>, install <code>parakeet-coreml</code>, or set <code>OPENAI_API_KEY</code>.",
          "<i>Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.</i>",
        ].join("\n"),
        {
          fallbackText: [
            "Voice transcription is not available.",
            "",
            "Set FASTER_WHISPER_PYTHON, install parakeet-coreml, or set OPENAI_API_KEY.",
            "Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.",
          ].join("\n"),
        },
      );
      return;
    }

    const joined = backends.join(" + ");
    await safeReply(ctx, `<b>Voice backends:</b> <code>${escapeHTML(joined)}</code>`, {
      fallbackText: `Voice backends: ${joined}`,
    });
  });

  bot.command(["new", "fork"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }
    const rawContextKey = contextKeyFromCtx(ctx);
    const rawText = ctx.message?.text ?? "";
    const rawNewArg = rawText.replace(/^\/(?:new|fork)(?:@\w+)?\s*/i, "").trim();
    const providerPrefix = parseProviderPrefix(rawNewArg);
    const requestedProvider = providerPrefix?.provider;
    const remainingArg = providerPrefix?.rest ?? rawNewArg;

    // /fork on a Claude lane is a REAL fork: a new session continuing from the
    // current conversation state, original intact. /new stays "fresh session".
    if (
      rawContextKey &&
      commandNameFromSlashLine(rawText) === "fork" &&
      isClaudeActive(rawContextKey) &&
      requestedProvider !== "codex"
    ) {
      await forkClaudeConversation(ctx, rawContextKey, remainingArg || undefined);
      return;
    }

    if (rawContextKey && (requestedProvider === "claude" || (!requestedProvider && isClaudeActive(rawContextKey)))) {
      if (!config.enableClaudeProvider) {
        const message = "Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        return;
      }
      if (isProviderBusy(rawContextKey, "claude")) {
        await safeReply(ctx, escapeHTML("Cannot create a new Claude session while a prompt is running."), {
          fallbackText: "Cannot create a new Claude session while a prompt is running.",
        });
        return;
      }
      const requestedModel = parseClaudeModelArgument(remainingArg);
      if (remainingArg && !requestedModel) {
        const message = "Usage: /new claude, /new claude fable, /new claude sonnet, /new claude opus, /new claude haiku, or /new claude default.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        return;
      }
      registry.setActiveProvider(rawContextKey, "claude");
      try {
        const descriptor = await createFreshClaudeSession(rawContextKey, { model: requestedModel });
        const model = String(descriptor.metadata?.model ?? config.claudeDefaultModel);
        const message = `New Claude session selected with model ${model}. The next normal message will use it.`;
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      } catch (error) {
        const message = `Claude model change failed: ${friendlyErrorText(error)}`;
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      }
      return;
    }

    const contextSession = await getContextSession(ctx, {
      deferThreadStart: true,
      skipThreadResume: true,
    });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isProviderBusy(contextKey, "codex")) {
      await safeReply(ctx, escapeHTML("Cannot create a new thread while a prompt is running."), {
        fallbackText: "Cannot create a new thread while a prompt is running.",
      });
      return;
    }

    if (requestedProvider === "codex") {
      registry.setActiveProvider(contextKey, "codex");
    }

    const workspaceArg = remainingArg;
    if (workspaceArg) {
      if (/^(?:choose|list|workspace|workspaces)$/i.test(workspaceArg)) {
        await showWorkspacePicker(ctx, contextKey, session);
        return;
      }

      await createNewThreadFromWorkspaceText(ctx, workspaceArg);
      return;
    }

    try {
      const info = session.prepareNewThread(session.getCurrentWorkspace());
      updateSessionMetadata(contextKey, session);
      registry.setActiveProvider(contextKey, "codex");
      clearSessionSelectionState(contextKey);
      const label = isTopicContext(contextKey)
        ? "New Codex session ready for this topic. The thread will initialize with your next message."
        : "New Codex session ready. The thread will initialize with your next message.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;
      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  const showWorkspacePicker = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionRuntime,
  ): Promise<void> => {
    const workspaces = session.listWorkspaces();
    if (workspaces.length === 0) {
      await safeReply(ctx, escapeHTML("No known workspaces found. Use /new to start in the current workspace."), {
        fallbackText: "No known workspaces found. Use /new to start in the current workspace.",
      });
      return;
    }

    pendingWorkspacePicks.set(contextKey, workspaces);
    const currentWorkspace = session.getCurrentWorkspace();
    const workspaceButtons = workspaces.map((workspace, index) => ({
      label: `${workspace === currentWorkspace ? "📂" : "📁"} ${getWorkspaceShortName(workspace)}`,
      callbackData: `ws_${index}`,
    }));
    pendingWorkspaceButtons.set(contextKey, workspaceButtons);
    const keyboard = paginateKeyboard(workspaceButtons, 0, "ws");
    const selectionMessage = renderWorkspaceSelectionMessage(workspaces, currentWorkspace, config.workspace);

    await safeReply(ctx, selectionMessage.html, {
      fallbackText: selectionMessage.plain,
      replyMarkup: keyboard,
    });
  };

  bot.command(["workspaces", "workspace"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    await showWorkspacePicker(ctx, contextKey, session);
  });

  const createNewThreadFromWorkspaceText = async (ctx: Context, rawWorkspace: string): Promise<boolean> => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return true;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a new thread while a prompt is running."), {
        fallbackText: "Cannot create a new thread while a prompt is running.",
      });
      return true;
    }

    const workspaces = session.listWorkspaces();
    const workspace = resolveWorkspaceArgument(rawWorkspace, workspaces, config.workspace);
    if (!workspace) {
      const selectionMessage = renderWorkspaceSelectionMessage(workspaces, session.getCurrentWorkspace(), config.workspace);
      await safeReply(ctx, selectionMessage.html, { fallbackText: selectionMessage.plain });
      return true;
    }

    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    try {
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
      registry.setActiveProvider(contextKey, "codex");
      ensureAgentSessionRecord(contextKey, "codex", {
        workspace: info.workspace,
        displayName: resolveCodexSessionDisplayName(info.threadId, "Codex"),
        providerSessionId: info.threadId ?? undefined,
        select: true,
        metadata: {
          model: info.model,
          reasoningEffort: info.reasoningEffort,
          backend: registry.getBackend(contextKey),
        },
      });
      clearSessionSelectionState(contextKey);
      const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;
      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }

    return true;
  };

  bot.command(["abort", "stop"], async (ctx) => {
    const rawContextKey = contextKeyFromCtx(ctx);
    if (rawContextKey && isClaudeActive(rawContextKey)) {
      const descriptor = claudeSessions.get(rawContextKey);
      if (!descriptor || !claudeAdapter) {
        const message = "No Claude operation is active here.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        return;
      }
      try {
        await claudeAdapter.abort(descriptor.id);
        await safeReply(ctx, escapeHTML("Abort sent to Claude."), {
          fallbackText: "Abort sent to Claude.",
        });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      } finally {
        getBusyState(rawContextKey).processing = false;
      }
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    try {
      await session.abort();
      await safeReply(ctx, escapeHTML("Aborted current operation"), {
        fallbackText: "Aborted current operation",
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      queuedPrompts.delete(contextKey);
      activeProgressRefreshers.delete(contextKey);
      getBusyState(contextKey).processing = false;
    }
  });

  bot.command("steer", async (ctx) => {
    const prompt = getCommandArgument(ctx);
    if (!prompt) {
      await safeReply(ctx, escapeHTML("Usage: /steer <instruction>"), {
        fallbackText: "Usage: /steer <instruction>",
      });
      return;
    }

    const rawContextKey = contextKeyFromCtx(ctx);
    const chatId = ctx.chat?.id;
    if (rawContextKey && chatId && isClaudeActive(rawContextKey)) {
      await routeClaudeSteer({
        ctx,
        chatId,
        messageThreadId: parseContextKey(rawContextKey).messageThreadId,
      }, rawContextKey, prompt);
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (!isBusy(contextKey)) {
      pendingIdleSteers.set(contextKey, {
        text: prompt,
        provider: "codex",
        expiresAt: Date.now() + IDLE_STEER_CONFIRM_TTL_MS,
      });
      const message = "No Codex turn is running. Reply y to start a new turn with this steer text, or n to discard it.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }
    if (!session.steer) {
      await safeReply(ctx, escapeHTML("Native steering requires the app-server backend. The live backend is still SDK."), {
        fallbackText: "Native steering requires the app-server backend. The live backend is still SDK.",
      });
      return;
    }

    try {
      await session.steer(prompt);
      await safeReply(ctx, escapeHTML("Steer sent."), { fallbackText: "Steer sent." });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  // y/n answers to the idle-steer question above. Passes through to the normal
  // text pipeline when nothing is pending, so a literal "y" message still reaches
  // the provider in every other situation.
  bot.hears(/^(y|yes|n|no)[.!]?$/i, async (ctx, next) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      await next();
      return;
    }
    const pending = pendingIdleSteers.get(contextKey);
    if (!pending) {
      await next();
      return;
    }
    pendingIdleSteers.delete(contextKey);
    if (Date.now() > pending.expiresAt) {
      // Don't fall through: that would send a literal "y"/"n" to the agent as a prompt.
      const message = "That steer confirmation expired, so I discarded the steer text. Send /steer again if you still want it.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const confirmed = (ctx.match?.[1] ?? "").toLowerCase().startsWith("y");
    if (!confirmed) {
      await safeReply(ctx, escapeHTML("Discarded the steer text."), { fallbackText: "Discarded the steer text." });
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }
    if (pending.provider === "claude") {
      lastPromptInput.set(contextKey, pending.text);
      await setReaction(ctx, "👀");
      startClaudePrompt(ctx, contextKey, chatId, pending.text);
      return;
    }
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }
    if (isBusy(contextKey)) {
      await queuePromptReply(ctx, contextKey, chatId, contextSession.session, pending.text);
      return;
    }
    lastPromptInput.set(contextKey, pending.text);
    await setReaction(ctx, "👀");
    startUserPrompt(ctx, contextKey, chatId, contextSession.session, pending.text);
  });

  bot.command("goal", async (ctx) => {
    const parsedGoal = parseGoalModeArgument(getCommandArgument(ctx));
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const { contextKey, session } = contextSession;
    const getThreadGoal = session.getThreadGoal?.bind(session);
    const setThreadGoal = session.setThreadGoal?.bind(session);
    const clearThreadGoal = session.clearThreadGoal?.bind(session);
    const runThreadGoal = session.runThreadGoal?.bind(session);
    if (!getThreadGoal || !setThreadGoal || !clearThreadGoal || !runThreadGoal) {
      const text = "Native goal controls require the app-server backend. Use /backend appserver.";
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    const replyGoal = async (goal: Awaited<ReturnType<typeof getThreadGoal>>): Promise<void> => {
      const text = formatThreadGoal(goal);
      await safeReply(ctx, formatTelegramHTML(text), { fallbackText: text });
    };

    if (parsedGoal.kind === "status") {
      if (!session.hasActiveThread()) {
        await replyGoal(null);
        return;
      }
      try {
        const goal = await getThreadGoal();
        if (goal?.status === "active" && session.getProcessingKind?.() !== "goal") {
          const note = [
            "Goal is marked active, but TeleCode is not currently attached to a running goal monitor.",
            "Use /goal resume to reattach and continue progress updates, or /goal pause to stop it.",
            "",
            formatThreadGoal(goal),
          ].join("\n");
          await safeReply(ctx, formatTelegramHTML(note), { fallbackText: note });
          return;
        }
        await replyGoal(goal);
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    if (parsedGoal.kind === "pause" || parsedGoal.kind === "clear") {
      try {
        if (isBusy(contextKey)) {
          if (session.getProcessingKind?.() === "goal" && session.pauseActiveGoal) {
            await session.pauseActiveGoal();
          } else {
            await session.abort();
          }
          queuedPrompts.delete(contextKey);
          activeProgressRefreshers.delete(contextKey);
          getBusyState(contextKey).processing = false;
        }

        if (!session.hasActiveThread()) {
          await replyGoal(null);
          return;
        }

        if (parsedGoal.kind === "clear") {
          const cleared = await clearThreadGoal();
          const text = cleared ? "Goal cleared." : "No goal is currently set for this thread.";
          await safeReply(ctx, formatTelegramHTML(text), { fallbackText: text });
          return;
        }

        const existingGoal = await getThreadGoal();
        if (!existingGoal) {
          await replyGoal(null);
          return;
        }
        await replyGoal(await setThreadGoal({ status: "paused" }));
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    if (isBusy(contextKey)) {
      const text =
        parsedGoal.kind === "resume"
          ? "A goal or prompt is already running. Use /goal pause or /abort to stop it."
          : "Cannot start or replace a goal while Codex is working. Use /goal pause first if this is a running goal.";
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    await setReaction(ctx, "👀");
    if (parsedGoal.kind === "resume") {
      if (!session.hasActiveThread()) {
        await replyGoal(null);
        return;
      }
      const existingGoal = await getThreadGoal().catch(() => null);
      if (!existingGoal) {
        await replyGoal(null);
        return;
      }

      startUserPrompt(ctx, contextKey, chatId, session, `Resume goal: ${existingGoal.objective}`, {
        addOutputInstructions: false,
        finalizeOnAgentEnd: false,
        execute: async (callbacks) => {
          const finalGoal = await runThreadGoal({ status: "active" }, callbacks);
          callbacks.onTextDelta(`\n\n${formatThreadGoal(finalGoal)}`);
        },
      });
      return;
    }

    const objective = applyGoalModeConstraints(parsedGoal.objective, { noAgents: parsedGoal.noAgents });
    if (!objective.trim()) {
      const text = "Usage: /goal [no-agents] <task>";
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    if (!(await ensureActiveThread(ctx, contextKey, session))) {
      return;
    }

    startUserPrompt(ctx, contextKey, chatId, session, `Goal: ${parsedGoal.objective}`, {
      addOutputInstructions: false,
      finalizeOnAgentEnd: false,
      execute: async (callbacks) => {
        const finalGoal = await runThreadGoal({ objective, status: "active" }, callbacks);
        callbacks.onTextDelta(`\n\n${formatThreadGoal(finalGoal)}`);
      },
    });
  });

  bot.command("forkthread", async (ctx) => {
    const rawCount = getCommandArgument(ctx).trim();
    const rollbackCount = rawCount ? Number(rawCount) : 0;
    if (!Number.isInteger(rollbackCount) || rollbackCount < 0) {
      await safeReply(ctx, escapeHTML("Usage: /forkthread or /forkthread <turn-count>"), {
        fallbackText: "Usage: /forkthread or /forkthread <turn-count>",
      });
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot fork while a prompt is running."), {
        fallbackText: "Cannot fork while a prompt is running.",
      });
      return;
    }

    if (!session.forkThread) {
      await safeReply(ctx, escapeHTML("Native thread fork requires the app-server backend. The live backend is still SDK."), {
        fallbackText: "Native thread fork requires the app-server backend. The live backend is still SDK.",
      });
      return;
    }

    if (rollbackCount > 0 && !session.rollbackThread) {
      await safeReply(ctx, escapeHTML("Fork rollback requires the app-server backend. The live backend is still SDK."), {
        fallbackText: "Fork rollback requires the app-server backend. The live backend is still SDK.",
      });
      return;
    }

    try {
      if (rollbackCount > 0 && session.getTurnCount) {
        const turnCount = await session.getTurnCount();
        if (rollbackCount >= turnCount) {
          const plain = [
            `Cannot fork and roll back ${rollbackCount} turns.`,
            `This thread currently has ${turnCount} persisted Codex turn${turnCount === 1 ? "" : "s"}.`,
            "Use a smaller number so the fork keeps some context.",
          ].join("\n");
          await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
          return;
        }
      }

      const info = await session.forkThread();
      if (rollbackCount > 0) {
        await session.rollbackThread?.(rollbackCount);
      }
      updateSessionMetadata(contextKey, session);
      const latestInfo = session.getInfo();
      const rollbackText =
        rollbackCount > 0
          ? ` Rolled back ${rollbackCount} turn${rollbackCount === 1 ? "" : "s"} on the fork. File changes were not reverted.`
          : "";
      const plain = `Forked thread.${rollbackText}\n\n${renderSessionInfoPlain(latestInfo)}`;
      const html = `<b>Forked thread.</b>${escapeHTML(rollbackText)}\n\n${renderSessionInfoHTML(latestInfo)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("renamethread", async (ctx) => {
    const name = getCommandArgument(ctx).trim();
    if (!name) {
      await safeReply(ctx, escapeHTML("Usage: /renamethread <name>"), {
        fallbackText: "Usage: /renamethread <name>",
      });
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot rename while a prompt is running."), {
        fallbackText: "Cannot rename while a prompt is running.",
      });
      return;
    }

    if (!session.renameThread) {
      await safeReply(ctx, escapeHTML("Native thread rename requires the app-server backend. The live backend is still SDK."), {
        fallbackText: "Native thread rename requires the app-server backend. The live backend is still SDK.",
      });
      return;
    }

    try {
      await session.renameThread(name);
      await safeReply(ctx, escapeHTML("Thread renamed."), { fallbackText: "Thread renamed." });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("rollbackthread", async (ctx) => {
    const rawCount = getCommandArgument(ctx).trim() || "1";
    const turnCount = Number(rawCount);
    if (!Number.isInteger(turnCount) || turnCount < 1) {
      await safeReply(ctx, escapeHTML("Usage: /rollbackthread <turn-count>"), {
        fallbackText: "Usage: /rollbackthread <turn-count>",
      });
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot roll back while a prompt is running."), {
        fallbackText: "Cannot roll back while a prompt is running.",
      });
      return;
    }

    if (!session.rollbackThread) {
      await safeReply(ctx, escapeHTML("Native thread rollback requires the app-server backend. The live backend is still SDK."), {
        fallbackText: "Native thread rollback requires the app-server backend. The live backend is still SDK.",
      });
      return;
    }

    try {
      await session.rollbackThread(turnCount);
      await safeReply(ctx, escapeHTML(`Rolled back ${turnCount} turn${turnCount === 1 ? "" : "s"}. File changes were not reverted.`), {
        fallbackText: `Rolled back ${turnCount} turn${turnCount === 1 ? "" : "s"}. File changes were not reverted.`,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("retry", async (ctx) => {
    const rawContextKey = contextKeyFromCtx(ctx);
    const rawChatId = ctx.chat?.id;
    if (rawContextKey && rawChatId && isClaudeActive(rawContextKey)) {
      if (isBusy(rawContextKey)) {
        await sendBusyReply(ctx);
        return;
      }
      const cachedClaude = lastPromptInput.get(rawContextKey);
      if (typeof cachedClaude !== "string" || !cachedClaude.trim()) {
        await safeReply(ctx, escapeHTML("Nothing to retry. Send a message first."), {
          fallbackText: "Nothing to retry. Send a message first.",
        });
        return;
      }
      await setReaction(ctx, "👀");
      startClaudePrompt(ctx, rawContextKey, rawChatId, cachedClaude);
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const cached = lastPromptInput.get(contextKey);
    if (!cached) {
      await safeReply(ctx, escapeHTML("Nothing to retry. Send a message first."), {
        fallbackText: "Nothing to retry. Send a message first.",
      });
      return;
    }

    await setReaction(ctx, "👀");
    startUserPrompt(ctx, contextKey, chatId, session, cached);
  });

  bot.command(["copy", "last", "repeat"], async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const reply = getFocusedAssistantReply(contextKey);
    if (!reply) {
      await safeReply(ctx, escapeHTML("No assistant reply has been captured for the selected provider session yet."), {
        fallbackText: "No assistant reply has been captured for the selected provider session yet.",
      });
      return;
    }

    const rendered = formatMarkdownMessage(reply);
    await safeReply(ctx, rendered.text, {
      parseMode: rendered.parseMode,
      fallbackText: rendered.fallbackText,
    });
  });

  bot.command("clear", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot clear while a prompt is running. Use /stop first."), {
        fallbackText: "Cannot clear while a prompt is running. Use /stop first.",
      });
      return;
    }

    if (isClaudeActive(contextKey)) {
      await forgetClaudeSession(contextKey);
      const message = "Cleared this Claude session. The next message will start a fresh Claude session.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    registry.remove(contextKey);
    await safeReply(ctx, escapeHTML("Cleared this Telegram context. The next message will start a fresh Codex thread."), {
      fallbackText: "Cleared this Telegram context. The next message will start a fresh Codex thread.",
    });
  });

  bot.command(["session", "status"], async (ctx) => {
    const rawContextKey = contextKeyFromCtx(ctx);
    if (rawContextKey && isClaudeActive(rawContextKey)) {
      const descriptor = claudeSessions.get(rawContextKey);
      const persisted = claudeState?.get(rawContextKey);
      const lines = descriptor
        ? renderClaudeSessionPlain(descriptor, await claudeAdapter?.getContext(descriptor.id))
        : persisted
          ? [
              "Claude session:",
              `Session UUID: ${persisted.sessionId}`,
              `Workspace: ${persisted.workspace}`,
              `Model: ${persisted.model}`,
              `Permission mode: ${persisted.permissionMode}`,
              "Status: not attached, will resume on next message",
            ].join("\n")
          : [
              "Claude session:",
              "Status: not started yet",
              `Workspace: ${config.claudeWorkspace}`,
              `Model: ${config.claudeDefaultModel}`,
              `Permission mode: ${config.claudePermissionMode}`,
            ].join("\n");
      await safeReply(ctx, formatTelegramHTML(lines), { fallbackText: lines });
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const contextLabel = isTopicContext(contextKey) ? "Topic session" : "Chat session";

    const plainLines = [`${contextLabel}:`, renderSessionInfoPlain(info)];
    const htmlLines = [`<b>${escapeHTML(contextLabel)}:</b>`, renderSessionInfoHTML(info)];

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  bot.command("usage", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (contextKey && isClaudeActive(contextKey)) {
      await sendClaudeUsageReport(ctx, contextKey, parseContextKey(contextKey).messageThreadId);
      return;
    }

    try {
      const cached = await readLatestCodexUsage();
      let snapshot = cached;
      try {
        const liveResponse = await readCodexAppServerRateLimits(config);
        snapshot = mergeLiveAppServerRateLimits(cached, liveResponse);
      } catch (error) {
        console.warn("Fresh app-server usage read failed; using cached session data", error);
      }
      const plain = renderUsagePlain(snapshot);
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
    } catch (error) {
      const message = `Failed to read usage: ${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
    }
  });

  bot.command("mcp", async (ctx) => {
    const arg = getCommandArgument(ctx).trim().toLowerCase();
    const servers = listConfiguredCodexMcpServers();
    const serverList = servers.length > 0 ? servers.join(", ") : "none found in config.toml";

    if (arg !== "on" && arg !== "off") {
      const state = registry.getCodexMcpEnabled() ? "ON" : "OFF";
      const plain = [
        `Codex MCP tools are ${state}.`,
        `Configured servers: ${serverList}.`,
        "Use /mcp on to enable them (browser and computer-use tools; the next thread start pays their cold start) or /mcp off to keep Codex fast.",
      ].join("\n");
      await safeReply(ctx, escapeHTML(plain), { fallbackText: plain });
      return;
    }

    const enable = arg === "on";
    const { resetSessions, busySessions } = registry.setCodexMcpEnabled(enable);
    bridgeLog("mcp", `toggle ${enable ? "on" : "off"} servers=${serverList} reset=${resetSessions} busy=${busySessions}`);
    const lines = enable
      ? [
          `Codex MCP tools ON: ${serverList}.`,
          "They load at the next thread start or resume; the first turn can take up to a minute while they cold-start.",
        ]
      : [
          `Codex MCP tools OFF: ${serverList} stay disabled.`,
          "New and resumed Codex threads skip them, so turns start fast.",
        ];
    if (busySessions > 0) {
      lines.push(`${busySessions} busy session(s) will pick this up after their current turn.`);
    }
    const plain = lines.join("\n");
    await safeReply(ctx, escapeHTML(plain), { fallbackText: plain });
  });

  bot.command(["appserver", "appserverstatus", "appserver_status"], async (ctx) => {
    const result = await probeCodexAppServer(config);
    const plain = renderAppServerProbePlain(result);
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  bot.command(["appserverturn", "apprun"], async (ctx) => {
    const prompt = getCommandArgument(ctx);
    if (!prompt) {
      const plain = "Usage: /appserverturn <prompt>";
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    await safeReply(ctx, escapeHTML("Running isolated app-server turn..."), {
      fallbackText: "Running isolated app-server turn...",
    });
    const result = await runCodexAppServerTurn(config, prompt);
    const plain = renderAppServerTurnPlain(result);
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  bot.command(["appserversteer", "appsteer"], async (ctx) => {
    const raw = getCommandArgument(ctx);
    const separator = raw.indexOf("||");
    if (separator === -1) {
      const plain = "Usage: /appserversteer <initial prompt> || <steer prompt>";
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    const initialPrompt = raw.slice(0, separator).trim();
    const steerPrompt = raw.slice(separator + 2).trim();
    if (!initialPrompt || !steerPrompt) {
      const plain = "Usage: /appserversteer <initial prompt> || <steer prompt>";
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    await safeReply(ctx, escapeHTML("Running isolated app-server steer test..."), {
      fallbackText: "Running isolated app-server steer test...",
    });
    const result = await runCodexAppServerSteeredTurn(config, initialPrompt, steerPrompt);
    const plain = renderAppServerSteerPlain(result);
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  bot.command(["appbackendtest", "appsmoke"], async (ctx) => {
    await safeReply(ctx, escapeHTML("Running app-server backend smoke test..."), {
      fallbackText: "Running app-server backend smoke test...",
    });

    const startedAt = Date.now();
    const steps: string[] = [];
    let session: CodexSessionRuntime | undefined;
    try {
      session = await createCodexSession(
        { ...config, codexBackend: "app-server" },
        { deferThreadStart: true, workspace: config.workspace, model: config.codexModel },
      );
      steps.push("created backend runtime");

      const info = await session.newThread(config.workspace, config.codexModel);
      steps.push(`started thread ${info.threadId ?? "(unknown)"}`);

      const firstReply = (await session.runText("Reply with exactly OK.")).trim();
      steps.push(`prompt returned ${firstReply || "(empty)"}`);
      if (normalizeSmokeReply(firstReply) !== "OK") {
        throw new Error(`Expected OK from first prompt, got ${firstReply || "(empty)"}`);
      }

      if (session.renameThread) {
        await session.renameThread(`TeleCode smoke ${new Date().toISOString()}`);
        steps.push("renamed thread");
      }

      if (session.forkThread) {
        const forked = await session.forkThread();
        steps.push(`forked thread ${forked.threadId ?? "(unknown)"}`);
        const forkReply = (await session.runText("Reply with exactly FORK_OK.")).trim();
        steps.push(`fork prompt returned ${forkReply || "(empty)"}`);
        if (normalizeSmokeReply(forkReply) !== "FORK_OK") {
          throw new Error(`Expected FORK_OK from fork prompt, got ${forkReply || "(empty)"}`);
        }
      }

      if (session.rollbackThread) {
        await session.rollbackThread(1);
        steps.push("rolled back one turn");
      }

      const plain = [
        "App-server backend smoke test:",
        `Status: ok`,
        `Duration: ${Date.now() - startedAt} ms`,
        "",
        ...steps.map((step) => `- ${step}`),
      ].join("\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
    } catch (error) {
      const plain = [
        "App-server backend smoke test:",
        "Status: failed",
        `Duration: ${Date.now() - startedAt} ms`,
        `Error: ${friendlyErrorText(error)}`,
        "",
        ...steps.map((step) => `- ${step}`),
      ].join("\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
    } finally {
      session?.dispose();
    }
  });

  bot.command(["artifacttest", "filetest"], async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    const chatId = ctx.chat?.id;
    if (!contextKey || !chatId) {
      return;
    }

    const turnId = `artifacttest-${randomUUID().slice(0, 8)}`;
    const session = registry.get(contextKey);
    const workspace = session?.getCurrentWorkspace() ?? config.workspace;
    const outDir = outboxPath(workspace, turnId);
    const filePath = path.join(outDir, "telecode-artifact-test.txt");
    const content = [
      "TeleCode artifact delivery test",
      `Created: ${new Date().toISOString()}`,
      `Backend: ${registry.getBackend(contextKey)}`,
      `Workspace: ${workspace}`,
      "",
      "If this file arrived in Telegram, generated artifact delivery is working.",
    ].join("\n");

    try {
      await ensureOutDir(outDir);
      await writeFile(filePath, content, "utf8");
      await deliverArtifacts(ctx, chatId, outDir, parseContextKey(contextKey).messageThreadId);
    } catch (error) {
      const plain = `Artifact test failed: ${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(plain), { fallbackText: plain });
    }
  });

  bot.command("backend", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    // When Claude is the active provider, /backend controls the CLAUDE engine
    // (pty = interactive terminal, sdk = Agent SDK with full narration).
    if (isClaudeActive(contextKey)) {
      const rawClaudeBackend = getCommandArgument(ctx)?.trim().toLowerCase();
      if (!rawClaudeBackend) {
        const current = getClaudeBackend(contextKey);
        const plain = [
          `Claude engine for this Telegram context: ${current}`,
          "",
          "Available: pty, sdk",
          "",
          "Use /backend sdk for the Agent SDK engine (structured events, full progress narration).",
          "Use /backend pty for the interactive terminal engine.",
          "The choice persists for this Telegram context and takes effect from the next turn.",
          "To change the Codex backend instead, switch with /codex first.",
        ].join("\n");
        await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
        return;
      }
      if (rawClaudeBackend !== "pty" && rawClaudeBackend !== "sdk") {
        const plain = "Usage while Claude is active: /backend pty or /backend sdk";
        await safeReply(ctx, escapeHTML(plain), { fallbackText: plain });
        return;
      }
      claudeBackendPrefs?.set(contextKey, rawClaudeBackend);
      const descriptor = claudeSessions.get(contextKey);
      if (descriptor && claudeAdapter) {
        try {
          await claudeAdapter.setBackend?.(descriptor.id, rawClaudeBackend);
          const refreshed = await claudeAdapter.getSessionInfo(descriptor.id);
          claudeSessions.set(contextKey, refreshed);
          persistClaudeSession(contextKey, refreshed);
        } catch (error) {
          console.warn("Failed to apply Claude backend to the live session", error);
        }
      }
      const busyNote = isProviderBusy(contextKey, "claude")
        ? " The running turn finishes on its current engine; the switch applies from the next turn."
        : " It takes effect from the next turn, on the same conversation.";
      const plain = `Claude engine for this Telegram context is now ${rawClaudeBackend}. This persists across restarts.${busyNote}`;
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    const rawBackend = getCommandArgument(ctx);
    if (!rawBackend) {
      const current = registry.getBackend(contextKey);
      const plain = [
        `Backend for this Telegram context: ${current}`,
        "",
        "Available: sdk, app-server",
        "",
        "Use /backend sdk to force the safe SDK backend.",
        "Use /backend appserver to switch this context to app-server.",
        "The choice persists for this Telegram context across restarts.",
      ].join("\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    const requestedBackend = resolveBackendArgument(rawBackend);
    if (!requestedBackend) {
      await safeReply(ctx, escapeHTML("Usage: /backend sdk or /backend appserver"), {
        fallbackText: "Usage: /backend sdk or /backend appserver",
      });
      return;
    }

    const activeSession = registry.get(contextKey);
    if (activeSession?.isProcessing()) {
      await safeReply(ctx, escapeHTML("Cannot switch backend while a prompt is running. Use /abort first if it is stuck."), {
        fallbackText: "Cannot switch backend while a prompt is running. Use /abort first if it is stuck.",
      });
      return;
    }

    if (requestedBackend === "app-server") {
      await safeReply(ctx, escapeHTML("Checking app-server before switching..."), {
        fallbackText: "Checking app-server before switching...",
      });
      const probe = await probeCodexAppServer(config);
      if (!probe.ok) {
        const plain = [
          "App-server probe failed. Backend was not changed.",
          `Error: ${probe.error}`,
          "",
          "Use /backend sdk to stay on the safe backend.",
        ].join("\n");
        await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
        return;
      }
    }

    registry.setBackend(contextKey, requestedBackend);
    queuedPrompts.delete(contextKey);
    const busyState = getBusyState(contextKey);
    busyState.processing = false;
    busyState.switching = false;
    busyState.transcribing = false;

    const plain =
      requestedBackend === "app-server"
        ? "Backend for this Telegram context is now app-server. This persists across restarts. Use /backend sdk to switch back."
        : "Backend for this Telegram context is now sdk. This persists across restarts.";
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  bot.command(["verbosity", "velocity", "progress"], async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const rawMode = getCommandArgument(ctx);
    if (!rawMode) {
      const current = registry.getProgressDelivery(contextKey);
      const plain = [
        `Progress delivery for this Telegram context: ${current}`,
        "",
        "Use /verbosity messages for separate progress messages.",
        "Use /verbosity edit for one rolling edited progress message.",
        "Use /verbosity none for final answers only.",
      ].join("\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    const requested = resolveVerbosityArgument(rawMode);
    if (!requested) {
      await safeReply(ctx, escapeHTML("Usage: /verbosity messages, /verbosity edit, or /verbosity none"), {
        fallbackText: "Usage: /verbosity messages, /verbosity edit, or /verbosity none",
      });
      return;
    }

    registry.setProgressDelivery(contextKey, requested);
    if (requested === "edit") {
      void activeProgressRefreshers.get(contextKey)?.().catch((error) => {
        console.error("Failed to refresh progress after verbosity switch", error);
      });
    }
    const busyNote = isBusy(contextKey)
      ? "This applies to future progress updates. Messages already sent in the current turn stay as they are."
      : "";
    const plain = [
      `Progress delivery set to ${requested}.`,
      requested === "messages"
        ? "I will send separate progress messages and keep the final answer clean."
        : requested === "edit"
          ? "I will keep one rolling progress message updated, then send the final answer separately."
          : "I will send only the final answer unless there is an error.",
      busyNote,
    ].filter(Boolean).join("\n");
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  const setLaunchProfileFromCommand = async (ctx: Context, rawProfile: string): Promise<boolean> => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return true;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change launch profile while a prompt is running."), {
        fallbackText: "Cannot change launch profile while a prompt is running.",
      });
      return true;
    }

    const wantsConfirm = /\bconfirm\b/i.test(rawProfile);
    const requested = rawProfile.replace(/\bconfirm\b/gi, "").trim().toLowerCase();
    const profile = config.launchProfiles.find(
      (candidate) =>
        candidate.id.toLowerCase() === requested ||
        candidate.label.toLowerCase() === requested ||
        candidate.label.toLowerCase().replace(/\s+/g, "-") === requested,
    );

    if (!profile) {
      const available = config.launchProfiles.map((candidate) => candidate.id).join(", ");
      await safeReply(ctx, escapeHTML(`Usage: /launch_profiles <${available}>`), {
        fallbackText: `Usage: /launch_profiles <${available}>`,
      });
      return true;
    }

    if (profile.unsafe && !wantsConfirm) {
      const text = `Profile ${profile.label} uses danger-full-access. Send /launch_profiles ${profile.id} confirm to select it.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return true;
    }

    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);
    const text = `Launch profile set to ${selectedProfile.label} (${formatLaunchProfileBehavior(selectedProfile)}). It applies to new or reattached threads.`;
    await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    return true;
  };

  const openLaunchProfilesPicker = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const profileArg = rawText.replace(/^\/(?:launch|launch_profiles)(?:@\w+)?\s*/i, "").trim();
    if (profileArg) {
      await setLaunchProfileFromCommand(ctx, profileArg);
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change launch profile while a prompt is running."), {
        fallbackText: "Cannot change launch profile while a prompt is running.",
      });
      return;
    }

    const info = session.getInfo();
    const selectedLaunchProfile = session.getSelectedLaunchProfile();
    const launchButtons = config.launchProfiles.map((profile, index) => ({
      label: formatLaunchProfileLabel(profile, profile.id === selectedLaunchProfile.id),
      callbackData: `launch_${index}`,
    }));

    pendingLaunchPicks.set(
      contextKey,
      config.launchProfiles.map((profile) => profile.id),
    );
    pendingLaunchButtons.set(contextKey, launchButtons);
    pendingUnsafeLaunchConfirmations.delete(contextKey);

    const keyboard = paginateKeyboard(launchButtons, 0, "launch");
    // Enumerate profiles in the message text so the picker works without buttons.
    const plainProfileLines = config.launchProfiles.map((profile, index) => {
      const marker = profile.id === selectedLaunchProfile.id ? " (selected)" : "";
      const unsafeNote = profile.unsafe ? " [danger-full-access, needs confirm]" : "";
      return `${index + 1}. ${profile.id} - ${formatLaunchProfileBehavior(profile)}${unsafeNote}${marker}`;
    });
    const htmlProfileLines = config.launchProfiles.map((profile, index) => {
      const marker = profile.id === selectedLaunchProfile.id ? " <i>(selected)</i>" : "";
      const unsafeNote = profile.unsafe ? " ⚠️ <i>danger-full-access, needs confirm</i>" : "";
      return `${index + 1}. <code>${escapeHTML(profile.id)}</code> - ${escapeHTML(formatLaunchProfileBehavior(profile))}${unsafeNote}${marker}`;
    });
    const htmlLines = [
      `<b>Selected launch profile:</b> <code>${escapeHTML(selectedLaunchProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedLaunchProfile))}</code>`,
      "",
      "Profiles for new or reattached threads. Send /launch &lt;id&gt; to select (add confirm for unsafe ones):",
      ...htmlProfileLines,
    ];
    const plainLines = [
      `Selected launch profile: ${selectedLaunchProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedLaunchProfile)}`,
      "",
      "Profiles for new or reattached threads. Send /launch <id> to select (add confirm for unsafe ones):",
      ...plainProfileLines,
    ];

    if (selectedLaunchProfile.unsafe) {
      htmlLines.splice(2, 0, "⚠️ <i>Selected profile uses danger-full-access.</i>");
      plainLines.splice(2, 0, "⚠️ Selected profile uses danger-full-access.");
    }

    if (info.nextLaunchProfileId) {
      htmlLines.splice(2, 0, `<b>Active thread still uses:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`);
      plainLines.splice(2, 0, `Active thread still uses: ${info.launchProfileLabel}`);
    }

    await safeReply(ctx, htmlLines.join("\n"), {
      fallbackText: plainLines.join("\n"),
      replyMarkup: keyboard,
    });
  };

  bot.command(["launch", "launch_profiles"], openLaunchProfilesPicker);
  bot.hears(/^\/launch-profiles(?:@\w+)?$/i, openLaunchProfilesPicker);
  bot.hears(/^(?:launch|launch_profiles|launch profile)\s+(.+)/i, async (ctx, next) => {
    const rawContextKey = contextKeyFromCtx(ctx);
    const requested = (ctx.match[1] ?? "").replace(/\bconfirm\b/gi, "").trim().toLowerCase();
    const knownProfile = config.launchProfiles.some(
      (candidate) =>
        candidate.id.toLowerCase() === requested ||
        candidate.label.toLowerCase() === requested ||
        candidate.label.toLowerCase().replace(/\s+/g, "-") === requested,
    );
    if (!rawContextKey || isClaudeActive(rawContextKey) || !knownProfile) {
      // Not a shortcut ("launch the app and test it"): pass through to the agent.
      await next();
      return;
    }
    await setLaunchProfileFromCommand(ctx, ctx.match[1] ?? "");
  });

  bot.command("handback", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot hand back while a prompt is running. Use /abort first."), {
        fallbackText: "Cannot hand back while a prompt is running. Use /abort first.",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("No active thread to hand back."), {
        fallbackText: "No active thread to hand back.",
      });
      return;
    }

    try {
      const info = session.handback();
      updateSessionMetadata(contextKey, session);

      if (!info.threadId) {
        await safeReply(
          ctx,
          escapeHTML(
            "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          ),
          {
            fallbackText:
              "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          },
        );
        return;
      }

      const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
      const resumeCommand = `cd ${shellEscape(info.workspace)} && codex resume ${shellEscape(info.threadId)}`;

      let copiedToClipboard = false;
      if (process.platform === "darwin") {
        try {
          const { spawnSync } = await import("node:child_process");
          const result = spawnSync("pbcopy", [], {
            input: resumeCommand,
            timeout: 2000,
            stdio: ["pipe", "ignore", "ignore"],
          });
          copiedToClipboard = result.status === 0;
        } catch {
          // Ignore clipboard failures.
        }
      }

      const plainText = [
        "🔄 Thread handed back to Codex CLI.",
        "",
        "Run this in your terminal:",
        resumeCommand,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 Command copied to clipboard!" : undefined,
        "",
        "Send any message here to start a new TeleCode thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      const html = [
        "<b>🔄 Thread handed back to Codex CLI.</b>",
        "",
        "Run this in your terminal:",
        `<pre>${escapeHTML(resumeCommand)}</pre>`,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 <i>Command copied to clipboard!</i>" : undefined,
        "",
        "Send any message here to start a new TeleCode thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("attach", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/attach(?:@\w+)?\s*/, "").trim();

    if (!threadId) {
      await safeReply(ctx, escapeHTML("Usage: /attach <thread-id>"), {
        fallbackText: "Usage: /attach <thread-id>",
      });
      return;
    }

    if (threadId.toLowerCase() !== "latest" && !getThread(threadId) && !getThreadByPrefix(threadId)) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(`Unknown Codex thread: ${threadId}`)}`, {
        fallbackText: `Failed: Unknown Codex thread: ${threadId}`,
      });
      return;
    }

    if (!(await ensureSessionTakeoverAllowed(ctx, contextKey, session, "Cannot attach while a prompt is running."))) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      inspectedThreads.delete(contextKey);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Attached to thread.</b>\n\n${renderSessionInfoHTML(info)}`;
      const plain = `Attached to thread.\n\n${renderSessionInfoPlain(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command(["sessions", "switch", "use"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }
    const contextKeyForAgent = contextKeyFromCtx(ctx);
    if (!contextKeyForAgent) {
      return;
    }

    const rawTextForAgent = ctx.message?.text ?? "";
    const agentArg = rawTextForAgent.replace(/^\/(?:sessions|switch|use)(?:@\w+)?\s*/, "").trim();
    if (commandNameFromText(rawTextForAgent) === "sessions") {
      const plain = renderUnifiedSessions(contextKeyForAgent, agentArg);
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    await selectUnifiedAgentSession(ctx, contextKeyForAgent, agentArg);
  });

  const buildSearchResultPicks = (
    hits: SessionSearchHit[],
    limit: number,
  ): Array<{ pick: ProviderSessionPick; snippet: string }> => {
    const spawnedThreadIds = new Set(listSpawnedThreadIds());
    const entries: Array<{ pick: ProviderSessionPick; snippet: string }> = [];
    for (const hit of hits) {
      if (entries.length >= limit) {
        break;
      }
      if (hit.provider === "codex") {
        if (spawnedThreadIds.has(hit.sessionId)) {
          continue;
        }
        // Threads older than the current Codex state database no longer have a DB
        // row; a record synthesized from the index still resumes from the rollout.
        const thread = getThread(hit.sessionId) ?? {
          id: hit.sessionId,
          title: hit.title,
          cwd: hit.workspace,
          model: null,
          createdAt: new Date(hit.updatedAt),
          updatedAt: new Date(hit.updatedAt),
          firstUserMessage: "",
        };
        const pick = providerSessionPickFromCodexThread(thread);
        entries.push({
          pick: hit.title ? { ...pick, title: cleanProviderSessionTitle(hit.title) } : pick,
          snippet: hit.snippet,
        });
        continue;
      }

      if (!config.enableClaudeProvider) {
        continue;
      }
      entries.push({
        pick: providerSessionPickFromClaudeTranscript(
          {
            sessionId: hit.sessionId,
            workspace: hit.workspace || config.workspace,
            title: hit.title || `Claude session ${hit.sessionId.slice(0, 8)}`,
            updatedAt: hit.updatedAt,
          },
          {
            model: config.claudeDefaultModel,
            permissionMode: config.claudePermissionMode,
          },
        ),
        snippet: hit.snippet,
      });
    }
    return entries;
  };

  bot.command(["find", "search"], async (ctx) => {
    const chatId = ctx.chat?.id;
    const contextKey = contextKeyFromCtx(ctx);
    if (!chatId || !contextKey) {
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const query = rawText.replace(/^\/(?:find|search)(?:@\w+)?\s*/, "").trim();
    if (!sessionSearch) {
      const message = "Session search is unavailable because the better-sqlite3 module is not installed.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }
    if (!query) {
      const message = "Usage: /find <words>. Searches the full text of every Claude and Codex session, for example /find housing market. All words must appear in the same session.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const status = sessionSearch.status();
    if (!status.ready) {
      void sessionSearch.refresh().catch(() => undefined);
      const progress = status.refreshing && status.pendingFiles > 0
        ? ` ${status.indexedFiles} sessions indexed, ${status.pendingFiles} still to go.`
        : ` ${status.indexedFiles} sessions indexed so far.`;
      const message = `The session search index is still building.${progress} Try /find again in a minute.`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    try {
      await sessionSearch.refresh();
    } catch {
      // Search proceeds on the last good index when a refresh fails.
    }

    const result = sessionSearch.search(query, 30);
    const entries = buildSearchResultPicks(result.hits, 10);
    if (entries.length === 0) {
      const message = `No sessions matched "${query}". Every word must appear in the same session; try fewer or different words.`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    pendingAgentSessionPicks.set(contextKey, entries.map((entry) => entry.pick));
    const selectedSessionId = agentSessions.getLane(contextKey)?.selectedSessionId;
    const shownNote = result.totalMatches > entries.length
      ? `showing ${entries.length} of ${result.totalMatches}, newest first`
      : "newest first";
    const lines = [
      `Sessions matching "${query}" (${shownNote}):`,
      ...entries.flatMap((entry, index) => {
        const line = formatProviderSessionPickLine(index + 1, entry.pick, selectedSessionId);
        const snippet = trimLine(entry.snippet, 170);
        return snippet ? [line, `Match: ${snippet}`] : [line];
      }),
      "",
      "Use /switch 1 to open a result.",
    ];
    const plain = lines.join("\n");
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  bot.command("replay", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    const chatId = ctx.chat?.id;
    if (!contextKey || !chatId) {
      return;
    }

    mirrorCurrentCodexAgentSession(contextKey, isProviderForeground(contextKey, "codex"));
    const selectedSession = agentSessions.getSelectedSession(contextKey);
    if (!selectedSession) {
      const message = "No selected provider session has buffered output.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const rawCount = getCommandArgument(ctx).trim().toLowerCase();
    const requestedCount = rawCount === "all" ? 100 : rawCount ? Number(rawCount) : 20;
    if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 100) {
      const message = "Usage: /replay [1-100|all]";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const replayable = outputBuffer
      .list(selectedSession.id)
      .filter((event) => !event.priority && (event.kind === "assistant" || event.kind === "tool" || event.kind === "status"));
    const events = replayable.slice(-requestedCount);
    if (events.length === 0) {
      const message = `No buffered ${formatProviderDisplayName(selectedSession.provider)} commentary is waiting.`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const plain = [
      `Buffered ${formatProviderDisplayName(selectedSession.provider)} output, ${events.length} block${events.length === 1 ? "" : "s"}:`,
      ...events.map((event) => formatBufferedOutputEvent(event)),
    ].join("\n\n");
    for (const chunk of splitMarkdownForTelegram(plain)) {
      await sendTextMessage(ctx.api, chatId, chunk.text, {
        parseMode: chunk.parseMode,
        fallbackText: chunk.fallbackText,
        messageThreadId: parseContextKey(contextKey).messageThreadId,
      });
    }

    const replayedIds = new Set(events.map((event) => event.id));
    outputBuffer.drainWhere(selectedSession.id, (event) => replayedIds.has(event.id));
  });

  // Plain-text shortcuts ("use 2", "new codetest", "model 5.6") are convenience
  // aliases, but ordinary chat sentences also start with these words. Each shortcut
  // therefore only fires when its argument resolves to something real; otherwise the
  // message falls through to the normal prompt pipeline and reaches the agent.
  bot.hears(/^(?:use|switch)\s+(.+)/i, async (ctx, next) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      await next();
      return;
    }
    const selection = (ctx.match[1] ?? "").trim();
    const picks = pendingAgentSessionPicks.get(contextKey)
      ?? buildRecentProviderSessionPicks(contextKey, DEFAULT_PROVIDER_SESSION_LIST_LIMIT);
    const selectedSessionId = agentSessions.getLane(contextKey)?.selectedSessionId;
    const resolved = resolveProviderSessionPick(selection, picks, selectedSessionId);
    if (!resolved && findProviderSessionPickMatches(selection, picks).length === 0) {
      await next();
      return;
    }
    await selectUnifiedAgentSession(ctx, contextKey, selection);
  });

  const handleWorkspaceShortcut = async (
    ctx: Context,
    rawWorkspace: string,
    next: () => Promise<void>,
  ): Promise<void> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey || isClaudeActive(contextKey)) {
      await next();
      return;
    }
    const session = registry.get(contextKey) ?? (await getContextSession(ctx, { deferThreadStart: true }))?.session;
    if (!session || !resolveKnownWorkspaceShortcut(rawWorkspace, session.listWorkspaces(), config.workspace)) {
      await next();
      return;
    }
    await createNewThreadFromWorkspaceText(ctx, rawWorkspace);
  };

  bot.hears(/^(?:fork|new thread)\s+(.+)/i, async (ctx, next) => {
    await handleWorkspaceShortcut(ctx, ctx.match[1] ?? "", next);
  });

  bot.hears(/^(?:workspace|ws)\s+(.+)/i, async (ctx, next) => {
    await handleWorkspaceShortcut(ctx, ctx.match[1] ?? "", next);
  });

  bot.hears(/^new\s+(?!from summary$)(.+)/i, async (ctx, next) => {
    await handleWorkspaceShortcut(ctx, ctx.match[1] ?? "", next);
  });

  const runClaudeHandoffTurn = async (
    descriptor: AgentSessionDescriptor,
    prompt: string,
  ): Promise<{ descriptor: AgentSessionDescriptor; text: string }> => {
    if (!claudeAdapter) {
      throw new Error("Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.");
    }

    const jobId = `claude-handoff-${randomUUID().slice(0, 12)}`;
    let streamedText = "";
    let completedText = "";
    let sawCompletion = false;
    let providerError: string | undefined;

    for await (const event of claudeAdapter.sendPrompt({
      sessionId: descriptor.id,
      jobId,
      input: { text: prompt },
    })) {
      switch (event.type) {
        case "assistant_text_delta":
          streamedText += event.text;
          break;
        case "assistant_message_complete":
          completedText = event.text;
          sawCompletion = true;
          break;
        case "error":
          providerError ??= event.message;
          break;
        default:
          break;
      }
    }

    if (providerError) {
      throw new Error(providerError);
    }
    if (!sawCompletion) {
      throw new Error("Claude provider ended the handoff turn without a completion event.");
    }

    const text = completedText.trim() || streamedText.trim();
    if (!text) {
      throw new Error("Claude handoff generation returned empty text.");
    }

    const refreshed = await claudeAdapter.getSessionInfo(descriptor.id);
    return {
      descriptor: {
        ...refreshed,
        displayName: descriptor.displayName ?? refreshed.displayName,
      },
      text,
    };
  };

  const syncClaudeAgentSessionRecord = (
    record: AgentSessionRecord,
    descriptor: AgentSessionDescriptor,
  ): AgentSessionRecord => {
    let updated = record;
    if (descriptor.providerSessionId && descriptor.providerSessionId !== updated.providerSessionId) {
      updated = agentSessions.updateProviderSessionId(updated.id, descriptor.providerSessionId);
    }
    if (descriptor.displayName && descriptor.displayName !== updated.displayName) {
      updated = agentSessions.updateDisplayName(updated.id, descriptor.displayName);
    }
    updated = agentSessions.updateMetadata(updated.id, descriptor.metadata);
    persistAgentSessionState();
    return updated;
  };

  const createClaudeNewFromSummary = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    rawWorkspace?: string,
  ): Promise<void> => {
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a summary session while a prompt is running."), {
        fallbackText: "Cannot create a summary session while a prompt is running.",
      });
      return;
    }

    if (!claudeAdapter) {
      const message = "Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const persisted = claudeState?.get(contextKey);
    if (!claudeSessions.get(contextKey) && !persisted) {
      const message = "No Claude session to summarize yet. Send Claude a message first.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    let sourceDescriptor: AgentSessionDescriptor;
    try {
      sourceDescriptor = await ensureClaudeSession(contextKey);
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
      return;
    }

    let targetWorkspace = sourceDescriptor.workspace;
    const workspaceArg = rawWorkspace?.trim();
    if (workspaceArg) {
      const workspaces = [...new Set([sourceDescriptor.workspace, config.claudeWorkspace])];
      const resolvedWorkspace = resolveWorkspaceArgument(workspaceArg, workspaces, config.claudeWorkspace);
      if (!resolvedWorkspace) {
        const message = `Unknown Claude workspace selection: ${workspaceArg}. Use a listed number, default, or a directory path.`;
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        return;
      }
      targetWorkspace = path.isAbsolute(resolvedWorkspace)
        ? path.normalize(resolvedWorkspace)
        : path.resolve(config.claudeWorkspace, resolvedWorkspace);
      let validWorkspace = false;
      try {
        validWorkspace = existsSync(targetWorkspace) && statSync(targetWorkspace).isDirectory();
      } catch {
        validWorkspace = false;
      }
      if (!validWorkspace) {
        const message = `Claude workspace does not exist or is not a directory: ${targetWorkspace}`;
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        return;
      }
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    let sourceRecord: AgentSessionRecord | undefined;
    let createdDescriptor: AgentSessionDescriptor | undefined;
    let committed = false;
    try {
      sourceRecord = ensureAgentSessionRecord(contextKey, "claude", {
        workspace: sourceDescriptor.workspace,
        displayName: sourceDescriptor.displayName ?? "Claude Code",
        providerSessionId: sourceDescriptor.providerSessionId,
        select: true,
        metadata: sourceDescriptor.metadata,
      });
      await safeReply(ctx, escapeHTML("Creating handoff summary..."), {
        fallbackText: "Creating handoff summary...",
      });
      const summaryTurn = await runClaudeHandoffTurn(sourceDescriptor, CLAUDE_NEW_FROM_SUMMARY_PROMPT);
      sourceDescriptor = summaryTurn.descriptor;
      sourceRecord = syncClaudeAgentSessionRecord(sourceRecord, sourceDescriptor);
      claudeSessions.set(contextKey, sourceDescriptor);
      persistClaudeSession(contextKey, sourceDescriptor);
      const summary = summaryTurn.text;

      const startMessage = `Starting new Claude session from summary in ${targetWorkspace}...`;
      await safeReply(ctx, escapeHTML(startMessage), {
        fallbackText: startMessage,
      });

      const model = String(sourceDescriptor.metadata?.model ?? config.claudeDefaultModel);
      const permissionMode = asClaudePermissionMode(sourceDescriptor.metadata?.permissionMode)
        ?? config.claudePermissionMode;
      const backend = claudeAdapter.getBackend(sourceDescriptor.id);
      const sourceName = sourceDescriptor.displayName?.trim() || `TeleCode ${contextKey}`;
      createdDescriptor = await claudeAdapter.createSession({
        workspace: targetWorkspace,
        displayName: `${sourceName} (summary)`,
        metadata: {
          model,
          permissionMode,
          backend,
        },
      });
      // While the seed turn is running, /stop must target the new runtime. The
      // persisted and selected session remain the source until the seed succeeds.
      claudeSessions.set(contextKey, createdDescriptor);
      const seedPrompt = [
        "You are continuing from a previous Claude session.",
        "Treat the following handoff summary as the starting context for this new session.",
        "Do not redo work unless asked. Reply only: Summary loaded.",
        "",
        summary,
      ].join("\n");
      const seedTurn = await runClaudeHandoffTurn(createdDescriptor, seedPrompt);
      createdDescriptor = seedTurn.descriptor;

      const newRecord = ensureAgentSessionRecord(contextKey, "claude", {
        workspace: createdDescriptor.workspace,
        displayName: createdDescriptor.displayName ?? `${sourceName} (summary)`,
        providerSessionId: createdDescriptor.providerSessionId,
        select: true,
        metadata: createdDescriptor.metadata,
      });
      claudeSessions.set(contextKey, createdDescriptor);
      registry.setActiveProvider(contextKey, "claude");
      persistClaudeSession(contextKey, createdDescriptor);
      persistAgentSessionState();
      lastAssistantReplyBySessionId.set(newRecord.id, seedTurn.text);
      committed = true;

      try {
        await disposeClaudeDescriptor(sourceDescriptor);
      } catch (disposeError) {
        console.warn("Failed to dispose the previous Claude runtime after summary handoff", disposeError);
      }

      const plain = [
        "New Claude session created from summary.",
        `Workspace: ${createdDescriptor.workspace}`,
        `Model: ${String(createdDescriptor.metadata?.model ?? model)}`,
        `Backend: ${String(createdDescriptor.metadata?.backend ?? backend)}`,
        "",
        "Summary:",
        summary,
      ].join("\n");
      const html = [
        "<b>New Claude session created from summary.</b>",
        `Workspace: <code>${escapeHTML(createdDescriptor.workspace)}</code>`,
        `Model: <code>${escapeHTML(String(createdDescriptor.metadata?.model ?? model))}</code>`,
        `Backend: <code>${escapeHTML(String(createdDescriptor.metadata?.backend ?? backend))}</code>`,
        "",
        "<b>Summary:</b>",
        escapeHTML(summary),
      ].join("\n");
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      if (!committed && createdDescriptor) {
        try {
          await disposeClaudeDescriptor(createdDescriptor);
        } catch (disposeError) {
          console.warn("Failed to dispose incomplete Claude summary session", disposeError);
        }
      }
      if (!committed) {
        claudeSessions.set(contextKey, sourceDescriptor);
        if (sourceRecord) {
          agentSessions.selectSession(contextKey, sourceRecord.id);
        }
        persistAgentSessionState();
        persistClaudeSession(contextKey, sourceDescriptor);
      }
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  };

  const createNewFromSummary = async (ctx: Context, rawWorkspace?: string): Promise<void> => {
    const rawContextKey = contextKeyFromCtx(ctx);
    if (!rawContextKey) {
      return;
    }
    if (isClaudeActive(rawContextKey)) {
      await createClaudeNewFromSummary(ctx, rawContextKey, rawWorkspace);
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a summary thread while a prompt is running."), {
        fallbackText: "Cannot create a summary thread while a prompt is running.",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("No active thread to summarize yet."), {
        fallbackText: "No active thread to summarize yet.",
      });
      return;
    }

    let targetWorkspace: string | undefined;
    const workspaceArg = rawWorkspace?.trim();
    if (workspaceArg) {
      const workspaces = session.listWorkspaces();
      targetWorkspace = resolveWorkspaceArgument(workspaceArg, workspaces, config.workspace) ?? undefined;
      if (!targetWorkspace) {
        const selectionMessage = renderWorkspaceSelectionMessage(workspaces, session.getCurrentWorkspace(), config.workspace);
        await safeReply(ctx, selectionMessage.html, { fallbackText: selectionMessage.plain });
        return;
      }
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (!authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("Codex is not authenticated. Use /login first."), {
        fallbackText: "Codex is not authenticated. Use /login first.",
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      await safeReply(ctx, escapeHTML("Creating handoff summary..."), {
        fallbackText: "Creating handoff summary...",
      });
      const summary = (await session.runText(NEW_FROM_SUMMARY_PROMPT)).trim();
      if (!summary) {
        throw new Error("Summary generation returned empty text");
      }

      const startMessage = targetWorkspace
        ? `Starting new thread from summary in ${targetWorkspace}...`
        : "Starting new thread from summary...";
      await safeReply(ctx, escapeHTML(startMessage), {
        fallbackText: startMessage,
      });
      await session.newThread(targetWorkspace);
      clearSessionSelectionState(contextKey);
      const seedPrompt = [
        "You are continuing from a previous Codex session.",
        "Treat the following handoff summary as the starting context for this new thread.",
        "Do not redo work unless asked. Reply only: Summary loaded.",
        "",
        summary,
      ].join("\n");
      await session.runText(seedPrompt);
      updateSessionMetadata(contextKey, session);

      const info = session.getInfo();
      const plain = [`New thread created from summary.`, "", renderSessionInfoPlain(info), "", "Summary:", summary].join("\n");
      const html = [
        "<b>New thread created from summary.</b>",
        "",
        renderSessionInfoHTML(info),
        "",
        "<b>Summary:</b>",
        escapeHTML(summary),
      ].join("\n");
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  };

  bot.command("newsummary", async (ctx) => createNewFromSummary(ctx, getCommandArgument(ctx)));
  bot.hears(/^new from summary$/i, async (ctx) => createNewFromSummary(ctx));
  bot.hears(/^new from summary\s+(.+)/i, async (ctx) => createNewFromSummary(ctx, ctx.match[1] ?? ""));

  bot.command("history", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const inspected = inspectedThreads.get(contextKey);
    const threadId = getViewedThreadId(contextKey, session);
    if (!threadId) {
      await safeReply(ctx, escapeHTML("No Codex thread is selected here yet. Use /use latest or send a prompt first."), {
        fallbackText: "No Codex thread is selected here yet. Use /use latest or send a prompt first.",
      });
      return;
    }

    const messages = readThreadHistory(threadId, 8);
    if (messages.length === 0) {
      await safeReply(ctx, escapeHTML("No local history entries found for this thread."), {
        fallbackText: "No local history entries found for this thread.",
      });
      return;
    }

    const prefixPlain = inspected ? `Inspecting thread ${threadId.slice(0, 8)}. Goal remains in the main thread.\n\n` : "";
    const prefixHtml = inspected
      ? `<b>Inspecting thread</b> <code>${escapeHTML(threadId.slice(0, 8))}</code>. Goal remains in the main thread.\n\n`
      : "";
    const plain = prefixPlain + messages
      .map((message) => {
        const role = message.role === "assistant" ? "Assistant" : "User";
        return `${role}: ${truncateForHistory(message.text)}`;
      })
      .join("\n\n");
    const html = prefixHtml + messages
      .map((message) => {
        const role = message.role === "assistant" ? "Assistant" : "User";
        return `<b>${role}:</b> ${escapeHTML(truncateForHistory(message.text))}`;
      })
      .join("\n\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command(["children", "childsessions"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadId = getViewedThreadId(contextKey, session);
    if (!threadId) {
      await safeReply(ctx, escapeHTML("No Codex thread is selected here yet."), {
        fallbackText: "No Codex thread is selected here yet.",
      });
      return;
    }

    const parent = getParentThread(threadId);
    const parentThreadId = parent?.id ?? threadId;
    const children = listChildThreads(parentThreadId);
    if (children.length === 0) {
      clearChildSelectionState(contextKey);
      const message = parent
        ? "No child sessions found for the parent thread."
        : "No child sessions found for the current thread.";
      await safeReply(ctx, escapeHTML(message), {
        fallbackText: message,
      });
      return;
    }

    pendingChildPicks.set(
      contextKey,
      children.map((child) => child.id),
    );

    const plainLines = [
      parent
        ? `Child sessions for parent ${parentThreadId.slice(0, 8)}. Current child: ${threadId.slice(0, 8)}.`
        : `Child sessions for ${parentThreadId.slice(0, 8)}:`,
      ...children.map((child, index) => {
        const title = trimLine(cleanSessionTitle(child.title || child.firstUserMessage) || "(untitled)", 120);
        const active = child.id === threadId ? " active" : "";
        return `${index + 1}. ${child.id.slice(0, 8)}${active} ${child.spawnStatus} ${formatRelativeTime(child.updatedAt)} - ${title} - /follow ${index + 1} or /follow ${child.id.slice(0, 8)}`;
      }),
      parent ? "Use /parent to return to the parent thread." : "Use /follow latest to inspect the newest child.",
    ];
    const htmlLines = [
      parent
        ? `<b>Child sessions for parent</b> <code>${escapeHTML(parentThreadId.slice(0, 8))}</code>. <b>Current child:</b> <code>${escapeHTML(threadId.slice(0, 8))}</code>.`
        : `<b>Child sessions for</b> <code>${escapeHTML(parentThreadId.slice(0, 8))}</code>:`,
      ...children.map((child, index) => {
        const title = trimLine(cleanSessionTitle(child.title || child.firstUserMessage) || "(untitled)", 120);
        const active = child.id === threadId ? " <i>active</i>" : "";
        return `${index + 1}. <code>${escapeHTML(child.id.slice(0, 8))}</code>${active} ${escapeHTML(child.spawnStatus)} ${escapeHTML(formatRelativeTime(child.updatedAt))} - ${escapeHTML(title)} - <code>/follow ${index + 1}</code> or <code>/follow ${escapeHTML(child.id.slice(0, 8))}</code>`;
      }),
      parent ? "Use <code>/parent</code> to return to the parent thread." : "Use <code>/follow latest</code> to inspect the newest child.",
    ];
    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  bot.command("parent", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const inspected = inspectedThreads.get(contextKey);
    if (inspected) {
      const inspectedParent = getParentThread(inspected.threadId);
      const activeThreadId = session.getInfo().threadId;
      const parentThreadId = inspectedParent?.id ?? inspected.parentThreadId ?? activeThreadId;
      if (!parentThreadId) {
        inspectedThreads.delete(contextKey);
        await safeReply(ctx, escapeHTML("Stopped inspecting child session."), {
          fallbackText: "Stopped inspecting child session.",
        });
        return;
      }

      if (parentThreadId === activeThreadId) {
        inspectedThreads.delete(contextKey);
        const info = session.getInfo();
        const label = "Returned to main session view. Goal was not interrupted.";
        await safeReply(ctx, `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`, {
          fallbackText: `${label}\n\n${renderSessionInfoPlain(info)}`,
        });
        return;
      }

      const parentRecord = getThread(parentThreadId);
      if (!parentRecord) {
        inspectedThreads.delete(contextKey);
        await safeReply(ctx, escapeHTML("Parent session is no longer available locally."), {
          fallbackText: "Parent session is no longer available locally.",
        });
        return;
      }

      inspectedThreads.set(contextKey, { threadId: parentRecord.id });
      const rendered = renderThreadInspection("Inspecting parent session.", parentRecord, {
        goalIsActive: await isNativeGoalActive(session),
      });
      await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
      return;
    }

    const threadId = session.getInfo().threadId;
    if (!threadId) {
      await safeReply(ctx, escapeHTML("No Codex thread is selected here yet."), {
        fallbackText: "No Codex thread is selected here yet.",
      });
      return;
    }

    const parent = getParentThread(threadId);
    if (!parent) {
      await safeReply(ctx, escapeHTML("Current thread is not a child session."), {
        fallbackText: "Current thread is not a child session.",
      });
      return;
    }

    if (!(await ensureSessionTakeoverAllowed(ctx, contextKey, session, "Cannot switch sessions while a prompt is running."))) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(parent.id);
      inspectedThreads.delete(contextKey);
      updateSessionMetadata(contextKey, session);
      clearChildSelectionState(contextKey);
      const html = `<b>Switched to parent session.</b>\nChild was <code>${escapeHTML(threadId.slice(0, 8))}</code>.\n\n${renderSessionInfoHTML(info)}`;
      const plain = `Switched to parent session.\nChild was ${threadId.slice(0, 8)}.\n\n${renderSessionInfoPlain(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command("follow", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadId = getViewedThreadId(contextKey, session);
    if (!threadId) {
      await safeReply(ctx, escapeHTML("No Codex thread is selected here yet."), {
        fallbackText: "No Codex thread is selected here yet.",
      });
      return;
    }

    const rawArg = getCommandArgument(ctx);
    const arg = rawArg.trim() || "latest";
    const parent = getParentThread(threadId);
    const parentThreadId = parent?.id ?? threadId;
    const children = listChildThreads(parentThreadId);
    if (children.length === 0) {
      const message = parent
        ? "No child sessions found for the parent thread."
        : "No child sessions found for the current thread.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    let targetThreadId = "";
    if (/^(?:latest|newest|last)$/i.test(arg)) {
      targetThreadId = children[0]?.id ?? "";
    } else {
      const pendingChildThreadIds = pendingChildPicks.get(contextKey);
      if (/^\d+$/.test(arg) && !pendingChildThreadIds) {
        await safeReply(ctx, escapeHTML("Numbered child selection needs a fresh list. Run /children, then use /follow 1."), {
          fallbackText: "Numbered child selection needs a fresh list. Run /children, then use /follow 1.",
        });
        return;
      }

      const resolvedArg = resolveSessionSelectionArgument(arg, pendingChildThreadIds);
      const matches = children.filter((child) => child.id === resolvedArg || child.id.startsWith(resolvedArg));
      if (matches.length > 1) {
        const matchList = matches.map((child) => child.id.slice(0, 8)).join(", ");
        await safeReply(ctx, escapeHTML(`Ambiguous child ID. Use more characters. Matches: ${matchList}`), {
          fallbackText: `Ambiguous child ID. Use more characters. Matches: ${matchList}`,
        });
        return;
      }
      targetThreadId = matches[0]?.id ?? "";
    }

    if (!targetThreadId) {
      await safeReply(ctx, escapeHTML("Unknown child session. Use /children, then /follow 1 or /follow latest."), {
        fallbackText: "Unknown child session. Use /children, then /follow 1 or /follow latest.",
      });
      return;
    }

    const goalIsActive = await isNativeGoalActive(session);
    if (goalIsActive) {
      const targetRecord = getThread(targetThreadId) ?? children.find((child) => child.id === targetThreadId);
      if (!targetRecord) {
        await safeReply(ctx, escapeHTML("Child session is not available locally yet. Try /children again in a moment."), {
          fallbackText: "Child session is not available locally yet. Try /children again in a moment.",
        });
        return;
      }

      inspectedThreads.set(contextKey, { threadId: targetThreadId, parentThreadId });
      const rendered = renderThreadInspection("Inspecting child session.", targetRecord, {
        parentThreadId,
        goalIsActive: true,
      });
      await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
      return;
    }

    if (!(await ensureSessionTakeoverAllowed(ctx, contextKey, session, "Cannot switch sessions while a prompt is running."))) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(targetThreadId);
      inspectedThreads.delete(contextKey);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Following child session.</b>\nParent: <code>${escapeHTML(parentThreadId.slice(0, 8))}</code>. Use <code>/parent</code> to return.\n\n${renderSessionInfoHTML(info)}`;
      const plain = `Following child session.\nParent: ${parentThreadId.slice(0, 8)}. Use /parent to return.\n\n${renderSessionInfoPlain(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }
    const rawContextKey = contextKeyFromCtx(ctx);
    if (rawContextKey && isClaudeActive(rawContextKey)) {
      const rawText = ctx.message?.text ?? "";
      const modelArg = rawText.replace(/^\/model(?:@\w+)?\s*/i, "").trim();
      const requestedModel = parseClaudeModelArgument(modelArg);
      const currentDescriptor = claudeSessions.get(rawContextKey);
      const persisted = claudeState?.get(rawContextKey);
      const currentModel = String(
        currentDescriptor?.metadata?.model ??
          persisted?.model ??
          config.claudeDefaultModel,
      );
      if (!modelArg) {
        const message = [
          `Claude model: ${currentModel}`,
          "Use /model fable, /model sonnet, /model opus, /model haiku, /model best, or /model default to change the active Claude session.",
        ].join("\n");
        await safeReply(ctx, formatTelegramHTML(message), { fallbackText: message });
        return;
      }
      if (!requestedModel) {
        const message = "Usage: /model fable, /model sonnet, /model opus, /model haiku, /model best, or /model default.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        return;
      }
      if (isProviderBusy(rawContextKey, "claude")) {
        const message = "Cannot change Claude model while a Claude prompt is running. Use /stop first.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        return;
      }
      registry.setActiveProvider(rawContextKey, "claude");
      startClaudePrompt(ctx, rawContextKey, chatId, `/model ${requestedModel}`);
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change model while a prompt is running."), {
        fallbackText: "Cannot change model while a prompt is running.",
      });
      return;
    }

    const models = session.listModels();
    if (models.length === 0) {
      await safeReply(ctx, escapeHTML("No models available."), {
        fallbackText: "No models available.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const modelArg = rawText.replace(/^\/model(?:@\w+)?\s*/i, "").trim();
    if (modelArg) {
      const slug = resolveModelSlug(modelArg, models);
      if (!slug) {
        const available = models.map((m) => m.slug).join(", ");
        const text = `Unknown model "${modelArg}". Available: ${available}`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
        return;
      }
      try {
        session.setModel(slug);
        registry.setDefaultModel(slug);
        updateSessionMetadata(contextKey, session);
        const text = `Model set to ${slug}. Future new Codex sessions will use it too.`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    const currentModel = session.getInfo().model ?? "(default)";
    const modelButtons = models.map((model) => ({
      label: `${formatModelButtonLabel(model.displayName)}${model.slug === currentModel ? " ✓" : ""}`,
      callbackData: `model_${model.slug}`,
    }));
    pendingModelButtons.set(contextKey, modelButtons);
    const keyboard = paginateKeyboard(modelButtons, 0, "model");

    // Enumerate models in the message text so the picker works without buttons.
    const plainModelLines = models.map((model, index) => {
      const marker = model.slug === currentModel ? " (selected)" : "";
      return `${index + 1}. ${model.slug}${marker}`;
    });
    const htmlModelLines = models.map((model, index) => {
      const marker = model.slug === currentModel ? " <i>(selected)</i>" : "";
      return `${index + 1}. <code>${escapeHTML(model.slug)}</code>${marker}`;
    });

    await safeReply(
      ctx,
      [
        `<b>Current model:</b> <code>${escapeHTML(currentModel)}</code>`,
        "",
        "Models for new threads. Send /model &lt;name&gt; to select:",
        ...htmlModelLines,
      ].join("\n"),
      {
        fallbackText: [
          `Current model: ${currentModel}`,
          "",
          "Models for new threads. Send /model <name> to select:",
          ...plainModelLines,
        ].join("\n"),
        replyMarkup: keyboard,
      },
    );
  });

  bot.hears(/^model\s+(.+)/i, async (ctx, next) => {
    const rawContextKey = contextKeyFromCtx(ctx);
    if (!rawContextKey || isClaudeActive(rawContextKey)) {
      await next();
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      await next();
      return;
    }

    const { contextKey, session } = contextSession;
    const modelArg = (ctx.match[1] ?? "").trim();
    const models = session.listModels();
    const slug = resolveModelSlug(modelArg, models);
    if (!slug) {
      // Not a known model: treat the message as a normal prompt instead.
      await next();
      return;
    }

    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change model while a prompt is running."), {
        fallbackText: "Cannot change model while a prompt is running.",
      });
      return;
    }
    try {
      session.setModel(slug);
      registry.setDefaultModel(slug);
      updateSessionMetadata(contextKey, session);
      const text = `Model set to ${slug}. Future new Codex sessions will use it too.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  const setEffortFromCommand = async (ctx: Context, effortText: string): Promise<boolean> => {
    const rawContextKey = contextKeyFromCtx(ctx);
    if (rawContextKey && isClaudeActive(rawContextKey)) {
      const message = "Reasoning effort is not exposed for Claude Code sessions. Use /codex to switch back to Codex.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return true;
    }

    const normalized = effortText.trim().toLowerCase();
    if (!isCodexReasoningEffort(normalized)) {
      const usage = `Usage: /effort ${CODEX_REASONING_EFFORTS.join("|")}`;
      await safeReply(ctx, escapeHTML(usage), {
        fallbackText: usage,
      });
      return true;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return true;
    }

    const { contextKey, session } = contextSession;
    const efforts = reasoningEffortsForSession(session);
    if (!efforts.includes(normalized)) {
      const model = session.getInfo().model ?? "the current model";
      const message = `${normalized} is not advertised for ${model}. Supported levels: ${efforts.join(", ")}.`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return true;
    }
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change effort while a prompt is running."), {
        fallbackText: "Cannot change effort while a prompt is running.",
      });
      return true;
    }

    session.setReasoningEffort(normalized);
    updateSessionMetadata(contextKey, session);
    const text = `Reasoning effort set to ${normalized}. It applies from the next turn in this context.`;
    await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    return true;
  };

  bot.command("effort", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }
    const rawContextKey = contextKeyFromCtx(ctx);
    if (rawContextKey && isClaudeActive(rawContextKey)) {
      const message = "Reasoning effort is not exposed for Claude Code sessions. Use /codex to switch back to Codex.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const effortArg = rawText.replace(/^\/effort(?:@\w+)?\s*/i, "").trim();
    if (effortArg) {
      await setEffortFromCommand(ctx, effortArg);
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const efforts = reasoningEffortsForSession(session);
    const current = session.getInfo().reasoningEffort;
    const effortButtons = efforts.map((effort) => ({
      label: effort === current ? `${effort} ✓` : effort,
      callbackData: `effort_${effort}`,
    }));
    pendingEffortButtons.set(contextKey, effortButtons);
    const keyboard = paginateKeyboard(effortButtons, 0, "effort");
    const levelList = efforts
      .map((effort) => (effort === current ? `${effort} (selected)` : effort))
      .join(", ");
    const text = current
      ? `<b>Reasoning effort:</b> <code>${escapeHTML(current)}</code>\n\nLevels: ${escapeHTML(levelList)}\nSend /effort &lt;level&gt; to select for new threads.`
      : `<b>Reasoning effort:</b> not set (model default)\n\nLevels: ${escapeHTML(levelList)}\nSend /effort &lt;level&gt; to select for new threads.`;
    const plain = current
      ? `Reasoning effort: ${current}\n\nLevels: ${levelList}\nSend /effort <level> to select for new threads.`
      : `Reasoning effort: not set (model default)\n\nLevels: ${levelList}\nSend /effort <level> to select for new threads.`;
    await safeReply(ctx, text, {
      fallbackText: plain,
      replyMarkup: keyboard,
    });
  });

  bot.hears(/^effort\s+(\S+)/i, async (ctx, next) => {
    const rawContextKey = contextKeyFromCtx(ctx);
    const level = (ctx.match[1] ?? "").trim().toLowerCase();
    if (!rawContextKey || isClaudeActive(rawContextKey) || !isCodexReasoningEffort(level)) {
      // Not a shortcut: let the message reach the agent as a normal prompt.
      await next();
      return;
    }
    await setEffortFromCommand(ctx, level);
  });

  bot.command([...NATIVE_CODEX_COMMANDS], async (ctx) => {
    const rawContextKey = contextKeyFromCtx(ctx);
    if (rawContextKey && isClaudeActive(rawContextKey)) {
      const command = ctx.message?.text?.trim().split(/\s+/, 1)[0]?.replace(/^\/|@.*$/g, "") ?? "";
      if (command !== "compact") {
        const message = `/${command} is not supported for Claude sessions. Use /codex to switch back to Codex.`;
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        return;
      }
      const compactInstructions = ctx.message?.text
        ?.replace(/^\/compact(?:@\w+)?(?:\s+|$)/iu, "")
        .trim();
      if (!claudeAdapter) {
        const message = "Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        return;
      }
      if (isBusy(rawContextKey)) {
        await safeReply(ctx, escapeHTML("Cannot compact Claude while a prompt is running."), {
          fallbackText: "Cannot compact Claude while a prompt is running.",
        });
        return;
      }
      try {
        const descriptor = await ensureClaudeSession(rawContextKey);
        await safeReply(ctx, escapeHTML("Compacting Claude session..."), {
          fallbackText: "Compacting Claude session...",
        });
        await claudeAdapter.compact?.(descriptor.id, compactInstructions);
        const message = "Claude compaction completed.";
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        persistClaudeSession(rawContextKey, descriptor);
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text?.trim();
    if (!chatId || !text) {
      return;
    }

    if (await rejectPromptWhileInspecting(ctx, contextKey)) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const commandName = text.match(/^\/([a-zA-Z0-9_]+)/)?.[1]?.toLowerCase();
    if (commandName === "compact" && session.compactThread) {
      try {
        await session.compactThread();
        await safeReply(ctx, escapeHTML("App-server compaction started."), {
          fallbackText: "App-server compaction started.",
        });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    startUserPrompt(ctx, contextKey, chatId, session, text, { setSuccessReaction: false });
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
  handlePageCallback(/^sess_page_(\d+)$/, "sess", pendingSessionButtons, "Expired, run /sessions again");
  handlePageCallback(/^ws_page_(\d+)$/, "ws", pendingWorkspaceButtons, "Expired, run /new again");
  handlePageCallback(
    /^launch_page_(\d+)$/,
    "launch",
    pendingLaunchButtons,
    `Expired, run ${LAUNCH_PROFILES_COMMAND} again`,
  );
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "Expired, run /model again");
  handlePageCallback(/^effort_page_(\d+)$/, "effort", pendingEffortButtons, "Expired, run /effort again");

  bot.callbackQuery(CLAUDE_PERMISSION_CALLBACK, async (ctx) => {
    const decision = claudePermissionPrompts.answer(ctx.match?.[2] ?? "", ctx.match?.[1] ?? "");
    if (!decision) {
      // Answered, expired, or lost in a bot restart: drop the stale buttons.
      await ctx.answerCallbackQuery({ text: "This request is no longer pending" });
      await ctx.editMessageReplyMarkup().catch(() => {});
      return;
    }
    const toast = decision === "deny" ? "Denied" : decision === "allow_always" ? "Always allowed" : "Allowed";
    await ctx.answerCallbackQuery({ text: toast });
  });

  bot.callbackQuery(/^codex_abort:(.+)$/, async (ctx) => {
    const contextKey = ctx.match?.[1];
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Nothing to abort" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Aborting..." });
    try {
      await session.abort();
    } catch (error) {
      console.warn("Abort callback failed", error);
    } finally {
      queuedPrompts.delete(contextKey as TelegramContextKey);
      activeProgressRefreshers.delete(contextKey as TelegramContextKey);
      getBusyState(contextKey as TelegramContextKey).processing = false;
    }
  });

  bot.callbackQuery(/^sess_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadIds = pendingSessionPicks.get(contextKey);
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /sessions again" });
      return;
    }

    if (isBusy(contextKey) && !(await pauseActiveGoalForTakeover(contextKey, session))) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching..." });
    clearSessionSelectionState(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      inspectedThreads.delete(contextKey);
      updateSessionMetadata(contextKey, session);
      const record = ensureAgentSessionRecord(contextKey, "codex", {
        workspace: info.workspace,
        displayName: resolveCodexSessionDisplayName(info.threadId, "Codex"),
        providerSessionId: info.threadId ?? undefined,
        select: true,
        metadata: {
          model: info.model,
          reasoningEffort: info.reasoningEffort,
          backend: registry.getBackend(contextKey),
        },
      });
      persistAgentSessionState();
      const plainText = [
        "Selected provider session from legacy button.",
        "",
        formatProviderSessionSelectionMessage(record, index + 1),
      ].join("\n");
      const html = formatTelegramHTML(plainText);

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^ws_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const workspaces = pendingWorkspacePicks.get(contextKey);
    const workspace = workspaces?.[index];
    if (!workspace) {
      await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Creating thread..." });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
      clearSessionSelectionState(contextKey);
      const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^launch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const launchProfileIds = pendingLaunchPicks.get(contextKey);
    const profileId = launchProfileIds?.[index];
    if (!profileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      return;
    }

    if (profile.unsafe) {
      pendingUnsafeLaunchConfirmations.set(contextKey, profile.id);
      pendingLaunchPicks.delete(contextKey);
      pendingLaunchButtons.delete(contextKey);

      await ctx.answerCallbackQuery({ text: "Confirm danger-full-access" });
      const confirmKeyboard = new InlineKeyboard()
        .text("Enable danger-full-access", `launchconfirm_yes:${profile.id}`)
        .row()
        .text("Cancel", `launchconfirm_no:${profile.id}`);
      const html = [
        `<b>Confirm launch profile:</b> <code>${escapeHTML(profile.label)}</code>`,
        `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(profile))}</code>`,
        "",
        "⚠️ <b>This profile uses danger-full-access.</b>",
        "It will apply to new or reattached threads in this Telegram context.",
      ].join("\n");
      const plain = [
        `Confirm launch profile: ${profile.label}`,
        `Behavior: ${formatLaunchProfileBehavior(profile)}`,
        "",
        "WARNING: This profile uses danger-full-access.",
        "It will apply to new or reattached threads in this Telegram context.",
      ].join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      } else {
        await safeReply(ctx, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: `Launch set to ${profile.label}` });
    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");
    const plain = [
      `Launch profile set to ${selectedProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
    } else {
      await safeReply(ctx, html, { fallbackText: plain });
    }
  });

  bot.callbackQuery(/^launchconfirm_(yes|no):([a-z0-9_-]+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const action = ctx.match?.[1];
    const confirmedProfileId = ctx.match?.[2];

    if (!chatId || !messageId || !action || !confirmedProfileId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const profileId = pendingUnsafeLaunchConfirmations.get(contextKey);
    if (!profileId || profileId !== confirmedProfileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (action === "no") {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch change cancelled.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        {
          fallbackText: `Launch change cancelled.\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        },
      );
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch profile expired.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        {
          fallbackText: `Launch profile expired.\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        },
      );
      return;
    }

    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);
    await ctx.answerCallbackQuery({ text: `Launch set to ${selectedProfile.label}` });

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "⚠️ <i>danger-full-access confirmed for new or reattached threads.</i>",
    ].join("\n");
    const plain = [
      `Launch profile set to ${selectedProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "danger-full-access confirmed for new or reattached threads.",
    ].join("\n");

    await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
  });

  bot.callbackQuery(/^model_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const slug = ctx.match?.[1];

    if (!chatId || !slug) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingModelButtons.get(contextKey);
    if (!buttons) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    const modelExists = buttons.some((button) => button.callbackData === `model_${slug}`);
    if (!modelExists) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Setting model..." });
    pendingModelButtons.delete(contextKey);

    try {
      const model = session.setModel(slug);
      registry.setDefaultModel(model);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Model set to</b> <code>${escapeHTML(model)}</code> — applies to new threads.`;
      const plainText = `Model set to ${model} — applies to new threads.`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    }
  });

  bot.callbackQuery(/^effort_(minimal|low|medium|high|xhigh|max|ultra)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const effort = ctx.match?.[1] as CodexReasoningEffort | undefined;

    if (!chatId || !messageId || !effort) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingEffortButtons.get(contextKey);
    if (!buttons || !buttons.some((button) => button.callbackData === `effort_${effort}`)) {
      await ctx.answerCallbackQuery({ text: "Expired, run /effort again" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Effort set to ${effort}` });
    pendingEffortButtons.delete(contextKey);
    session.setReasoningEffort(effort);
    updateSessionMetadata(contextKey, session);
    const html = `⚡ Reasoning effort set to <code>${escapeHTML(effort)}</code> — applies to new threads.`;
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: `⚡ Reasoning effort set to ${effort} — applies to new threads.`,
    });
  });

  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text.trim();
    if (!userText || userText.startsWith("/")) {
      return;
    }

    const rawContextKey = contextKeyFromCtx(ctx);
    if (!rawContextKey) {
      return;
    }
    if (pendingClaudeLogins.has(rawContextKey)) {
      await submitClaudeLoginCode(ctx, rawContextKey, userText);
      return;
    }
    if (isClaudeActive(rawContextKey)) {
      lastPromptInput.set(rawContextKey, userText);
      await setReaction(ctx, "👀");
      startClaudePrompt(ctx, rawContextKey, ctx.chat.id, userText);
      return;
    }

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (/^\d+$/.test(userText) && pendingWorkspacePicks.has(contextKey)) {
      await createNewThreadFromWorkspaceText(ctx, userText);
      return;
    }

    if (await rejectPromptWhileInspecting(ctx, contextKey)) {
      return;
    }

    if (isBusy(contextKey)) {
      lastPromptInput.set(contextKey, userText);
      await queuePromptReply(ctx, contextKey, ctx.chat.id, session, userText);
      return;
    }

    lastPromptInput.set(contextKey, userText);
    await setReaction(ctx, "👀");
    startUserPrompt(ctx, contextKey, ctx.chat.id, session, userText);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const rawContextKey = contextKeyFromCtx(ctx);
    if (!rawContextKey) {
      return;
    }

    const contextSession = isClaudeActive(rawContextKey) ? undefined : await getContextSession(ctx);
    if (!isClaudeActive(rawContextKey) && !contextSession) {
      return;
    }

    const contextKey = rawContextKey;
    const session = contextSession?.session;
    const chatId = ctx.chat.id;
    if (session && await rejectPromptWhileInspecting(ctx, contextKey)) {
      return;
    }
    // Only concurrent transcription/switching blocks a voice note. A busy provider
    // does NOT: the transcript is queued below exactly like a text message would be.
    if (getBusyState(contextKey).transcribing || getBusyState(contextKey).switching) {
      await sendBusyReply(ctx);
      return;
    }

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;
    let transcript: string | undefined;
    let keptAudioPath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);

      const result = await transcribeAudio(tempFilePath);
      transcript = result.text.trim();
      if (!transcript) {
        await safeReply(ctx, escapeHTML("Transcription was empty. Please try again or send text instead."), {
          fallbackText: "Transcription was empty. Please try again or send text instead.",
        });
        return;
      }

      // Keep the audio for a while: a transcript can turn out to be wrong or the
      // audio itself can be the content (sung melodies transcribe as gibberish).
      keptAudioPath = await archiveVoiceAudio(config.workspace, tempFilePath);

      // Forward voice notes as prompts without a separate transcription echo.
    } catch (error) {
      const note = "Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.";
      await safeReply(ctx, `<b>Transcription failed:</b>\n${escapeHTML(friendlyErrorText(error))}\n\n<i>${escapeHTML(note)}</i>`, {
        fallbackText: `Transcription failed:\n${friendlyErrorText(error)}\n\n${note}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (tempFilePath && !keptAudioPath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!transcript) {
      return;
    }

    let promptText = transcript;
    if (keptAudioPath) {
      const hint = degenerateTranscriptHint(transcript);
      promptText += `\n\n[Voice message audio saved at: ${keptAudioPath}${hint ? `. ${hint}` : ""}]`;
    }

    lastPromptInput.set(contextKey, transcript);
    if (isClaudeActive(contextKey)) {
      // handleClaudePrompt queues internally when the Claude lane is busy.
      await setReaction(ctx, "👀");
      startClaudePrompt(ctx, contextKey, chatId, promptText);
    } else if (session) {
      if (isBusy(contextKey)) {
        await queuePromptReply(ctx, contextKey, chatId, session, promptText);
        return;
      }
      await setReaction(ctx, "👀");
      startUserPrompt(ctx, contextKey, chatId, session, promptText);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const rawContextKey = contextKeyFromCtx(ctx);
    if (!rawContextKey) {
      return;
    }
    if (isClaudeActive(rawContextKey)) {
      const message = "Photo input is not supported for Claude sessions yet. Send text, or use /codex for Codex image handling.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (await rejectPromptWhileInspecting(ctx, contextKey)) {
      return;
    }
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "upload_photo");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, photo.file_id, 20 * 1024 * 1024);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download photo:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download photo: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (!tempFilePath) {
        // Download failed — nothing to clean up further
      }
    }

    const caption = ctx.message.caption?.trim();
    const promptInput: { text?: string; imagePaths: string[] } = { imagePaths: [tempFilePath] };
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }
    await setReaction(ctx, "👀");
    startUserPrompt(ctx, contextKey, chatId, session, promptInput, {
      onFinally: async () => {
        await unlink(tempFilePath).catch(() => {});
      },
    });
  });

  bot.on("message:document", async (ctx) => {
    const rawContextKey = contextKeyFromCtx(ctx);
    if (!rawContextKey) {
      return;
    }
    if (isClaudeActive(rawContextKey)) {
      const message = "Document input is not supported for Claude sessions yet. Send text, or use /codex for Codex file handling.";
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (await rejectPromptWhileInspecting(ctx, contextKey)) {
      return;
    }
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const doc = ctx.message.document;
    if (!doc) {
      return;
    }

    if (doc.file_size && doc.file_size > config.maxFileSize) {
      const sizeMB = Math.round(doc.file_size / 1024 / 1024);
      const maxMB = Math.round(config.maxFileSize / 1024 / 1024);
      await safeReply(ctx, `<b>File too large</b> (${sizeMB} MB, max ${maxMB} MB)`, {
        fallbackText: `File too large (${sizeMB} MB, max ${maxMB} MB)`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, doc.file_id, config.maxFileSize);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    const originalName = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "application/octet-stream";

    let stagedFile: StagedFile;
    try {
      const buffer = await readFile(tempFilePath);
      stagedFile = await stageFile(buffer, originalName, mimeType, {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed to stage file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to stage file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    await safeReply(ctx, `📎 <b>Received:</b> <code>${escapeHTML(stagedFile.safeName)}</code>`, {
      fallbackText: `📎 Received: ${stagedFile.safeName}`,
    });

    // Keep typing visible during the gap between staging and prompt execution
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);

    const promptInput: CodexPromptInput = {
      stagedFileInstructions: buildFileInstructions([stagedFile], outDir),
    };
    const caption = ctx.message.caption?.trim();
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }

    await setReaction(ctx, "👀");
    startUserPrompt(ctx, contextKey, chatId, session, promptInput, {
      onFinally: async () => {
        try {
          await deliverArtifacts(ctx, chatId, outDir, parseContextKey(contextKey).messageThreadId);
        } catch (artifactError) {
          console.error("Failed to deliver artifacts:", artifactError);
        } finally {
          await cleanupInbox(workspace, turnId);
        }
      },
    });
  });

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", message);
  });

  queueMicrotask(recoverPersistedClaudeQueue);

  // Old per-turn staging folders otherwise accumulate forever (see outboxPath).
  queueMicrotask(() => {
    void pruneOldTurnDirectories(config.workspace)
      .then((removed) => {
        if (removed > 0) {
          bridgeLog("cleanup", `pruned ${removed} old turn director${removed === 1 ? "y" : "ies"}`);
        }
      })
      .catch((error) => {
        console.warn("Failed to prune old turn directories", error);
      });
  });

  // Warm persisted Claude PTYs in the background so the first message after a
  // bridge restart does not pay claude.exe --resume interactively (a bare
  // /model right after a restart was measured at 30s+ because of this).
  queueMicrotask(() => {
    if (!claudeAdapter || !claudeState) {
      return;
    }
    for (const record of claudeState.list()) {
      const contextKey = record.telegramContextKey;
      if (!isClaudeActive(contextKey)) {
        continue;
      }
      if (getClaudeBackend(contextKey) === "sdk") {
        // The SDK engine spawns per turn; there is no PTY to warm.
        continue;
      }
      void ensureClaudeSession(contextKey)
        .then(() => bridgeLog("warmup", `claude pty warmed lane=${contextKey}`))
        .catch((error) => {
          bridgeLog(
            "warmup",
            `claude pty warm failed lane=${contextKey}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome & status" },
    { command: "help", description: "Command reference" },
    { command: "health", description: "Bot health summary" },
    { command: "claude", description: "Switch this context to Claude Code" },
    { command: "codex", description: "Switch this context to Codex" },
    { command: "provider", description: "Show or set default provider" },
    { command: "jobs", description: "Show provider jobs in this lane" },
    { command: "alljobs", description: "Show provider jobs across lanes" },
    { command: "new", description: "Start in current workspace" },
    { command: "fork", description: "Start in current workspace" },
    { command: "workspaces", description: "Choose workspace for new thread" },
    { command: "newsummary", description: "Start a new thread from summary" },
    { command: "forkthread", description: "Fork active app-server thread" },
    { command: "renamethread", description: "Rename active app-server thread" },
    { command: "rollbackthread", description: "Roll back app-server thread history" },
    { command: "session", description: "Current thread details" },
    { command: "status", description: "Current thread details" },
    { command: "usage", description: "Codex limits & reset times" },
    { command: "mcp", description: "Toggle Codex MCP tools (browser/computer use)" },
    { command: "backend", description: "Show or reset backend" },
    { command: "verbosity", description: "Set progress delivery" },
    { command: "appserver", description: "Probe Codex app-server" },
    { command: "appserverturn", description: "Run isolated app-server turn" },
    { command: "appserversteer", description: "Run isolated app-server steer test" },
    { command: "appbackendtest", description: "Smoke-test app-server backend" },
    { command: "artifacttest", description: "Send a generated test file" },
    { command: "sessions", description: "Browse provider sessions" },
    { command: "find", description: "Search all sessions by content" },
    { command: "replay", description: "Release buffered background commentary" },
    { command: "history", description: "Show recent local thread history" },
    { command: "children", description: "List child sessions" },
    { command: "follow", description: "Switch to a child session" },
    { command: "parent", description: "Return from child session" },
    { command: "use", description: "Switch provider session" },
    { command: "compact", description: "Compact the active Codex or Claude session" },
    { command: "clear", description: "Forget this Telegram context" },
    { command: "copy", description: "Re-send last assistant reply" },
    { command: "retry", description: "Resend the last prompt" },
    { command: "goal", description: "Control native goal mode" },
    { command: "abort", description: "Cancel current operation" },
    { command: "stop", description: "Cancel current operation" },
    { command: "steer", description: "Steer active Codex app-server or Claude turn" },
    { command: "launch_profiles", description: "Select launch profile" },
    { command: "model", description: "View & change model" },
    { command: "effort", description: "Set reasoning effort" },
    { command: "auth", description: "Check auth status" },
    { command: "login", description: "Start authentication" },
    { command: "claude_login", description: "Start Claude Code login" },
    { command: "logout", description: "Sign out" },
    { command: "voice", description: "Voice transcription status" },
    { command: "handback", description: "Hand thread to Codex CLI" },
    { command: "attach", description: "Bind a Codex thread to this topic" },
    { command: "switch", description: "Switch provider session" },
  ]);
}

function renderSessionInfoPlain(info: CodexSessionInfo): string {
  return [
    `Thread ID: ${info.threadId ?? "(not started yet)"}`,
    `Workspace: ${info.workspace}`,
    `Launch profile: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`,
    info.nextLaunchProfileId
      ? `Next launch profile: ${info.nextLaunchProfileLabel} (${info.nextLaunchProfileBehavior})${info.nextUnsafeLaunch ? " [unsafe]" : ""}`
      : undefined,
    info.model ? `Model: ${info.model}` : undefined,
    info.reasoningEffort ? `Reasoning effort: ${info.reasoningEffort}` : undefined,
    info.sessionTokens ? formatSessionTokensPlain(info.sessionTokens) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderSessionInfoHTML(info: CodexSessionInfo): string {
  return [
    `<b>Thread ID:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    `<b>Launch profile:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
    `<b>Launch behavior:</b> <code>${escapeHTML(info.launchProfileBehavior)}</code>${info.unsafeLaunch ? " ⚠️" : ""}`,
    info.nextLaunchProfileId
      ? `<b>Next launch profile:</b> <code>${escapeHTML(info.nextLaunchProfileLabel ?? "")}</code> <i>(${escapeHTML(info.nextLaunchProfileBehavior ?? "")})</i>${info.nextUnsafeLaunch ? " ⚠️" : ""}`
      : undefined,
    info.model ? `<b>Model:</b> <code>${escapeHTML(info.model)}</code>` : undefined,
    info.reasoningEffort ? `<b>Reasoning effort:</b> <code>${escapeHTML(info.reasoningEffort)}</code>` : undefined,
    info.sessionTokens ? `<b>Session tokens:</b> <code>${escapeHTML(formatSessionTokensValue(info.sessionTokens))}</code>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderClaudeSessionPlain(
  descriptor: AgentSessionDescriptor,
  context?: Record<string, unknown>,
): string {
  const used = Number(context?.usedTokens ?? 0);
  const window = Number(context?.contextWindow ?? 0);
  const autoCompactWindow = Number(context?.autoCompactWindow ?? 0);
  return [
    "Claude session:",
    `Session UUID: ${descriptor.providerSessionId ?? "(unknown)"}`,
    `Workspace: ${descriptor.workspace}`,
    `Model: ${String(descriptor.metadata?.model ?? "(default)")}`,
    `Permission mode: ${String(descriptor.metadata?.permissionMode ?? "(default)")}`,
    `Engine: ${String(descriptor.metadata?.backend ?? "pty")}`,
    `Status: ${descriptor.status}`,
    window > 0 ? formatClaudeContextLine(used, window, autoCompactWindow) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

// A configured CLAUDE_CONTEXT_WINDOW is only a default; models like Fable have larger
// windows, and reporting "114%" of the wrong denominator reads as impossible (it was).
export function formatClaudeContextLine(
  used: number,
  window: number,
  autoCompactWindow?: number,
): string {
  const compactSuffix = autoCompactWindow && autoCompactWindow > 0
    ? ` Auto-compaction window: ${autoCompactWindow} tokens.`
    : "";
  if (window > 0 && used > window) {
    return `Context: ${used} tokens used. That exceeds the configured ${window}-token window, so this model's real window is larger and no reliable percentage exists. Set CLAUDE_CONTEXT_WINDOW to this model's window for accurate percentages.${compactSuffix}`;
  }
  const percent = window > 0 ? Math.round((used / window) * 100) : 0;
  return `Context: ${used} of ${window} tokens (${percent}%).${compactSuffix}`;
}

function renderAppServerProbePlain(result: AppServerProbeResult): string {
  const lines = [
    "Codex app-server probe:",
    `Backend setting: ${result.backend}`,
    `Duration: ${result.durationMs} ms`,
  ];

  if (!result.ok) {
    lines.push(`Status: failed`, `Error: ${result.error}`);
  } else {
    lines.push(
      "Status: ok",
      `Server: ${result.userAgent}`,
      `Codex home: ${result.codexHome}`,
      `Platform: ${result.platform}`,
      `Models returned: ${result.modelCount}${result.modelNames.length ? ` (${result.modelNames.join(", ")})` : ""}`,
      `Threads returned: ${result.threadCount}${result.threadIds.length ? ` (${result.threadIds.join(", ")})` : ""}`,
    );
  }

  lines.push(
    `Notifications seen: ${result.notifications.length ? result.notifications.join(", ") : "none"}`,
    `Assistant text delta opt-out: ${result.optOutNotificationMethods.join(", ")}`,
  );

  return lines.join("\n");
}

function renderAppServerTurnPlain(result: AppServerTurnResult): string {
  const lines = [
    "Codex app-server isolated turn:",
    `Backend setting: ${result.backend}`,
    `Duration: ${result.durationMs} ms`,
  ];

  if (!result.ok) {
    lines.push(`Status: failed`, `Error: ${result.error}`);
  } else {
    lines.push(
      "Status: ok",
      `Thread: ${result.threadId}`,
      `Turn: ${result.turnId}`,
      "",
      "Final response:",
      result.finalText || "(empty)",
    );
  }

  lines.push(
    "",
    `Notifications seen: ${result.notifications.length ? result.notifications.join(", ") : "none"}`,
    `Completed item types: ${result.itemTypes.length ? result.itemTypes.join(", ") : "none"}`,
    `Assistant text delta opt-out: ${result.optOutNotificationMethods.join(", ")}`,
  );

  return lines.join("\n");
}

function renderAppServerSteerPlain(result: AppServerSteerResult): string {
  const lines = [
    "Codex app-server isolated steer:",
    `Backend setting: ${result.backend}`,
    `Duration: ${result.durationMs} ms`,
    `Steer delay: ${result.steerDelayMs} ms`,
  ];

  if (!result.ok) {
    lines.push(`Status: failed`, `Error: ${result.error}`);
  } else {
    lines.push(
      "Status: ok",
      `Thread: ${result.threadId}`,
      `Turn: ${result.turnId}`,
      `Steer accepted for turn: ${result.steerTurnId}`,
      "",
      "Final response:",
      result.finalText || "(empty)",
    );
  }

  lines.push(
    "",
    `Notifications seen: ${result.notifications.length ? result.notifications.join(", ") : "none"}`,
    `Completed item types: ${result.itemTypes.length ? result.itemTypes.join(", ") : "none"}`,
    `Assistant text delta opt-out: ${result.optOutNotificationMethods.join(", ")}`,
  );

  return lines.join("\n");
}

function renderLaunchSummaryPlain(info: CodexSessionInfo): string {
  return `Launch: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`;
}

function renderLaunchSummaryHTML(info: CodexSessionInfo): string {
  const suffix = info.unsafeLaunch ? " ⚠️" : "";
  return `<b>Launch:</b> <code>${escapeHTML(info.launchProfileLabel)}</code> <i>(${escapeHTML(info.launchProfileBehavior)})</i>${suffix}`;
}

function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 Running:</b> <code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 Running: ${toolName}`,
    parseMode: "HTML",
  };
}

function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const icon = isError ? "❌" : "✅";
  const htmlLines = [`<b>${icon}</b> <code>${escapeHTML(toolName)}</code>`];
  const plainLines = [`${icon} ${toolName}`];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const summarizedCounts = new Map<string, number>();
  for (const [toolName, count] of toolCounts.entries()) {
    const summaryName = summarizeToolName(toolName);
    summarizedCounts.set(summaryName, (summarizedCounts.get(summaryName) ?? 0) + count);
  }

  const entries = [...summarizedCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const tools = entries
    .map(([name, count]) => formatSummaryEntry(name, count))
    .join(", ");
  return `Tools used: ${tools}`;
}

export function renderSummaryProgressMessage(
  toolName: string,
  toolCounts: Map<string, number>,
  recentProgressLines: string[] = [],
): RenderedText {
  const summaryLine = formatToolSummaryLine(toolCounts);
  const recentLines = recentProgressLines.slice(-SUMMARY_PROGRESS_RECENT_LIMIT);
  const progressToolName = formatProgressToolName(toolName);
  const htmlLines = [`<b>Working:</b> <code>${escapeHTML(progressToolName)}</code>`];
  const plainLines = [`Working: ${progressToolName}`];

  if (recentLines.length > 0) {
    htmlLines.push("<b>Recent:</b>");
    plainLines.push("Recent:");
    for (const line of recentLines) {
      htmlLines.push(`- ${escapeHTML(trimProgressToolName(line))}`);
      plainLines.push(`- ${trimProgressToolName(line)}`);
    }
  }

  if (summaryLine) {
    htmlLines.push(escapeHTML(summaryLine));
    plainLines.push(summaryLine);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

export function renderAssistantProgressMessage(recentProgressLines: string[]): RenderedText {
  const recent = recentProgressLines.slice(-SUMMARY_PROGRESS_RECENT_LIMIT);
  // Fit the most recent complete narration blocks into the edit budget. Blocks are
  // never truncated; oldest blocks roll off first. Blocks larger than the whole
  // budget are routed around this message entirely by the call sites.
  const selected: string[] = [];
  let total = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const block = recent[index];
    const cost = progressBlockCost(block);
    if (selected.length > 0 && total + cost > PROGRESS_EDIT_BUDGET_CHARS) {
      break;
    }
    selected.unshift(block);
    total += cost;
  }

  const htmlLines = ["<b>Progress:</b>"];
  const plainLines = ["Progress:"];

  for (const block of selected) {
    htmlLines.push(`- ${escapeHTML(block)}`);
    plainLines.push(`- ${block}`);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

function remainingCompletionText(completionText: string, streamedText: string): string {
  const completion = completionText.trim();
  const streamed = streamedText.trim();
  if (!completion || !streamed) {
    return completion;
  }
  if (completion === streamed) {
    return "";
  }
  if (completion.startsWith(streamed)) {
    return completion.slice(streamed.length).trim();
  }
  return completion;
}

function isClaudeQuietWarning(text: string): boolean {
  return text.startsWith(CLAUDE_QUIET_WARNING_PREFIX);
}

export function renderProgressCompletedMessage(): RenderedText {
  return {
    text: "<b>Progress complete.</b>\nFinal answer follows below.",
    fallbackText: "Progress complete.\nFinal answer follows below.",
    parseMode: "HTML",
  };
}

// Cost of one narration block inside the rolling progress message, measured on the
// HTML-escaped text because escaping can inflate length past Telegram's edit limit.
function progressBlockCost(block: string): number {
  return escapeHTML(block).length + 3;
}

export function isOversizedProgressBlock(text: string): boolean {
  return progressBlockCost(text) > PROGRESS_EDIT_BUDGET_CHARS;
}

function trimProgressToolName(toolName: string): string {
  const singleLine = toolName.replace(/\s+/g, " ").trim();
  return singleLine.length <= 120 ? singleLine : `${singleLine.slice(0, 119)}...`;
}

function formatProgressToolName(toolName: string): string {
  return trimProgressToolName(summarizeToolName(toolName));
}


function renderTodoList(items: Array<{ text: string; completed: boolean }>): string {
  const lines = items.map((item) => {
    const icon = item.completed ? "✅" : "⬜";
    return `${icon} ${escapeHTML(item.text)}`;
  });
  return `📋 <b>Plan</b>\n${lines.join("\n")}`;
}

export function formatTurnUsageLine(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string {
  return `🪙 in: ${usage.inputTokens} · cached: ${usage.cachedInputTokens} · out: ${usage.outputTokens}`;
}

export function summarizeToolName(toolName: string): string {
  if (toolName.startsWith("🔍 ")) {
    return "web_fetch";
  }

  if (toolName.startsWith("search ")) {
    return "web_search";
  }

  if (toolName === "file_change") {
    return "file_change";
  }

  if (toolName === "plan") {
    return "plan";
  }

  if (toolName === "⚠️ error") {
    return "error";
  }

  if (toolName.startsWith("mcp:")) {
    const tool = toolName.split("/").at(-1) ?? toolName;
    if (SUBAGENT_TOOL_NAMES.has(tool)) {
      return "subagent";
    }
    return tool;
  }

  return "bash";
}

function formatSummaryEntry(name: string, count: number): string {
  if (count <= 1) {
    return name;
  }

  const label = name === "subagent" ? "subagents" : name;
  return `${count}x ${label}`;
}

const SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]);

function formatSessionTokensValue(tokens: { input: number; cached: number; output: number }): string {
  return `in: ${tokens.input} · cached: ${tokens.cached} · out: ${tokens.output}`;
}

function formatSessionTokensPlain(tokens: { input: number; cached: number; output: number }): string {
  return `Session tokens: ${formatSessionTokensValue(tokens)}`;
}

async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);
  const messageThreadId =
    options.messageThreadId ?? ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;

  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      messageThreadId,
    });
  }
}

async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    return await api.sendMessage(chatId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      return await api.sendMessage(chatId, options.fallbackText, {
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      });
    }
    throw error;
  }
}

async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await bot.api.editMessageText(chatId, messageId, options.fallbackText, {
        reply_markup: options.replyMarkup,
      });
      return;
    }

    throw error;
  }
}

const VOICE_ARCHIVE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const VOICE_ARCHIVE_MAX_FILES = 50;

/** Move a transcribed voice note into a rolling archive so the audio itself
 * stays reachable after transcription. Returns undefined when archiving fails,
 * in which case the caller falls back to deleting the temp file. */
async function archiveVoiceAudio(workspace: string, tempPath: string): Promise<string | undefined> {
  try {
    const dir = path.join(workspace, ".telecode", "voice");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(dir, `voice-${stamp}${path.extname(tempPath) || ".oga"}`);
    try {
      await rename(tempPath, target);
    } catch {
      await copyFile(tempPath, target);
      await unlink(tempPath).catch(() => {});
    }
    void pruneVoiceArchive(dir).catch(() => {});
    return target;
  } catch {
    return undefined;
  }
}

async function pruneVoiceArchive(dir: string): Promise<void> {
  const entries = await readdir(dir);
  const files: Array<{ p: string; mtime: number }> = [];
  for (const entry of entries) {
    const p = path.join(dir, entry);
    const s = await stat(p).catch(() => null);
    if (s?.isFile()) {
      files.push({ p, mtime: s.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - VOICE_ARCHIVE_MAX_AGE_MS;
  for (const [index, file] of files.entries()) {
    if (index >= VOICE_ARCHIVE_MAX_FILES || file.mtime < cutoff) {
      await unlink(file.p).catch(() => {});
    }
  }
}

/** A transcript made of a handful of words repeated many times is almost always
 * Whisper hallucinating over non-speech audio (singing, humming, music). */
export function degenerateTranscriptHint(transcript: string): string | undefined {
  const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 12) {
    return undefined;
  }
  const unique = new Set(words);
  if (unique.size <= Math.max(2, Math.floor(words.length * 0.15))) {
    return "The transcript is highly repetitive, so the audio is likely singing, humming, or music rather than speech. Analyze the saved audio file instead of trusting the transcript";
  }
  return undefined;
}

async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  maxBytes = MAX_AUDIO_FILE_SIZE,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(
      `Telegram file too large (${Math.round(file.file_size / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`,
    );
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(file.file_path) || ".bin";
  const tempPath = path.join(tmpdir(), `telecode-file-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
  if (!markdown) {
    return [];
  }

  const chunks: RenderedChunk[] = [];
  const blocks = markdown.split(/(\n\s*\n)/);
  let current = "";

  const pushCurrent = (): void => {
    const text = current.trim();
    if (text) {
      chunks.push(renderMarkdownChunkWithinLimit(text));
    }
    current = "";
  };

  for (const block of blocks) {
    if (!block) {
      continue;
    }

    const candidate = current ? `${current}${block}` : block;
    const renderedCandidate = formatMarkdownMessage(candidate.trim());
    if (candidate.length <= TELEGRAM_MESSAGE_LIMIT && renderedCandidate.text.length <= TELEGRAM_MESSAGE_LIMIT) {
      current = candidate;
      continue;
    }

    if (current.trim()) {
      pushCurrent();
    }

    if (block.length > TELEGRAM_MESSAGE_LIMIT || formatMarkdownMessage(block.trim()).text.length > TELEGRAM_MESSAGE_LIMIT) {
      let remaining = block.trim();
      while (remaining) {
        const maxLength = Math.min(remaining.length, FORMATTED_CHUNK_TARGET);
        const initialCut = findPreferredSplitIndex(remaining, maxLength);
        const candidatePart = remaining.slice(0, initialCut) || remaining.slice(0, 1);
        const rendered = renderMarkdownChunkWithinLimit(candidatePart);
        chunks.push(rendered);
        remaining = remaining.slice(rendered.sourceText.length).trimStart();
      }
    } else {
      current = block;
    }
  }

  pushCurrent();
  return chunks;
}

function shouldHoldFinalResponse(input: CodexPromptInput): boolean {
  const text = getPromptText(input).toLowerCase();
  if (!text) {
    return false;
  }

  return (
    /\bhand[-\s]?off\b/.test(text) ||
    /\b(single|one)\s+(telegram\s+)?message\b/.test(text) ||
    /\b(do not|don't|dont)\s+split\b/.test(text) ||
    /\b(no\s+split|one\s+piece)\b/.test(text)
  );
}

function getPromptText(input: CodexPromptInput): string {
  if (typeof input === "string") {
    return input;
  }

  return [input.text, input.stagedFileInstructions].filter((part): part is string => Boolean(part)).join("\n");
}

function userInputHasOutputInstructions(input: CodexPromptInput): boolean {
  return typeof input === "object" && Boolean(input.stagedFileInstructions);
}

function addOutputInstructions(input: CodexPromptInput, outDir: string): CodexPromptInput {
  const stagedFileInstructions = outputFilesInstruction(outDir);
  if (typeof input === "string") {
    return { text: input, stagedFileInstructions };
  }

  return {
    ...input,
    stagedFileInstructions,
  };
}

function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
  if (!markdown) {
    return {
      text: "",
      fallbackText: "",
      parseMode: "HTML",
      sourceText: "",
    };
  }

  let sourceText = markdown;
  let rendered = formatMarkdownMessage(sourceText);

  while (rendered.text.length > TELEGRAM_MESSAGE_LIMIT && sourceText.length > 1) {
    const nextLength = Math.max(1, sourceText.length - Math.max(100, Math.ceil(sourceText.length * 0.1)));
    sourceText = sourceText.slice(0, nextLength).trimEnd() || sourceText.slice(0, nextLength);
    rendered = formatMarkdownMessage(sourceText);
  }

  return {
    ...rendered,
    sourceText,
  };
}

function formatMarkdownMessage(markdown: string): RenderedText {
  try {
    return {
      text: formatTelegramHTML(markdown),
      fallbackText: markdown,
      parseMode: "HTML",
    };
  } catch (error) {
    console.error("Failed to format Telegram HTML, falling back to plain text", error);
    return {
      text: markdown,
      fallbackText: markdown,
      parseMode: undefined,
    };
  }
}

function findPreferredSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return Math.max(1, text.length);
  }

  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= maxLength * 0.5) {
    return Math.max(1, newlineIndex);
  }

  const spaceIndex = text.lastIndexOf(" ", maxLength);
  if (spaceIndex >= maxLength * 0.5) {
    return Math.max(1, spaceIndex);
  }

  return Math.max(1, maxLength);
}

function buildStreamingPreview(text: string): string {
  if (text.length <= STREAMING_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, STREAMING_PREVIEW_LIMIT)}\n\n… streaming (preview truncated)`;
}

function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT ? trimmed : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function truncateForHistory(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 900 ? normalized : `${normalized.slice(0, 899)}â€¦`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

function renderWorkspaceSelectionMessage(
  workspaces: string[],
  currentWorkspace: string,
  defaultWorkspace?: string,
): { html: string; plain: string } {
  const plainList = workspaces
    .map((workspace, index) => {
      const labels = workspaceLabels(workspace, currentWorkspace, defaultWorkspace);
      const suffix = labels.length > 0 ? ` ${labels.join(", ")}` : "";
      return `${index + 1}. ${getWorkspaceShortName(workspace)} - ${workspace}${suffix}`;
    })
    .join("\n");
  const htmlList = workspaces
    .map((workspace, index) => {
      const labels = workspaceLabels(workspace, currentWorkspace, defaultWorkspace)
        .map((label) => `<i>${escapeHTML(label)}</i>`)
        .join(", ");
      const suffix = labels ? ` ${labels}` : "";
      return `${index + 1}. <code>${escapeHTML(getWorkspaceShortName(workspace))}</code> - ${escapeHTML(workspace)}${suffix}`;
    })
    .join("\n");

  return {
    html: `<b>Select workspace for new thread:</b>\nSend <code>/new 1</code>, <code>/new default</code>, or <code>workspace 1</code>.\n\n${htmlList}`,
    plain: `Select workspace for new thread:\nSend /new 1, /new default, or workspace 1.\n\n${plainList}`,
  };
}

function resolveWorkspaceArgument(raw: string, workspaces: string[], defaultWorkspace?: string): string | null {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  if (!value) {
    return null;
  }

  const numeric = Number.parseInt(value, 10);
  if (/^\d+$/.test(value)) {
    return numeric >= 1 && numeric <= workspaces.length ? workspaces[numeric - 1] ?? null : null;
  }

  const lower = value.toLowerCase();
  if (defaultWorkspace && /^(?:default|configured|config|home)$/.test(lower)) {
    return defaultWorkspace;
  }

  return (
    workspaces.find((workspace) => workspace === value) ??
    workspaces.find((workspace) => getWorkspaceShortName(workspace).toLowerCase() === lower) ??
    value
  );
}

// Strict resolver for plain-text workspace shortcuts. Unlike resolveWorkspaceArgument
// it never falls back to treating arbitrary text as a path, so ordinary sentences
// ("new plan, use the other file") are not mistaken for workspace switches.
function resolveKnownWorkspaceShortcut(
  raw: string,
  workspaces: string[],
  defaultWorkspace?: string,
): string | null {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  if (!value) {
    return null;
  }

  if (/^\d+$/.test(value)) {
    const numeric = Number.parseInt(value, 10);
    return numeric >= 1 && numeric <= workspaces.length ? workspaces[numeric - 1] ?? null : null;
  }

  const lower = value.toLowerCase();
  if (defaultWorkspace && /^(?:default|configured|config|home)$/.test(lower)) {
    return defaultWorkspace;
  }

  const known =
    workspaces.find((workspace) => workspace === value) ??
    workspaces.find((workspace) => getWorkspaceShortName(workspace).toLowerCase() === lower);
  if (known) {
    return known;
  }

  if (path.isAbsolute(value) && existsSync(value)) {
    return value;
  }

  return null;
}

function workspaceLabels(workspace: string, currentWorkspace: string, defaultWorkspace?: string): string[] {
  const labels: string[] = [];
  if (sameWorkspace(workspace, currentWorkspace)) {
    labels.push("current");
  }
  if (defaultWorkspace && sameWorkspace(workspace, defaultWorkspace)) {
    labels.push("default");
  }
  return labels;
}

function sameWorkspace(left: string, right: string): boolean {
  const normalizedLeft = left.trim();
  const normalizedRight = right.trim();
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function persistSafe(store: JsonAgentSessionStore, manager: AgentSessionManager): void {
  try {
    store.save(manager.serialize());
  } catch (error) {
    console.warn("Failed to persist agent session state", error);
  }
}

function resolveSessionSelectionArgument(raw: string, pendingThreadIds?: string[]): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }

  const numeric = Number.parseInt(value, 10);
  if (/^\d+$/.test(value) && pendingThreadIds && numeric >= 1 && numeric <= pendingThreadIds.length) {
    return pendingThreadIds[numeric - 1] ?? value;
  }

  return value;
}

function formatModelButtonLabel(displayName: string): string {
  return displayName.replace(/^GPT[- ]?/i, "").replace(/^gpt[- ]?/i, "");
}

function resolveModelSlug(raw: string, models: Array<{ slug: string; displayName: string }>): string | null {
  const value = raw.trim();
  const normalized = normalizeModelName(value);
  const aliases: Record<string, string> = {
    codexterra: "gpt-5.6-terra",
    codextera: "gpt-5.6-terra",
    codex56terra: "gpt-5.6-terra",
    codex56tera: "gpt-5.6-terra",
    terra: "gpt-5.6-terra",
    tera: "gpt-5.6-terra",
    codexluna: "gpt-5.6-luna",
    codex56luna: "gpt-5.6-luna",
    luna: "gpt-5.6-luna",
    codexsol: "gpt-5.6-sol",
    codex56sol: "gpt-5.6-sol",
    sol: "gpt-5.6-sol",
  };
  const aliased = aliases[normalized];
  if (aliased && models.some((model) => model.slug === aliased)) {
    return aliased;
  }

  const direct = models.find(
    (model) =>
      normalizeModelName(model.slug) === normalized ||
      normalizeModelName(model.displayName) === normalized,
  );
  if (direct) {
    return direct.slug;
  }

  const withoutGpt = models.find((model) => normalizeModelName(formatModelButtonLabel(model.displayName)) === normalized);
  if (withoutGpt) {
    return withoutGpt.slug;
  }

  if (normalized === "mini") {
    const mini = models.find((model) => model.slug.toLowerCase().includes("mini"));
    if (mini) {
      return mini.slug;
    }
  }

  const dotted = models.find((model) => normalizeModelName(model.slug).endsWith(normalized));
  return dotted?.slug ?? null;
}

function getCommandArgument(ctx: Context): string {
  const text = ctx.message?.text ?? "";
  return text.replace(/^\/\S+\s*/u, "").trim();
}

function parseSteerCommandText(text: string): string | undefined {
  const match = text.match(/^\/steer(?:@\w+)?(?:\s+([\s\S]*))?$/iu);
  if (!match) {
    return undefined;
  }
  return (match[1] ?? "").trim();
}

function reasoningEffortsForSession(session: CodexSessionRuntime): CodexReasoningEffort[] {
  const currentModel = session.getInfo().model;
  const model = currentModel
    ? session.listModels().find((candidate) => candidate.slug === currentModel)
    : undefined;
  return model?.supportedReasoningEfforts?.length
    ? [...model.supportedReasoningEfforts]
    : [...LEGACY_CODEX_REASONING_EFFORTS];
}

function stripTerminalText(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function extractClaudeLoginUrl(screen: string): string | undefined {
  const marker = "https://claude.com/cai/oauth/authorize?";
  const start = screen.indexOf(marker);
  if (start < 0) {
    return undefined;
  }

  const after = screen.slice(start);
  const pasteIndex = after.search(/Paste code here/i);
  const segment = pasteIndex >= 0 ? after.slice(0, pasteIndex) : after;
  const compact = segment.replace(/\s+/g, "");
  const match = compact.match(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?[^<>"']+/i);
  return match?.[0];
}

function redactClaudeLoginSecrets(text: string, code?: string): string {
  let result = text;
  if (code) {
    result = result.split(code).join("[redacted-code]");
  }
  return result.replace(/[A-Za-z0-9_-]{30,}#[A-Za-z0-9_-]{20,}/g, "[redacted-code]");
}

function resolveBackendArgument(raw: string): CodexBackend | null {
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  switch (normalized) {
    case "sdk":
    case "safe":
      return "sdk";
    case "appserver":
    case "app-server":
      return "app-server";
    default:
      return null;
  }
}

function resolveVerbosityArgument(raw: string): ProgressDelivery | null {
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  switch (normalized) {
    case "none":
    case "off":
    case "quiet":
      return "none";
    case "message":
    case "messages":
    case "chat":
    case "normal":
      return "messages";
    case "edit":
    case "edited":
    case "single":
      return "edit";
    default:
      return null;
  }
}

function renderClaudeArgumentCommandHint(commandName: string): string {
  switch (commandName) {
    case "model":
      return [
        "Claude /model opens a terminal menu when used bare.",
        "Use /model sonnet or /model opus over Telegram.",
      ].join("\n");
    case "effort":
      return [
        "Claude /effort opens a terminal menu when used bare.",
        "Use /effort low, /effort medium, or /effort high over Telegram.",
      ].join("\n");
    case "permissions":
      return [
        "Claude /permissions opens a terminal menu when used bare.",
        "Use an argument form over Telegram, or change CLAUDE_PERMISSION_MODE before starting a fresh session.",
      ].join("\n");
    default:
      return [
        `Claude /${commandName} needs an argument over Telegram.`,
        `Use /${commandName} <value>.`,
      ].join("\n");
  }
}

function findEmbeddedClaudeCommandLine(text: string): string | undefined {
  const lines = text.split(/\r\n|\n|\r/u);
  if (lines.length <= 1) {
    return undefined;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const commandName = commandNameFromSlashLine(trimmed);
    if (!commandName) {
      continue;
    }
    const classified = classifyClaudeSlashCommand(trimmed);
    if (classified?.spec || TELECODE_COMMANDS_WHILE_CLAUDE_ACTIVE.has(commandName)) {
      return trimmed.split(/\s+/u)[0];
    }
  }

  return undefined;
}

function isStandaloneClaudeDispatchPrompt(text: string): boolean {
  if (/\r|\n/u.test(text)) {
    return false;
  }
  const classified = classifyClaudeSlashCommand(text.trim());
  return classified?.spec?.class === "dispatch" || classified?.spec?.class === "dispatch_arg";
}

function commandNameFromSlashLine(text: string): string | undefined {
  const match = text.match(/^\/([a-zA-Z0-9_*.-]+)(?:@\w+)?(?:\s|$)/u);
  return match?.[1]?.trim().toLowerCase().replace(/_/g, "-");
}

function applyAgentSessionRepairs(manager: AgentSessionManager, filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      version?: number;
      sessions?: Array<{
        id?: string;
        providerSessionId?: string;
        metadata?: Record<string, unknown>;
      }>;
    };
    if (parsed.version !== 1) {
      return;
    }
    for (const repair of parsed.sessions ?? []) {
      if (!repair.id || !manager.getSession(repair.id)) {
        continue;
      }
      if (repair.providerSessionId) {
        manager.updateProviderSessionId(repair.id, repair.providerSessionId);
      }
      if (repair.metadata) {
        manager.updateMetadata(repair.id, repair.metadata);
      }
    }
  } catch (error) {
    console.warn("Failed to apply agent session repairs", error);
  }
}

function asClaudePermissionMode(value: unknown): ClaudePermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "plan":
    case "bypassPermissions":
      return value;
    default:
      return undefined;
  }
}

function readClaudeTranscriptLastPermissionMode(filePath: string): ClaudePermissionMode | undefined {
  try {
    const lines = readFileSync(filePath, "utf8").trimEnd().split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      const parsed = JSON.parse(line) as { permissionMode?: unknown };
      const mode = asClaudePermissionMode(parsed.permissionMode);
      if (mode) {
        return mode;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function formatBufferedOutputEvent(event: BufferedOutputEvent): string {
  const label = event.kind === "final"
    ? "Final"
    : event.kind === "error"
      ? "Error"
      : event.kind === "permission"
        ? "Permission"
        : event.kind === "question"
          ? "Question"
          : event.kind === "artifact"
            ? "Artifact"
            : event.kind;
  const value = event.text ?? event.artifactPath ?? "";
  return value ? `${label}: ${value}` : label;
}

function formatAgentJobLine(index: number, job: AgentJobRecord, session?: AgentSessionRecord): string {
  const provider = session?.provider ?? job.provider;
  const label = session?.displayName ?? provider;
  const shortSessionId = session?.providerSessionId?.slice(0, 8) ?? job.sessionId.slice(0, 8);
  const age = formatDuration(Date.now() - job.startedAt);
  const detail = job.error ? ` - ${job.error}` : "";
  return `${index}. ${label} ${job.status} - ${provider} session ${shortSessionId} - ${age}${detail}`;
}

function parseProviderSessionListLimit(rawArg: string): number {
  const normalized = rawArg.trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_PROVIDER_SESSION_LIST_LIMIT;
  }
  if (normalized === "all" || normalized === "more" || normalized === "old") {
    return MAX_PROVIDER_SESSION_LIST_LIMIT;
  }

  const numeric = Number.parseInt(normalized, 10);
  if (/^\d+$/.test(normalized) && Number.isFinite(numeric)) {
    return Math.min(Math.max(1, numeric), MAX_PROVIDER_SESSION_LIST_LIMIT);
  }

  return DEFAULT_PROVIDER_SESSION_LIST_LIMIT;
}

function commandNameFromText(text: string): string {
  return text.match(/^\/([a-z0-9_]+)/i)?.[1]?.toLowerCase() ?? "";
}

function providerSessionPickFromAgentSession(session: AgentSessionRecord): ProviderSessionPick {
  const title = session.provider === "codex"
    ? resolveCodexSessionDisplayName(session.providerSessionId, session.displayName || "Codex")
    : cleanProviderSessionTitle(session.displayName || session.providerSessionId || session.provider);

  return {
    kind: "agent",
    session,
    provider: session.provider,
    title,
    workspace: session.workspace,
    updatedAt: session.updatedAt,
    status: session.status,
    providerSessionId: session.providerSessionId,
  };
}

function providerSessionPickFromCodexThread(thread: CodexThreadRecord): ProviderSessionPick {
  return {
    kind: "codex-thread",
    thread,
    provider: "codex",
    title: resolveCodexThreadTitle(thread),
    workspace: thread.cwd,
    updatedAt: thread.updatedAt.getTime(),
    status: "old",
    providerSessionId: thread.id,
  };
}

function providerSessionPickFromClaudeTranscript(
  transcript: ClaudeTranscriptSessionSummary,
  metadata: Record<string, unknown>,
): ProviderSessionPick {
  return {
    kind: "claude-transcript",
    provider: "claude",
    title: cleanProviderSessionTitle(transcript.title || "Claude Code session"),
    workspace: transcript.workspace,
    updatedAt: transcript.updatedAt,
    status: "old",
    providerSessionId: transcript.sessionId,
    metadata,
  };
}

function providerSessionPickKey(pick: ProviderSessionPick): string {
  return `${pick.provider}:${pick.providerSessionId || providerSessionPickAgentId(pick) || pick.title}`;
}

function providerSessionPickAgentId(pick: ProviderSessionPick): string | undefined {
  return pick.kind === "agent" ? pick.session.id : undefined;
}

function resolveCodexSessionDisplayName(threadId: string | null | undefined, fallback: string): string {
  if (threadId) {
    const thread = getThread(threadId);
    const title = thread ? resolveCodexThreadTitle(thread) : "";
    if (title && title !== "(untitled)") {
      return title;
    }
  }

  const fallbackTitle = cleanProviderSessionTitle(fallback);
  return fallbackTitle === "(untitled)" ? "Codex" : fallbackTitle;
}

function resolveCodexThreadTitle(thread: CodexThreadRecord): string {
  const storedTitle = cleanProviderSessionTitle(thread.title || "");
  const firstMessage = cleanProviderSessionTitle(thread.firstUserMessage || "");
  const storedSeed = storedTitle.replace(/(?:\.{3}|…)$/u, "").trim().toLowerCase();
  const firstMessageLower = firstMessage.toLowerCase();
  // A stored title that begins with TeleCode's per-turn output instruction is the
  // auto-title of an old thread whose prompt led with the instruction. The stored
  // copy is truncated, so cleanSessionTitle's full-pattern strip never matches it
  // and it must be detected on the raw text.
  const storedIsTruncatedBoilerplate = (thread.title ?? "").startsWith(OUTPUT_FILES_INSTRUCTION_PREFIX);
  const storedLooksAutomatic = !storedTitle ||
    storedTitle === "(untitled)" ||
    storedIsTruncatedBoilerplate ||
    storedTitle.toLowerCase() === firstMessageLower ||
    (storedSeed.length >= 12 && firstMessageLower.startsWith(storedSeed));
  if (!storedLooksAutomatic) {
    return storedTitle;
  }
  return deriveSessionTitle(firstMessage || storedTitle) || "Codex thread";
}

function shouldReplaceSessionDisplayName(
  current: string | undefined,
  candidate: string | undefined,
  providerSessionId: string | undefined,
  provider: AgentProviderKind,
): boolean {
  const cleanCandidate = cleanProviderSessionTitle(candidate || "");
  if (!cleanCandidate || cleanCandidate === "(untitled)") {
    return false;
  }

  const cleanCurrent = cleanProviderSessionTitle(current || "");
  if (!cleanCurrent || cleanCurrent === "(untitled)") {
    return true;
  }

  const lower = cleanCurrent.toLowerCase();
  if (providerSessionId && cleanCurrent === providerSessionId) {
    return true;
  }
  if (looksLikeUuid(cleanCurrent)) {
    return true;
  }
  if (lower === provider.toLowerCase()) {
    return true;
  }
  if (provider === "codex" && lower === "codex") {
    return true;
  }
  if (provider === "claude" && (lower === "claude code" || lower.startsWith("telecode "))) {
    return true;
  }

  return false;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function resolveProviderSessionPick(
  rawSelection: string,
  picks: ProviderSessionPick[],
  selectedSessionId?: string,
): ProviderSessionPick | undefined {
  const value = rawSelection.trim();
  if (!value) {
    return undefined;
  }

  if (value.toLowerCase() === "latest") {
    return picks[0];
  }

  if (value.toLowerCase() === "previous") {
    // The most recent session that is not the currently selected one. Picks are
    // sorted selected-first, then by recency.
    if (selectedSessionId) {
      const nonSelected = picks.find((pick) => providerSessionPickAgentId(pick) !== selectedSessionId);
      if (nonSelected) {
        return nonSelected;
      }
    }
    return picks[1] ?? picks[0];
  }

  const numeric = Number.parseInt(value, 10);
  if (/^\d+$/.test(value) && numeric >= 1 && numeric <= picks.length) {
    return picks[numeric - 1];
  }

  const matches = findProviderSessionPickMatches(value, picks);
  return matches.length === 1 ? matches[0] : undefined;
}

function findProviderSessionPickMatches(rawSelection: string, picks: ProviderSessionPick[]): ProviderSessionPick[] {
  const query = rawSelection.trim().toLowerCase();
  if (!query) {
    return [];
  }

  return picks.filter((pick) => {
    const agentId = providerSessionPickAgentId(pick) ?? "";
    return (
      agentId.toLowerCase().startsWith(query) ||
      (pick.providerSessionId ?? "").toLowerCase().startsWith(query) ||
      pick.title.toLowerCase().includes(query) ||
      getWorkspaceShortName(pick.workspace).toLowerCase().includes(query)
    );
  });
}

function formatSelectedProviderSessionLabel(picks: ProviderSessionPick[], selectedSessionId?: string): string {
  if (!selectedSessionId) {
    return "(none)";
  }
  const selected = picks.find((pick) => providerSessionPickAgentId(pick) === selectedSessionId);
  if (!selected) {
    return "current session";
  }
  return `#${picks.indexOf(selected) + 1}, ${formatProviderDisplayName(selected.provider)}`;
}

function formatUnifiedSessionLine(index: number, session: AgentSessionRecord, selectedSessionId?: string): string {
  const selected = session.id === selectedSessionId ? " selected" : "";
  const running = session.currentJobId ? ` job ${session.currentJobId.slice(0, 8)}` : "";
  const providerSession = session.providerSessionId ? ` provider ${session.providerSessionId.slice(0, 8)}` : "";
  const label = session.displayName ?? session.provider;
  return `${index}. ${session.provider} ${session.status}${selected}${running} - ${label}${providerSession} - ${getWorkspaceShortName(session.workspace)}`;
}

function formatProviderSessionPickLine(index: number, pick: ProviderSessionPick, selectedSessionId?: string): string {
  const selected = providerSessionPickAgentId(pick) === selectedSessionId ? ", selected" : "";
  const running = pick.status === "running" ? ", running" : "";
  const old = pick.kind === "agent" ? "" : ", old";
  const title = trimLine(pick.title || "(untitled)", 82);
  const workspace = getWorkspaceShortName(pick.workspace);
  return `${index}. ${formatProviderDisplayName(pick.provider)}${selected}${running}${old}, ${formatRelativeTime(new Date(pick.updatedAt))}, ${workspace}: ${title}`;
}

function formatProviderSessionSelectionMessage(session: AgentSessionRecord, listNumber?: number): string {
  const providerName = formatProviderDisplayName(session.provider);
  const lines = [
    `Selected ${listNumber ? `#${listNumber}: ` : ""}${providerName}.`,
    `Name: ${cleanProviderSessionTitle(session.displayName || providerName)}`,
    `Workspace: ${session.workspace}`,
    `Status: ${session.status}`,
    "Use /session for technical details.",
  ];

  return lines.join("\n");
}

function shortSessionLabel(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function formatProviderDisplayName(provider: AgentProviderKind): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    default:
      return provider;
  }
}

export function provisionalClaudeTitle(promptText: string): string {
  const cleaned = deriveSessionTitle(cleanProviderSessionTitle(promptText));
  return isUsefulClaudeSessionTitle(cleaned) ? trimLine(cleaned, 160) : "";
}

function isGenericClaudeDisplayName(displayName: string | undefined, contextKey: TelegramContextKey): boolean {
  if (!displayName) {
    return true;
  }
  const normalized = displayName.trim().toLowerCase();
  return normalized === "claude code" || normalized === `telecode ${contextKey}`.toLowerCase();
}

type ClaudeTranscriptSessionSummary = {
  sessionId: string;
  workspace: string;
  title: string;
  updatedAt: number;
};

function listClaudeTranscriptSessions(limit: number, projectsDir: string): ClaudeTranscriptSessionSummary[] {
  if (!existsSync(projectsDir)) {
    return [];
  }

  const files: Array<{ path: string; sessionId: string; updatedAt: number }> = [];
  const visit = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() !== "subagents") {
          visit(fullPath);
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      try {
        const stat = statSync(fullPath);
        files.push({
          path: fullPath,
          sessionId: path.basename(entry.name, ".jsonl"),
          updatedAt: stat.mtimeMs,
        });
      } catch {
        // Ignore unreadable transcript candidates.
      }
    }
  };

  visit(projectsDir);
  return files
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
    .map(readClaudeTranscriptSummary)
    .filter((summary): summary is ClaudeTranscriptSessionSummary => Boolean(summary));
}

function readClaudeTranscriptSummary(file: { path: string; sessionId: string; updatedAt: number }): ClaudeTranscriptSessionSummary | undefined {
  let text: string;
  try {
    text = readFileSync(file.path, "utf8");
  } catch {
    return undefined;
  }

  let workspace = "";
  let topicWorkspace = "";
  let explicitTitle = "";
  let fallbackTitle = "";
  let inspectedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    inspectedLines += 1;
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof entry.cwd === "string" && entry.cwd.trim()) {
      workspace ||= entry.cwd;
      topicWorkspace = entry.cwd;
    }

    if (entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim()) {
      explicitTitle = cleanProviderSessionTitle(entry.aiTitle);
    }

    if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
      const candidate = cleanProviderSessionTitle(entry.customTitle);
      if (!isGenericClaudeTranscriptTitle(candidate)) {
        explicitTitle = candidate;
      }
    }

    if (!fallbackTitle && entry.type === "user") {
      const rawCandidate = extractClaudeUserText(entry);
      const candidate = deriveSessionTitle(cleanProviderSessionTitle(rawCandidate));
      if (isUsefulClaudeSessionTitle(candidate, rawCandidate)) {
        fallbackTitle = candidate;
      }
    }

    if (workspace && (explicitTitle || fallbackTitle) && inspectedLines >= 200) {
      break;
    }
  }

  // A Claude turn may cd into a project subfolder. That is useful as a topic
  // hint, but it does not replace the provider session's original workspace.
  const resolvedFallbackTitle = resolveClaudeTranscriptFallbackTitle(
    fallbackTitle,
    topicWorkspace || workspace,
  );

  return {
    sessionId: file.sessionId,
    workspace: workspace || path.dirname(file.path),
    title: explicitTitle || resolvedFallbackTitle || `Claude session ${file.sessionId.slice(0, 8)}`,
    updatedAt: file.updatedAt,
  };
}

function extractClaudeUserText(entry: Record<string, unknown>): string {
  const message = entry.message && typeof entry.message === "object"
    ? entry.message as Record<string, unknown>
    : undefined;
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
        return (block as Record<string, unknown>).text as string;
      }
      return "";
    })
    .join(" ");
}

export function isUsefulClaudeSessionTitle(text: string, rawText = text): boolean {
  const lower = text.toLowerCase();
  const rawLower = rawText.toLowerCase();
  if (!text || text === "(untitled)" || text.startsWith("/")) {
    return false;
  }
  if (
    rawLower.includes("local-command-caveat") ||
    rawLower.includes("do not respond to these messages") ||
    rawLower.includes("command-name") ||
    rawLower.includes("local-command-stdout") ||
    rawLower.includes("task-notification") ||
    lower.startsWith("base directory for this skill:")
  ) {
    return false;
  }
  if (/^\d+$/u.test(text)) {
    return false;
  }
  return !/^(?:hi|hello|hey|yes|no|ok|okay|continue|go ahead)[.!?]*$/iu.test(text);
}

export function resolveClaudeTranscriptFallbackTitle(candidate: string, workspace: string): string {
  const cleanedCandidate = cleanProviderSessionTitle(candidate);
  const folder = path.basename(workspace.trim()).replace(/[-_]+/gu, " ").replace(/\s+/gu, " ").trim();
  const genericFolder = /^(?:codetest|code|project|repo|repository|workspace|src|source|home|temp|tmp)$/iu.test(folder);
  const opaqueFolder = !/[a-z]/iu.test(folder) || looksLikeUuid(folder) || folder.startsWith(".");
  if (!folder || genericFolder || opaqueFolder) {
    return cleanedCandidate === "(untitled)" ? "" : cleanedCandidate;
  }

  const weakCandidate = !cleanedCandidate ||
    cleanedCandidate === "(untitled)" ||
    /^[a-z]/u.test(cleanedCandidate) ||
    /^(?:another|doing|it|looking|something|that|thinking|this|trying|working)\b/iu.test(cleanedCandidate);
  if (!weakCandidate) {
    return cleanedCandidate;
  }

  return `${folder[0]?.toUpperCase() ?? ""}${folder.slice(1)}`;
}

function shouldPreferClaudeTranscriptTitle(current: string | undefined, transcriptTitle: string): boolean {
  if (!isUsefulClaudeSessionTitle(transcriptTitle)) {
    return false;
  }
  const cleanedCurrent = cleanProviderSessionTitle(current || "");
  return !isUsefulClaudeSessionTitle(cleanedCurrent) ||
    cleanedCurrent.toLowerCase() === "claude code" ||
    cleanedCurrent.toLowerCase().startsWith("telecode ") ||
    cleanedCurrent.length > 82 ||
    deriveSessionTitle(cleanedCurrent).toLowerCase() === transcriptTitle.toLowerCase();
}

function isGenericClaudeTranscriptTitle(title: string): boolean {
  return /^(?:telecode|telecodex)(?:\s+\S+)?$/i.test(title) || title.toLowerCase() === "claude code";
}

function cleanProviderSessionTitle(title: string): string {
  const withoutTags = title.replace(/<[^>]+>/g, " ");
  return cleanSessionTitle(withoutTags).replace(/\s+/g, " ").trim() || "(untitled)";
}

function parseProviderPrefix(raw: string): { provider: "codex" | "claude"; rest: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const [first = "", ...restParts] = trimmed.split(/\s+/);
  const provider = parseProviderName(first);
  if (provider !== "codex" && provider !== "claude") {
    return undefined;
  }

  return {
    provider,
    rest: restParts.join(" ").trim(),
  };
}

function parseProviderName(raw: string): "codex" | "claude" | undefined {
  switch (raw.trim().toLowerCase()) {
    case "codex":
    case "code":
    case "openai":
      return "codex";
    case "claude":
    case "claude-code":
    case "claudecode":
      return "claude";
    default:
      return undefined;
  }
}

function parseClaudeModelArgument(raw: string): string | undefined {
  const normalized = raw.trim().replace(/^model\s+/i, "");
  if (!normalized) {
    return undefined;
  }
  if (!/^[a-zA-Z0-9_.:-]+$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function readClaudePidRegistryCount(filePath: string): string {
  if (!existsSync(filePath)) {
    return "0";
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { processes?: unknown[] };
    return String(Array.isArray(parsed.processes) ? parsed.processes.length : 0);
  } catch {
    return "unreadable";
  }
}

function normalizeSmokeReply(reply: string): string {
  return reply.trim().replace(/[.!]+$/g, "").toUpperCase();
}

function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/^gpt[- ]?/, "").replace(/\s+/g, "-");
}

function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays}d ago`;
  }

  const deltaWeeks = Math.floor(deltaDays / 7);
  return `${deltaWeeks}w ago`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0 || parts.length > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = friendlyErrorText(error);
  return accumulatedText.trim() ? `${accumulatedText.trim()}\n\n⚠️ ${message}` : `⚠️ ${message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
