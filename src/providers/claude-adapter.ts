import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

import { bridgeLog } from "../bridge-log.js";
import type { ClaudePermissionMode, TeleCodeConfig } from "../config.js";
import {
  ClaudeSdkInputController,
  runClaudeSdkCompact,
  runClaudeSdkTurn,
} from "./claude-sdk-engine.js";
import type {
  AgentProviderAdapter,
  AgentProviderCapabilities,
  AgentProviderEvent,
  AgentSendPromptOptions,
  AgentSessionDescriptor,
  CreateAgentSessionOptions,
} from "./types.js";
import { ensureClaudeConfigDir } from "./claude-config-dir.js";
import { getClaudeCommandSpec, parseClaudeSlashCommand } from "./claude-commands.js";
import { fetchClaudeUsageReport } from "./claude-usage.js";
import {
  CLAUDE_FULLSCREEN_PROMPT_MARKERS,
  CLAUDE_READY_MARKERS,
  CLAUDE_RESUME_WARNING_MARKERS,
  CLAUDE_TRUST_MARKERS,
  ClaudePty,
  PromptEchoMissingError,
} from "./claude-pty.js";
import {
  ClaudeProcessRegistry,
  claudeProcessRegistryPath,
} from "./claude-process-registry.js";
import {
  findTranscript,
  locateActiveTranscript,
  locateActiveTranscriptTurnByPrompt,
  locateTranscriptTurnByPrompt,
  sessionIdFromTranscriptPath,
  snapshotTranscriptSizes,
  TranscriptTailer,
  type ActiveTranscript,
  type ClaudeUsageSnapshot,
} from "./claude-transcript.js";

const CLAUDE_CAPABILITIES: AgentProviderCapabilities = {
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
  artifacts: true,
};

export type ClaudeBackend = "pty" | "sdk";

interface RuntimeSession {
  descriptor: AgentSessionDescriptor;
  providerSessionId: string;
  workspace: string;
  model: string;
  permissionMode: ClaudePermissionMode;
  backend: ClaudeBackend;
  pty?: ClaudePty;
  busy: boolean;
  /** Set by abort(); the running turn's tailer stops promptly instead of idling out. */
  abortRequested?: boolean;
  lastUsage?: ClaudeUsageSnapshot;
  /** Path to the transcript Claude actually writes; discovered on the first turn. */
  transcriptPath?: string;
  ptyPid?: number;
  /** Aborts the in-flight SDK turn; present only while an SDK turn runs. */
  sdkAbortController?: AbortController;
  /** Pushes user steering messages into an active SDK streaming-input turn. */
  sdkInputController?: ClaudeSdkInputController;
  /**
   * Set on a freshly forked session: the next turn resumes THIS session id with
   * fork semantics (SDK forkSession / PTY --fork-session), then Claude mints a new
   * id and the field is cleared. The descriptor carries a placeholder id until then.
   */
  forkSourceSessionId?: string;
  /**
   * False until Claude has revealed a real session id (fresh sessions start with a
   * random UUID Claude ignores). SDK turns only pass `resume` once this is true.
   */
  hasLiveProviderSession: boolean;
}

type LocatedTurnOutput =
  | { transcriptPath: string; startOffset: number }
  | { fallbackText: string };

type StartupStatusCallback = (text: string) => void | Promise<void>;

export class PromptNotDeliveredError extends Error {
  constructor(
    readonly promptText: string,
    message: string,
  ) {
    super(message);
    this.name = "PromptNotDeliveredError";
  }
}

export class ClaudeProviderAdapter implements AgentProviderAdapter {
  readonly id = "claude";
  readonly displayName = "Claude Code";
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly processRegistry: ClaudeProcessRegistry;

  constructor(private readonly config: TeleCodeConfig) {
    this.processRegistry = new ClaudeProcessRegistry(claudeProcessRegistryPath(config.workspace));
  }

  async createSession(
    options: CreateAgentSessionOptions,
    onStartupStatus?: StartupStatusCallback,
  ): Promise<AgentSessionDescriptor> {
    this.validateEnabled();
    const providerSessionId = randomUUID();
    const descriptor = this.buildDescriptor({
      id: `claude-${providerSessionId.slice(0, 12)}`,
      providerSessionId,
      workspace: options.workspace || this.config.claudeWorkspace,
      displayName: options.displayName,
      model: asString(options.metadata?.model) || this.config.claudeDefaultModel,
      permissionMode: asPermissionMode(options.metadata?.permissionMode) || this.config.claudePermissionMode,
      status: "idle",
      // Without this the caller's engine choice was dropped here and every new session
      // silently fell back to config.claudeBackend, ignoring the saved per-chat preference.
      backend: asClaudeBackend(options.metadata?.backend),
    });
    const runtime = this.runtimeFromDescriptor(descriptor);
    this.sessions.set(descriptor.id, runtime);
    if (runtime.backend === "sdk") {
      // The SDK spawns per turn; nothing to start eagerly. The first turn's init
      // message reveals the real session id.
      return { ...runtime.descriptor };
    }
    try {
      await this.ensurePty(runtime, "new", onStartupStatus);
    } catch (error) {
      this.sessions.delete(descriptor.id);
      await this.stopRuntimePty(runtime, { graceful: false }).catch(() => {});
      throw error;
    }
    return { ...descriptor };
  }

  async resumeSession(
    session: AgentSessionDescriptor,
    onStartupStatus?: StartupStatusCallback,
  ): Promise<AgentSessionDescriptor> {
    this.validateEnabled();
    const runtime = this.runtimeFromDescriptor(session);
    runtime.hasLiveProviderSession = true;
    this.sessions.set(session.id, runtime);
    if (runtime.backend === "sdk") {
      return { ...runtime.descriptor };
    }
    try {
      await this.ensurePty(runtime, "resume", onStartupStatus);
    } catch (error) {
      this.sessions.delete(session.id);
      await this.stopRuntimePty(runtime, { graceful: false }).catch(() => {});
      throw error;
    }
    return { ...runtime.descriptor };
  }

  async getSessionInfo(sessionId: string): Promise<AgentSessionDescriptor> {
    return { ...this.requireRuntime(sessionId).descriptor };
  }

  async *sendPrompt(options: AgentSendPromptOptions): AsyncIterable<AgentProviderEvent> {
    const runtime = this.requireRuntime(options.sessionId);
    if (runtime.busy) {
      throw new Error("Claude session is already running a turn");
    }
    const promptText = promptToText(options.input);
    if (!promptText.trim()) {
      throw new Error("Claude prompt is empty");
    }

    runtime.busy = true;
    runtime.abortRequested = false;
    runtime.descriptor.status = "running";
    runtime.descriptor.updatedAt = Date.now();
    yield { type: "session_status_changed", sessionId: runtime.descriptor.id, status: "running" };

    try {
      if (runtime.backend === "sdk") {
        yield* this.sendPromptViaSdk(runtime, promptText, options.jobId, options.onPermissionRequest);
        return;
      }
      const startupEvents: AgentProviderEvent[] = [];
      let startupError: unknown;
      let startupDone = false;
      const startup = this.ensurePty(runtime, "resume", (text) => {
        startupEvents.push({
          type: "status_message",
          sessionId: runtime.descriptor.id,
          jobId: options.jobId,
          text,
        });
      });
      startup.then(
        () => {
          startupDone = true;
        },
        (error: unknown) => {
          startupError = error;
          startupDone = true;
        },
      );
      while (!startupDone || startupEvents.length > 0) {
        while (startupEvents.length > 0) {
          yield startupEvents.shift()!;
        }
        if (!startupDone) {
          await sleep(250);
        }
      }
      if (startupError) {
        // Compaction/resume can leave the interactive TUI showing its footer without a
        // usable input prompt. The user's text has not been sent at this point, so keep it
        // retryable and let the bot move the retry to the programmatic SDK engine.
        if (isPtyReadinessFailure(startupError)) {
          throw new PromptNotDeliveredError(
            promptText,
            `Claude's terminal did not become ready for the message. ${errorMessage(startupError)}`,
          );
        }
        throw startupError;
      }
      const modelCommand = parseClaudeModelCommand(promptText);
      if (modelCommand) {
        const resultText = await this.applyModelCommand(runtime, promptText, modelCommand);
        const text = resultText || `Claude model command sent: ${modelCommand}. Use /status to confirm the active model.`;
        yield {
          type: "assistant_text_delta",
          sessionId: runtime.descriptor.id,
          jobId: options.jobId,
          text,
        };
        yield {
          type: "assistant_message_complete",
          sessionId: runtime.descriptor.id,
          jobId: options.jobId,
          text,
        };
        return;
      }

      // Real Claude slash commands (DISPATCH / DISPATCH+ARG, e.g. /diff, /memory, /review)
      // are typed into the PTY, but Claude records them as <command-name> entries rather
      // than a plain user prompt, so requiring a prompt echo would time out and then kill
      // the PTY. Detect those and locate the turn by transcript growth instead, and never
      // dispose the session if the command produced no readable turn.
      const isSlashCommand = isDispatchSlashCommand(promptText);
      const output = await this.locateTurnTranscript(
        runtime,
        promptText,
        () => runtime.pty!.sendPrompt(promptText),
        { requirePromptEcho: !isSlashCommand, disposeOnFailure: !isSlashCommand },
      );

      if ("fallbackText" in output) {
        yield {
          type: "assistant_text_delta",
          sessionId: runtime.descriptor.id,
          jobId: options.jobId,
          text: output.fallbackText,
        };
        yield {
          type: "assistant_message_complete",
          sessionId: runtime.descriptor.id,
          jobId: options.jobId,
          text: output.fallbackText,
        };
        return;
      }

      const tailer = new TranscriptTailer(output.transcriptPath, {
        startOffset: output.startOffset,
        // Poll faster than the 750ms default so narration lines reach Telegram promptly.
        pollIntervalMs: 300,
      });
      let partialAssistantText = "";
      for await (const event of tailer.eventsUntilTurnEnd({
        sessionId: runtime.descriptor.id,
        jobId: options.jobId,
        idleTimeoutMs: this.config.claudeTurnIdleTimeoutSeconds * 1000,
        shouldStop: () => runtime.abortRequested === true,
      })) {
        if (event.type === "error") {
          const errorMessage = appendScreenTail(event.message, runtime.pty);
          await this.stopRuntimePty(runtime);
          if (partialAssistantText.trim()) {
            yield {
              type: "assistant_message_complete",
              sessionId: runtime.descriptor.id,
              jobId: options.jobId,
              text: `${partialAssistantText.trim()}\n\nClaude stopped before finishing the turn: ${errorMessage}`,
            };
            return;
          }
          throw new Error(errorMessage);
        }
        if (event.type === "assistant_text_delta") {
          partialAssistantText += event.text;
        }
        if (event.type === "usage_updated") {
          runtime.lastUsage = {
            inputTokens: event.inputTokens ?? 0,
            cachedInputTokens: event.cachedInputTokens ?? 0,
            outputTokens: event.outputTokens ?? 0,
            // Prefer the engine's live prompt size; the input/cached figures
            // are turn totals and overstate context on multi-call turns.
            contextTokens: event.contextTokens
              ?? (event.inputTokens ?? 0) + (event.cachedInputTokens ?? 0),
          };
        } else if (event.type === "model_updated") {
          runtime.model = event.model;
          runtime.descriptor.metadata = {
            ...runtime.descriptor.metadata,
            model: event.model,
          };
          runtime.descriptor.updatedAt = Date.now();
        } else if (event.type === "session_title_changed") {
          runtime.descriptor.displayName = event.title;
          runtime.descriptor.updatedAt = Date.now();
        } else if (event.type === "compact_boundary") {
          // Auto/manual compaction shrinks the live context; without this the stale
          // pre-compact figure is reported until the next turn's usage arrives.
          if (event.postTokens !== undefined && runtime.lastUsage) {
            runtime.lastUsage = { ...runtime.lastUsage, contextTokens: event.postTokens };
          }
        }
        yield event;
      }
    } finally {
      runtime.busy = false;
      runtime.descriptor.status = "idle";
      runtime.descriptor.updatedAt = Date.now();
      yield { type: "session_status_changed", sessionId: runtime.descriptor.id, status: "idle" };
    }
  }

  async abort(sessionId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    runtime.abortRequested = true;
    runtime.sdkAbortController?.abort();
    runtime.pty?.pressEscape();
  }

  async streamInput(sessionId: string, input: AgentSendPromptOptions["input"]): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    const text = promptToText(input).trim();
    if (!text) {
      throw new Error("Claude steer text is empty");
    }
    if (!runtime.busy) {
      throw new Error("No active Claude turn to steer");
    }

    if (runtime.backend === "sdk") {
      if (!runtime.sdkInputController) {
        throw new Error("Claude SDK turn is not accepting live input yet");
      }
      runtime.sdkInputController.push(text, "now");
      bridgeLog("steer", `sdk live steer session=${runtime.providerSessionId} chars=${text.length}`);
      return;
    }

    if (!runtime.pty?.isAlive) {
      throw new Error("Claude PTY is not running");
    }
    await runtime.pty.sendPrompt(text);
    bridgeLog("steer", `pty live steer session=${runtime.providerSessionId} chars=${text.length}`);
  }

  /**
   * Switch the engine under an existing session. Takes effect from the next turn;
   * a leftover PTY is disposed now when idle, otherwise lazily at the next SDK turn.
   */
  async setBackend(sessionId: string, backend: ClaudeBackend): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    runtime.backend = backend;
    runtime.descriptor.metadata = { ...runtime.descriptor.metadata, backend };
    runtime.descriptor.updatedAt = Date.now();
    bridgeLog("backend", `claude engine set to ${backend} session=${runtime.providerSessionId}`);
    if (backend === "sdk" && runtime.pty && !runtime.busy) {
      await this.stopRuntimePty(runtime);
    }
  }

  getBackend(sessionId: string): ClaudeBackend {
    return this.requireRuntime(sessionId).backend;
  }

  /**
   * Create a NEW session that continues from the source session's current state,
   * leaving the source intact. Works on both engines: the SDK turn runs with
   * `resume` + `forkSession`, the PTY spawns with `--resume <src> --fork-session`.
   * The fork's real session id appears on its first turn; until then the returned
   * descriptor carries a fresh placeholder id (so it never collides with the source).
   */
  async forkSession(sourceSessionId: string, displayName?: string): Promise<AgentSessionDescriptor> {
    this.validateEnabled();
    const source = this.requireRuntime(sourceSessionId);
    if (!source.hasLiveProviderSession) {
      throw new Error("Nothing to fork yet. Run at least one turn first.");
    }
    const placeholderId = randomUUID();
    const descriptor = this.buildDescriptor({
      id: `claude-${placeholderId.slice(0, 12)}`,
      providerSessionId: placeholderId,
      workspace: source.workspace,
      displayName: displayName || `${source.descriptor.displayName ?? "Claude"} (fork)`,
      model: source.model,
      permissionMode: source.permissionMode,
      status: "idle",
    });
    // forkSourceSessionId is persisted so the fork survives a bridge restart before
    // its first turn: the placeholder id cannot be resumed, the source id can.
    descriptor.metadata = {
      ...descriptor.metadata,
      backend: source.backend,
      forkSourceSessionId: source.providerSessionId,
    };
    const runtime = this.runtimeFromDescriptor(descriptor);
    runtime.forkSourceSessionId = source.providerSessionId;
    this.sessions.set(descriptor.id, runtime);
    bridgeLog("fork", `forked from session=${source.providerSessionId} backend=${runtime.backend}`);
    return { ...runtime.descriptor };
  }

  private async *sendPromptViaSdk(
    runtime: RuntimeSession,
    promptText: string,
    jobId: string,
    onPermissionRequest?: AgentSendPromptOptions["onPermissionRequest"],
  ): AsyncIterable<AgentProviderEvent> {
    // A PTY left over from a backend switch is disposed lazily here, never mid-turn.
    if (runtime.pty) {
      await this.stopRuntimePty(runtime);
    }

    const modelCommand = parseClaudeModelCommand(promptText);
    if (modelCommand) {
      runtime.model = modelCommand;
      runtime.descriptor.metadata = { ...runtime.descriptor.metadata, model: modelCommand };
      runtime.descriptor.updatedAt = Date.now();
      const text = `Claude model set to ${modelCommand} for the next turn (sdk backend).`;
      yield { type: "assistant_text_delta", sessionId: runtime.descriptor.id, jobId, text };
      yield { type: "assistant_message_complete", sessionId: runtime.descriptor.id, jobId, text };
      return;
    }

    const abortController = new AbortController();
    const inputController = new ClaudeSdkInputController();
    runtime.sdkAbortController = abortController;
    runtime.sdkInputController = inputController;
    let partialText = "";
    try {
      for await (const event of runClaudeSdkTurn({
        sessionId: runtime.descriptor.id,
        jobId,
        promptText,
        cwd: runtime.workspace,
        claudeBin: this.config.claudeBin,
        model: runtime.model,
        permissionMode: runtime.permissionMode,
        resume: runtime.forkSourceSessionId ?? (runtime.hasLiveProviderSession ? runtime.providerSessionId : undefined),
        forkSession: Boolean(runtime.forkSourceSessionId),
        abortController,
        inputController,
        quietStatusIntervalMs: this.config.claudeTurnIdleTimeoutSeconds * 1000,
        autoCompactWindow: this.config.claudeAutoCompactWindow,
        onPermissionRequest,
        onProviderSessionId: (providerSessionId) => {
          runtime.forkSourceSessionId = undefined;
          if (runtime.descriptor.metadata?.forkSourceSessionId) {
            delete runtime.descriptor.metadata.forkSourceSessionId;
          }
          runtime.hasLiveProviderSession = true;
          if (providerSessionId !== runtime.providerSessionId) {
            runtime.providerSessionId = providerSessionId;
            runtime.descriptor.providerSessionId = providerSessionId;
            runtime.descriptor.updatedAt = Date.now();
          }
        },
      })) {
        if (event.type === "assistant_text_delta") {
          partialText += `${event.text}\n\n`;
        } else if (event.type === "usage_updated") {
          runtime.lastUsage = {
            inputTokens: event.inputTokens ?? 0,
            cachedInputTokens: event.cachedInputTokens ?? 0,
            outputTokens: event.outputTokens ?? 0,
            // Prefer the engine's live prompt size; the input/cached figures
            // are turn totals and overstate context on multi-call turns.
            contextTokens: event.contextTokens
              ?? (event.inputTokens ?? 0) + (event.cachedInputTokens ?? 0),
          };
        } else if (event.type === "model_updated") {
          runtime.model = event.model;
          runtime.descriptor.metadata = { ...runtime.descriptor.metadata, model: event.model };
          runtime.descriptor.updatedAt = Date.now();
        } else if (event.type === "compact_boundary") {
          if (event.postTokens !== undefined) {
            runtime.lastUsage = {
              inputTokens: runtime.lastUsage?.inputTokens ?? 0,
              cachedInputTokens: runtime.lastUsage?.cachedInputTokens ?? 0,
              outputTokens: runtime.lastUsage?.outputTokens ?? 0,
              contextTokens: event.postTokens,
            };
          }
        } else if (event.type === "error") {
          // Mirror the PTY path: salvage streamed partial text into a completion,
          // otherwise fail the turn.
          if (partialText.trim()) {
            yield {
              type: "assistant_message_complete",
              sessionId: runtime.descriptor.id,
              jobId,
              text: `${partialText.trim()}\n\nClaude stopped before finishing the turn: ${event.message}`,
            };
            return;
          }
          throw new Error(event.message);
        }
        yield event;
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        const text = partialText.trim()
          ? `${partialText.trim()}\n\nTurn aborted.`
          : "Turn aborted.";
        yield { type: "assistant_message_complete", sessionId: runtime.descriptor.id, jobId, text };
        return;
      }
      throw error;
    } finally {
      runtime.sdkAbortController = undefined;
      runtime.sdkInputController = undefined;
      inputController.close();
    }
  }

  async compact(sessionId: string, instructions?: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.busy) {
      throw new Error("Cannot compact while Claude is running");
    }
    runtime.busy = true;
    try {
      if (runtime.backend === "sdk") {
        if (!runtime.hasLiveProviderSession) {
          throw new Error("Nothing to compact yet. Send at least one message to Claude first.");
        }
        if (runtime.pty) {
          await this.stopRuntimePty(runtime);
        }
        const abortController = new AbortController();
        runtime.sdkAbortController = abortController;
        try {
          const result = await runClaudeSdkCompact({
            cwd: runtime.workspace,
            claudeBin: this.config.claudeBin,
            model: runtime.model,
            permissionMode: runtime.permissionMode,
            resume: runtime.providerSessionId,
            instructions,
            abortController,
            timeoutMs: 180_000,
            autoCompactWindow: this.config.claudeAutoCompactWindow,
            onProviderSessionId: (providerSessionId) => {
              runtime.hasLiveProviderSession = true;
              if (providerSessionId !== runtime.providerSessionId) {
                runtime.providerSessionId = providerSessionId;
                runtime.descriptor.providerSessionId = providerSessionId;
                runtime.descriptor.updatedAt = Date.now();
              }
            },
          });
          if (result.postTokens !== undefined) {
            runtime.lastUsage = {
              inputTokens: runtime.lastUsage?.inputTokens ?? 0,
              cachedInputTokens: runtime.lastUsage?.cachedInputTokens ?? 0,
              outputTokens: runtime.lastUsage?.outputTokens ?? 0,
              contextTokens: result.postTokens,
            };
          }
        } finally {
          runtime.sdkAbortController = undefined;
        }
        return;
      }

      const compactCommand = instructions?.trim()
        ? `/compact ${instructions.trim()}`
        : "/compact";
      await this.ensurePty(runtime, "resume");
      const output = await this.locateTurnTranscript(
        runtime,
        compactCommand,
        () => runtime.pty!.sendCommand(compactCommand),
        { requirePromptEcho: false },
      );
      if ("fallbackText" in output) {
        throw new Error("Claude compaction completed on screen, but no compact transcript boundary was written");
      }
      const tailer = new TranscriptTailer(output.transcriptPath, { startOffset: output.startOffset });
      const summary = await tailer.waitForCompact({
        sessionId,
        jobId: `compact-${Date.now()}`,
        timeoutMs: 120000,
      });
      if (!summary) {
        throw new Error("Claude compaction did not finish before timeout");
      }
    } finally {
      runtime.busy = false;
    }
  }

  async getUsage(sessionId: string): Promise<Record<string, unknown>> {
    const runtime = this.requireRuntime(sessionId);
    return runtime.lastUsage ? { ...runtime.lastUsage } : {};
  }

  async getContext(sessionId: string): Promise<Record<string, unknown>> {
    const runtime = this.requireRuntime(sessionId);
    const used = runtime.lastUsage?.contextTokens ?? 0;
    const window = contextWindowForModel(runtime.model) ?? this.config.claudeContextWindow;
    return {
      usedTokens: used,
      contextWindow: window,
      percent: window > 0 ? used / window : 0,
      autoCompactWindow: this.config.claudeAutoCompactWindow,
    };
  }

  /** Read the same OAuth usage endpoint as Claude Code without spawning or touching a PTY. */
  async getUsageReport(sessionId: string): Promise<string | null> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.busy) {
      throw new Error("Cannot read Claude usage while a turn is running");
    }
    const configDir = this.config.claudeStrictMcpConfig
      ? join(homedir(), ".claude")
      : this.config.claudeConfigDir;
    if (!this.config.claudeStrictMcpConfig) {
      ensureClaudeConfigDir(configDir);
    }
    return await fetchClaudeUsageReport({ configDir });
  }

  async dispose(sessionId?: string): Promise<void> {
    if (sessionId) {
      const runtime = this.sessions.get(sessionId);
      runtime?.sdkAbortController?.abort();
      if (runtime?.pty) {
        await runtime.pty.dispose(true);
      }
      this.removeRegisteredProcessSession(sessionId);
      this.sessions.delete(sessionId);
      return;
    }

    for (const runtime of this.sessions.values()) {
      runtime.sdkAbortController?.abort();
      await runtime.pty?.dispose(true);
      this.removeRegisteredProcessSession(runtime.descriptor.id);
    }
    this.sessions.clear();
  }

  private async ensurePty(
    runtime: RuntimeSession,
    mode: "new" | "resume",
    onStartupStatus?: StartupStatusCallback,
  ): Promise<void> {
    if (runtime.pty?.isAlive) {
      return;
    }
    // A bare command name resolves via PATH at spawn time; only reject configured
    // absolute paths that are verifiably missing.
    if (isAbsolute(this.config.claudeBin) && !existsSync(this.config.claudeBin)) {
      throw new Error(`Claude binary not found: ${this.config.claudeBin}`);
    }

    const ptySession = new ClaudePty();
    const args = mode === "new" && !runtime.forkSourceSessionId
      ? [
          "--session-id",
          runtime.providerSessionId,
          "-n",
          runtime.descriptor.displayName || "TeleCode Claude",
          "--permission-mode",
          runtime.permissionMode,
        ]
      : runtime.forkSourceSessionId
        ? [
            "--resume",
            runtime.forkSourceSessionId,
            "--fork-session",
            "--permission-mode",
            runtime.permissionMode,
          ]
        : [
            "--resume",
            runtime.providerSessionId,
            "--permission-mode",
            runtime.permissionMode,
          ];

    if (shouldPassClaudeModel(runtime.model)) {
      args.push("--model", runtime.model);
    }

    if (runtime.permissionMode === "bypassPermissions") {
      args.unshift("--dangerously-skip-permissions");
    }

    args.push("--settings", JSON.stringify(TELECODE_CLAUDE_SETTINGS));
    args.push("--append-system-prompt", TELECODE_CLAUDE_SYSTEM_PROMPT);

    const strictMcp = this.config.claudeStrictMcpConfig;
    if (strictMcp) {
      // Launch against the real ~/.claude but ignore config-file mcp servers, so the
      // user-scoped telegram plugin never starts a second getUpdates poller (which 409s
      // the live bridge). Interactive turns do not execute under an isolated config dir,
      // so this is the path that actually works end to end.
      args.push("--strict-mcp-config");
    } else {
      ensureClaudeConfigDir(this.config.claudeConfigDir);
    }
    ptySession.spawn({
      bin: this.config.claudeBin,
      args,
      cwd: runtime.workspace,
      configDir: strictMcp ? undefined : this.config.claudeConfigDir,
      autoCompactWindow: this.config.claudeAutoCompactWindow,
    });
    runtime.ptyPid = ptySession.pid;
    if (runtime.forkSourceSessionId) {
      // The spawn itself performed the fork; the new session id is discovered when
      // the first turn's transcript is located.
      runtime.forkSourceSessionId = undefined;
      runtime.hasLiveProviderSession = false;
    }
    bridgeLog("pty", `spawn pid=${runtime.ptyPid ?? "?"} mode=${mode} session=${runtime.providerSessionId}`);
    if (runtime.ptyPid) {
      this.registerProcess({
        pid: runtime.ptyPid,
        sessionId: runtime.descriptor.id,
        providerSessionId: runtime.providerSessionId,
        startedAt: Date.now(),
      });
    }

    // Startup dialogs can CHAIN (e.g. trust prompt, then the large-session resume
    // picker). Handle whatever appears, in any order, until the prompt is ready.
    const readyTimeoutMs = mode === "resume" ? 90000 : 30000;
    const disposeWith = async (message: string): Promise<never> => {
      const tail = screenTail(ptySession);
      await ptySession.dispose(false);
      this.removeRegisteredProcessSession(runtime.descriptor.id);
      throw new Error(`${message} Screen tail: ${tail}`);
    };
    let marker = await ptySession.waitForMarker([
      ...CLAUDE_TRUST_MARKERS,
      ...CLAUDE_FULLSCREEN_PROMPT_MARKERS,
      ...CLAUDE_RESUME_WARNING_MARKERS,
      ...CLAUDE_READY_MARKERS,
    ], readyTimeoutMs);
    if (!marker) {
      await disposeWith("Claude did not reach a ready prompt.");
    }
    let dialogsHandled = 0;
    while (marker && !CLAUDE_READY_MARKERS.some((ready) => ready.source === marker)) {
      if (dialogsHandled >= 4) {
        await disposeWith("Claude kept showing startup dialogs and never became ready.");
      }
      dialogsHandled += 1;
      let nextWaitMs = 30000;

      if (marker === CLAUDE_TRUST_MARKERS[0]!.source) {
        ptySession.pressEnter();
        ptySession.clearBuffer();
      } else if (marker === CLAUDE_FULLSCREEN_PROMPT_MARKERS[0]!.source) {
        ptySession.typeText("2");
        ptySession.pressEnter();
        ptySession.clearBuffer();
      } else {
        // Large-session resume picker.
        if (this.config.claudeLargeSessionResume === "manual") {
          await disposeWith(
            "Claude is asking how to resume a very large session. Set CLAUDE_LARGE_SESSION_RESUME=summary or full, then restart TeleCode.",
          );
        }
        const resumeStartedAt = Date.now();
        const resumeStrategy = this.config.claudeLargeSessionResume;
        runtime.descriptor.metadata = {
          ...runtime.descriptor.metadata,
          startupResumeStrategy: resumeStrategy,
          startupResumeStartedAt: resumeStartedAt,
          startupResumeFinishedAt: undefined,
        };
        runtime.descriptor.updatedAt = resumeStartedAt;
        await onStartupStatus?.(
          resumeStrategy === "full"
            ? "Claude is resuming a very large session in full. This can take a while; I will wait before sending your prompt."
            : "Claude is compacting a very large session into a summary. I will wait before sending your prompt.",
        );
        if (resumeStrategy === "full") {
          ptySession.typeText("2");
        }
        ptySession.pressEnter();
        ptySession.clearBuffer();
        nextWaitMs = 600000;
        const ready = await ptySession.waitForReadyPrompt(nextWaitMs);
        if (!ready) {
          await disposeWith("Claude resume warning was accepted, but the prompt did not become ready.");
        }
        const resumeFinishedAt = Date.now();
        runtime.descriptor.metadata = {
          ...runtime.descriptor.metadata,
          startupResumeStrategy: resumeStrategy,
          startupResumeStartedAt: resumeStartedAt,
          startupResumeFinishedAt: resumeFinishedAt,
        };
        runtime.descriptor.updatedAt = resumeFinishedAt;
        await onStartupStatus?.(
          resumeStrategy === "full"
            ? "Claude full-session resume finished. Sending your prompt now."
            : "Claude summary compaction finished. Sending your prompt now.",
        );
        bridgeLog("pty", `large-session resume (${resumeStrategy}) took ${resumeFinishedAt - resumeStartedAt}ms`);
        break;
      }

      marker = await ptySession.waitForMarker([
        ...CLAUDE_TRUST_MARKERS,
        ...CLAUDE_FULLSCREEN_PROMPT_MARKERS,
        ...CLAUDE_RESUME_WARNING_MARKERS,
        ...CLAUDE_READY_MARKERS,
      ], nextWaitMs);
      if (!marker) {
        await disposeWith("Claude startup dialog was dismissed, but the prompt did not become ready.");
      }
    }

    // Busy-aware settle check: the footer alone must not count as ready while
    // startup output (e.g. auto-compaction) is still flowing. Instant when quiet.
    const settledReady = await ptySession.waitForReadyPrompt(30000);
    if (!settledReady) {
      await disposeWith("Claude looked ready but the prompt did not settle.");
    }

    ptySession.on("exit", () => {
      if (runtime.ptyPid) {
        this.removeRegisteredProcessPid(runtime.ptyPid);
      }
      runtime.ptyPid = undefined;
      runtime.pty = undefined;
      runtime.descriptor.status = runtime.busy ? "failed" : "idle";
      runtime.descriptor.updatedAt = Date.now();
    });
    runtime.pty = ptySession;
  }

  private async applyModelCommand(runtime: RuntimeSession, commandText: string, model: string): Promise<string | undefined> {
    const ptySession = runtime.pty;
    if (!ptySession) {
      throw new Error("Claude PTY is not running");
    }

    ptySession.clearBuffer();
    await ptySession.sendCommand(commandText);
    let confirmation = await ptySession.waitForMarker(
      [...CLAUDE_MODEL_CONFIRMATION_MARKERS, ...CLAUDE_MODEL_FAILURE_MARKERS],
      5000,
    );
    let failure = extractModelCommandFailure(ptySession.strippedText());
    if (failure) {
      throw new Error(`Claude model switch failed: ${failure}`);
    }
    if (confirmation) {
      ptySession.typeText("1");
      ptySession.pressEnter();
      ptySession.clearBuffer();
    }

    await sleep(1500);
    await ptySession.waitForReadyPrompt(10000);
    failure = extractModelCommandFailure(ptySession.strippedText());
    if (failure) {
      throw new Error(`Claude model switch failed: ${failure}`);
    }

    runtime.model = model;
    runtime.descriptor.metadata = {
      ...runtime.descriptor.metadata,
      model,
    };
    runtime.descriptor.updatedAt = Date.now();
    return `Claude model command accepted: ${model}. Use /status to confirm the active model.`;
  }

  private registerProcess(record: {
    pid: number;
    sessionId: string;
    providerSessionId: string;
    startedAt: number;
  }): void {
    try {
      this.processRegistry.upsert(record);
    } catch (error) {
      console.warn("Failed to record TeleCode Claude process", error);
    }
  }

  private removeRegisteredProcessPid(pid: number): void {
    try {
      this.processRegistry.removePid(pid);
    } catch (error) {
      console.warn("Failed to remove TeleCode Claude process record", error);
    }
  }

  private removeRegisteredProcessSession(sessionId: string): void {
    try {
      this.processRegistry.removeSession(sessionId);
    } catch (error) {
      console.warn("Failed to remove TeleCode Claude session process record", error);
    }
  }

  private async stopRuntimePty(runtime: RuntimeSession, options: { graceful?: boolean } = {}): Promise<void> {
    const ptySession = runtime.pty;
    if (!ptySession) {
      return;
    }
    const pid = runtime.ptyPid;
    runtime.pty = undefined;
    runtime.ptyPid = undefined;
    bridgeLog("pty", `dispose pid=${pid ?? "?"} graceful=${options.graceful ?? true} session=${runtime.providerSessionId}`);
    await ptySession.dispose(options.graceful ?? true);
    if (pid) {
      this.removeRegisteredProcessPid(pid);
    } else {
      this.removeRegisteredProcessSession(runtime.descriptor.id);
    }
  }

  /**
   * Send a turn and locate the transcript Claude writes for it. Interactive Claude
   * ignores the --session-id we pass, so we cannot predict the filename. We snapshot the
   * transcripts on disk before sending, then detect the file that appears or grows, and
   * reconcile the runtime's session id to the real one so later --resume and reads work.
   */
  /**
   * Config dir to scan for transcripts. In strict-mcp mode the child runs against the
   * real ~/.claude (undefined => homedir/.claude); otherwise the isolated config dir.
   */
  private get transcriptConfigDir(): string | undefined {
    return this.config.claudeStrictMcpConfig ? undefined : this.config.claudeConfigDir;
  }

  private async locateTurnTranscript(
    runtime: RuntimeSession,
    promptText: string,
    send: () => Promise<void>,
    options: { requirePromptEcho?: boolean; disposeOnFailure?: boolean } = {},
  ): Promise<LocatedTurnOutput> {
    const configDir = this.transcriptConfigDir;
    let knownPath = runtime.transcriptPath;
    if (!knownPath) {
      knownPath = (await findTranscript(runtime.providerSessionId, 1000, configDir)) ?? undefined;
    }
    const knownOffset = knownPath && existsSync(knownPath) ? safeFileSize(knownPath) : 0;
    // Once we know Claude's real transcript path, only look inside that project directory
    // so a concurrent standalone Claude cannot have its transcript mistaken for this turn.
    const projectDir = knownPath ? dirname(knownPath) : undefined;

    const screenBefore = runtime.pty?.strippedText() ?? "";
    const requirePromptEcho = options.requirePromptEcho ?? true;
    const disposeOnFailure = options.disposeOnFailure ?? true;
    const locate = async (
      before: Map<string, number>,
      offset: number,
      timeoutMs: number,
    ): Promise<ActiveTranscript | null> => {
      return requirePromptEcho
        ? await locateActiveTranscriptTurnByPrompt({
            before,
            promptText,
            expectedSessionId: runtime.providerSessionId,
            knownPath,
            knownOffset: offset,
            timeoutMs,
            configDir,
            projectDir,
          })
        : await locateActiveTranscript({
            before,
            expectedSessionId: runtime.providerSessionId,
            knownPath,
            knownOffset: offset,
            timeoutMs,
            configDir,
            projectDir,
          });
    };

    // A missing input echo means the CLI's input handling changed or broke; the prompt
    // was NOT submitted, so surface it as retryable delivery failure (bot requeues the
    // user's text and can fall back to the SDK engine) instead of a session-killing error.
    const guardedSend = async (): Promise<void> => {
      try {
        await send();
      } catch (error) {
        if (error instanceof PromptEchoMissingError && runtime.pty?.isAlive) {
          const tail = screenTail(runtime.pty);
          runtime.pty.clearInput();
          throw new PromptNotDeliveredError(
            promptText,
            `${error.message} Screen tail: ${tail}`,
          );
        }
        throw error;
      }
    };

    const before = await snapshotTranscriptSizes(configDir);
    await guardedSend();

    let active = await locate(before, knownOffset, requirePromptEcho ? 8000 : 30000);
    if (!active && requirePromptEcho && runtime.pty?.isAlive) {
      const ready = await runtime.pty.waitForReadyPrompt(2500);
      if (ready) {
        runtime.pty.clearInput();
        await sleep(100);
        const retryKnownOffset = knownPath && existsSync(knownPath) ? safeFileSize(knownPath) : 0;
        const retryBefore = await snapshotTranscriptSizes(configDir);
        await guardedSend();
        active = await locate(retryBefore, retryKnownOffset, 30000);
      } else {
        active = await locate(before, knownOffset, 22000);
      }
    }
    if (!active) {
      if (requirePromptEcho) {
        const recovered = await locateTranscriptTurnByPrompt({
          promptText,
          expectedSessionId: runtime.providerSessionId,
          knownPath,
          minOffset: knownOffset,
          before,
          configDir,
        });
        if (recovered) {
          return this.reconcileLocatedTranscript(runtime, recovered);
        }
        const tail = screenTail(runtime.pty);
        // Do not type /exit here. On prompt-location failure Claude may still have the
        // user's prompt sitting in the input box; graceful /exit would append to it and
        // can submit a corrupted prompt.
        if (runtime.pty?.isAlive) {
          const ready = await runtime.pty.waitForReadyPrompt(1000);
          if (ready) {
            runtime.pty.clearInput();
          } else {
            runtime.pty.clearInput();
          }
          throw new PromptNotDeliveredError(
            promptText,
            `Claude did not accept the message yet. Screen tail: ${tail}`,
          );
        }
        await this.stopRuntimePty(runtime, { graceful: false });
        throw new Error(`Claude did not record the prompt in its transcript. Screen tail: ${tail}`);
      }

      const fallbackText = extractScreenFallbackText(screenBefore, runtime.pty?.strippedText() ?? "");
      if (fallbackText) {
        return { fallbackText };
      }
      if (!disposeOnFailure) {
        // Slash command that wrote no readable turn (e.g. a config-only command). Keep the
        // session alive and report a benign result instead of killing the PTY.
        return { fallbackText: "Claude handled the command. It did not produce a transcript response to read back." };
      }
      const tail = screenTail(runtime.pty);
      // Same as above: if no transcript turn was found, avoid writing /exit into a
      // potentially live input buffer.
      await this.stopRuntimePty(runtime, { graceful: false });
      throw new Error(`Claude transcript was not created. Screen tail: ${tail}`);
    }

    return this.reconcileLocatedTranscript(runtime, active);
  }

  private reconcileLocatedTranscript(
    runtime: RuntimeSession,
    active: { path: string; startOffset: number },
  ): { transcriptPath: string; startOffset: number } {
    runtime.transcriptPath = active.path;
    // A located transcript means Claude's real session id is known; SDK turns may
    // resume it from here on, including after a live backend switch.
    runtime.hasLiveProviderSession = true;
    bridgeLog("echo", `located ${basename(active.path)} offset=${active.startOffset}`);
    runtime.descriptor.metadata = {
      ...runtime.descriptor.metadata,
      transcriptPath: active.path,
    };
    // The fork (if any) is resolved to a real session now; a persisted source id
    // must not trigger a second fork after a restart.
    delete runtime.descriptor.metadata.forkSourceSessionId;
    const realSessionId = sessionIdFromTranscriptPath(active.path);
    if (realSessionId && realSessionId !== runtime.providerSessionId) {
      runtime.providerSessionId = realSessionId;
      runtime.descriptor.providerSessionId = realSessionId;
      runtime.descriptor.updatedAt = Date.now();
    }
    return { transcriptPath: active.path, startOffset: active.startOffset };
  }

  private buildDescriptor(options: {
    id: string;
    providerSessionId: string;
    workspace: string;
    displayName?: string;
    model: string;
    permissionMode: ClaudePermissionMode;
    status: AgentSessionDescriptor["status"];
    backend?: ClaudeBackend;
  }): AgentSessionDescriptor {
    const now = Date.now();
    return {
      id: options.id,
      provider: "claude",
      workspace: options.workspace,
      displayName: options.displayName,
      providerSessionId: options.providerSessionId,
      status: options.status,
      capabilities: CLAUDE_CAPABILITIES,
      createdAt: now,
      updatedAt: now,
      metadata: {
        model: options.model,
        permissionMode: options.permissionMode,
        ...(options.backend ? { backend: options.backend } : {}),
      },
    };
  }

  private runtimeFromDescriptor(descriptor: AgentSessionDescriptor): RuntimeSession {
    const providerSessionId = descriptor.providerSessionId;
    if (!providerSessionId) {
      throw new Error("Claude descriptor is missing providerSessionId");
    }
    return {
      descriptor: { ...descriptor, capabilities: CLAUDE_CAPABILITIES },
      providerSessionId,
      workspace: descriptor.workspace || this.config.claudeWorkspace,
      model: asString(descriptor.metadata?.model) || this.config.claudeDefaultModel,
      permissionMode: asPermissionMode(descriptor.metadata?.permissionMode) || this.config.claudePermissionMode,
      backend: asClaudeBackend(descriptor.metadata?.backend) || this.config.claudeBackend,
      busy: false,
      transcriptPath: asString(descriptor.metadata?.transcriptPath) || undefined,
      hasLiveProviderSession: false,
      forkSourceSessionId: asString(descriptor.metadata?.forkSourceSessionId) || undefined,
    };
  }

  private requireRuntime(sessionId: string): RuntimeSession {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      throw new Error(`Unknown Claude session: ${sessionId}`);
    }
    return runtime;
  }

  private validateEnabled(): void {
    if (!this.config.enableClaudeProvider) {
      throw new Error("Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.");
    }
  }
}

// CLAUDE_CONTEXT_WINDOW is one number for every model, which reported an Opus 5
// session as five times over its window. The model's own window wins when we
// recognise it; the configured value stays the fallback for anything new.
const CLAUDE_CONTEXT_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/haiku/iu, 200_000],
  [/opus|sonnet|fable|mythos/iu, 1_000_000],
];

export function contextWindowForModel(model: string | undefined): number | undefined {
  if (!model) {
    return undefined;
  }
  for (const [pattern, window] of CLAUDE_CONTEXT_WINDOWS) {
    if (pattern.test(model)) {
      return window;
    }
  }
  return undefined;
}

function promptToText(input: AgentSendPromptOptions["input"]): string {
  const parts: string[] = [];
  if (input.text) {
    parts.push(input.text);
  }
  for (const imagePath of input.imagePaths ?? []) {
    parts.push(`Image file: ${imagePath}`);
  }
  for (const filePath of input.filePaths ?? []) {
    parts.push(`File: ${filePath}`);
  }
  return parts.join("\n\n");
}

function parseClaudeModelCommand(text: string): string | undefined {
  const match = text.trim().match(/^\/model(?:@\w+)?\s+([a-zA-Z0-9_.:-]+)$/u);
  return match?.[1];
}

const CLAUDE_MODEL_CONFIRMATION_MARKERS = [
  /switchmodel/,
  /yes,switchto/,
  /switchto/,
  /confirmmodel/,
];

const CLAUDE_MODEL_FAILURE_MARKERS = [
  /model(?:is)?notavailable/,
  /modelunavailable/,
  /notinyourorganizationsallowedmodels/,
  /notinyourorganization'sallowedmodels/,
  /requiresusagecredits/,
  /enableusagecredits/,
  /unknownmodel/,
  /invalidmodel/,
  /notenabled/,
];

function extractModelCommandFailure(screen: string): string | undefined {
  const lines = screen
    .replace(/[\u2500-\u257f\u25cf\u25b0\u25b1\u2722\u273b\u273d\u2736]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const failureLines = lines.filter((line) => {
    const compact = line.replace(/\s+/g, "").toLowerCase();
    return CLAUDE_MODEL_FAILURE_MARKERS.some((marker) => marker.test(compact));
  });
  const candidate = failureLines.at(-1);
  if (!candidate) {
    return undefined;
  }
  return cleanScreenFallbackCandidate(candidate) ?? candidate;
}

/**
 * True when the prompt is a real Claude Code slash command that TeleCode forwards to the
 * PTY (DISPATCH / DISPATCH+ARG). These are recorded by Claude as <command-name> transcript
 * entries, not plain user prompts, so their turns must be located by transcript growth
 * rather than by prompt echo. /model is handled separately, so it is excluded here.
 */
function isDispatchSlashCommand(text: string): boolean {
  const parsed = parseClaudeSlashCommand(text);
  if (!parsed || parsed.name === "model") {
    return false;
  }
  const spec = getClaudeCommandSpec(parsed.name);
  return spec?.class === "dispatch" || spec?.class === "dispatch_arg";
}

function shouldPassClaudeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return Boolean(normalized && normalized !== "default");
}

const TELECODE_CLAUDE_SETTINGS = {
  channelsEnabled: false,
  enabledPlugins: {
    "telegram@claude-plugins-official": false,
  },
};

const TELECODE_CLAUDE_SYSTEM_PROMPT = [
  "You are running inside TeleCode, which relays this Claude Code session to the user through its own Telegram bot.",
  "Do not send Telegram messages yourself. Do not use Telegram channel plugins, Telegram skills, Telegram bot tokens, curl requests to api.telegram.org, or scripts that contact Telegram.",
  "Return every response through the current Claude Code conversation transcript only; TeleCode will deliver it to the user.",
].join("\n");

function safeFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function screenTail(ptySession: ClaudePty | undefined): string {
  const text = ptySession?.strippedText().replace(/\s+/g, " ").trim() ?? "";
  return text.slice(-1000) || "(empty)";
}

function appendScreenTail(message: string, ptySession: ClaudePty | undefined): string {
  const tail = screenTail(ptySession);
  if (!tail || tail === "(empty)" || message.includes("Screen tail:")) {
    return message;
  }
  return `${message}. Screen tail: ${tail}`;
}

function isPtyReadinessFailure(error: unknown): boolean {
  return /(?:did not reach a ready prompt|never became ready|prompt did not become ready|prompt did not settle)/iu
    .test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turn a raw `/usage` panel screen capture into a clean, screen-reader-friendly block:
 * drop box-drawing chrome, the input prompt/footer, and the TeleCode system-prompt echo,
 * then collapse blank runs. Returns null when nothing usable is left.
 */
export function cleanUsagePanel(screen: string): string | null {
  const rawLines = screen
    .replace(/[─-╿⬢⬡●▌▐█]/g, " ")
    .split(/\r?\n/);
  const panelStart = latestUsagePanelStart(rawLines);
  const lines = (panelStart >= 0 ? rawLines.slice(panelStart) : rawLines)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      const lower = line.toLowerCase();
      return !(
        lower.includes("shift+tab") ||
        lower.includes("? for shortcuts") ||
        lower.includes("esc to") ||
        lower.includes("to go back") ||
        lower.includes("telecode") ||
        lower.startsWith(">") ||
        lower === "usage" ||
        /^[\s>│|]+$/.test(line)
      );
    });

  const seen = new Set<string>();
  const deduped = lines.filter((line) => {
    if (seen.has(line)) {
      return false;
    }
    seen.add(line);
    return true;
  });

  const text = deduped.join("\n").trim();
  return text.length > 0 ? text : null;
}

function latestUsagePanelStart(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const lower = lines[index]?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
    if (
      lower === "usage" ||
      lower.includes("usage limits") ||
      lower.includes("usage limit") ||
      lower.includes("current usage") ||
      lower.includes("claude usage") ||
      lower.includes("/usage")
    ) {
      return index;
    }
  }
  return -1;
}

function extractScreenFallbackText(before: string, after: string): string | undefined {
  const delta = after.length > before.length ? after.slice(before.length) : after;
  const normalized = delta.replace(/\s+/g, " ").trim();
  const candidates: string[] = [];
  for (const match of normalized.matchAll(/\u25cf\s*([^\u25cf]{1,2000})/giu)) {
    const candidate = cleanScreenFallbackCandidate(match[1] ?? "");
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates.at(-1);
}

function cleanScreenFallbackCandidate(raw: string): string | undefined {
  const candidate = raw
    .replace(/\s*[\u2722\u273b\u273d\u2736*]\s+\S+ing\b[\s\S]*$/iu, "")
    .replace(/[\u2500-\u257f]/g, " ")
    .replace(/[\u23f5\u25cf\u2722\u273b\u273d\u2736]/g, " ")
    .replace(/\s+(?:[\u00b7*]?\s*)?(?:Booping|Bootstrapping|Cogitated|Crunched|Worked|Thinking|Precipitating)\b[\s\S]*$/iu, "")
    .replace(/\s*\([^)]*\btokens?\)[\s\S]*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!candidate) {
    return undefined;
  }

  const lower = candidate.toLowerCase();
  if (
    lower.includes("accept edits") ||
    lower.includes("shift+tab") ||
    lower.includes("/effort") ||
    lower.includes("telecode") ||
    lower.includes("tokens)") ||
    lower === "high" ||
    lower === "medium" ||
    lower === "low"
  ) {
    return undefined;
  }
  return candidate;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asPermissionMode(value: unknown): ClaudePermissionMode | undefined {
  return value === "default" || value === "acceptEdits" || value === "plan" || value === "bypassPermissions"
    ? value
    : undefined;
}

function asClaudeBackend(value: unknown): ClaudeBackend | undefined {
  return value === "pty" || value === "sdk" ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
