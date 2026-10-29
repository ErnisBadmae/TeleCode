import { bridgeLog } from "../bridge-log.js";
import type { ClaudePermissionMode } from "../config.js";
import type { AgentPermissionDecision, AgentPermissionRequest, AgentProviderEvent } from "./types.js";

/**
 * Agent SDK turn runner — the D3 fix. The SDK streams EVERY assistant message
 * (interim narration between tool calls included), unlike the interactive
 * transcript, which drops some mid-turn text blocks. Verified by the C0 spike
 * on @anthropic-ai/claude-agent-sdk 0.3.204 (2026-07-08): ALPHA/BETA/GAMMA all
 * arrived as separate assistant messages, resume continued the session, and
 * forkSession minted a new session id.
 *
 * One query() per turn with `resume` — restart-safe and identical to the PTY
 * path's per-turn model. The SDK writes the same ~/.claude/projects transcript
 * format, so sessions stay switchable between backends.
 */

export interface ClaudeSdkTurnOptions {
  /** TeleCode descriptor id — stamped on every emitted event. */
  sessionId: string;
  jobId: string;
  promptText: string;
  cwd: string;
  claudeBin: string;
  model?: string;
  permissionMode: ClaudePermissionMode;
  /** Provider (Claude) session id to resume; omitted for a fresh session. */
  resume?: string;
  forkSession?: boolean;
  abortController?: AbortController;
  /** Called as soon as the init message reveals the real Claude session id. */
  onProviderSessionId?: (providerSessionId: string) => void;
  /** Optional controller for live steering after promptText starts the turn. */
  inputController?: ClaudeSdkInputController;
  /** Emit a visible status when the SDK has produced no events for this long. */
  quietStatusIntervalMs?: number;
  /** Effective window Claude Code uses when deciding when to auto-compact. */
  autoCompactWindow?: number;
  /**
   * Asks the user about tool calls outside the allow rules. Without it the SDK
   * auto-denies them, because the bridge has no terminal to prompt in.
   */
  onPermissionRequest?: (request: AgentPermissionRequest) => Promise<AgentPermissionDecision>;
  /** Injectable for tests; defaults to the real SDK query(). */
  queryFn?: (input: {
    prompt: string | AsyncIterable<SdkUserMessageLike>;
    options: Record<string, unknown>;
  }) => AsyncIterable<SdkMessageLike> & {
    close?: () => void;
    streamInput?: (stream: AsyncIterable<SdkUserMessageLike>) => Promise<void>;
  };
}

export interface ClaudeSdkCompactOptions {
  cwd: string;
  claudeBin: string;
  model?: string;
  permissionMode: ClaudePermissionMode;
  /** Existing provider session to compact in place. */
  resume: string;
  instructions?: string;
  abortController?: AbortController;
  timeoutMs?: number;
  autoCompactWindow?: number;
  onProviderSessionId?: (providerSessionId: string) => void;
  /** Injectable for tests; defaults to the real SDK query(). */
  queryFn?: ClaudeSdkTurnOptions["queryFn"];
}

export interface ClaudeSdkCompactResult {
  providerSessionId: string;
  preTokens?: number;
  postTokens?: number;
  trigger?: "manual" | "auto";
}

/** Structural view of the SDK messages this engine consumes. */
export interface SdkMessageLike {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    model?: string;
    content?: Array<Record<string, unknown>>;
    /** Per-message usage; its prompt fields are the live context size. */
    usage?: Record<string, unknown>;
  };
  result?: string;
  usage?: Record<string, unknown>;
  compact_metadata?: {
    trigger?: "manual" | "auto";
    pre_tokens?: number;
    post_tokens?: number;
    duration_ms?: number;
  };
  total_cost_usd?: number;
  errors?: unknown[];
}

export interface SdkUserMessageLike {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  };
  parent_tool_use_id: null;
  priority?: "now" | "next" | "later";
  shouldQuery?: boolean;
  timestamp?: string;
}

export class ClaudeSdkInputController implements AsyncIterable<SdkUserMessageLike> {
  private readonly queue: SdkUserMessageLike[] = [];
  private readonly waiters: Array<(result: IteratorResult<SdkUserMessageLike>) => void> = [];
  private closed = false;
  private deliveredMessageCount = 0;

  /** Number of live inputs already handed to the SDK stream consumer. */
  get deliveredCount(): number {
    return this.deliveredMessageCount;
  }

  push(text: string, priority: SdkUserMessageLike["priority"] = "now"): void {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Claude steer text is empty");
    }
    if (this.closed) {
      throw new Error("Claude SDK input stream is closed");
    }
    const message = sdkUserMessage(trimmed, priority);
    const waiter = this.waiters.shift();
    if (waiter) {
      this.deliveredMessageCount += 1;
      waiter({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkUserMessageLike> {
    return {
      next: async (): Promise<IteratorResult<SdkUserMessageLike>> => {
        const next = this.queue.shift();
        if (next) {
          this.deliveredMessageCount += 1;
          return { value: next, done: false };
        }
        if (this.closed) {
          return { value: undefined, done: true };
        }
        return await new Promise<IteratorResult<SdkUserMessageLike>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

export async function* runClaudeSdkTurn(options: ClaudeSdkTurnOptions): AsyncIterable<AgentProviderEvent> {
  const queryFn = options.queryFn ?? (await loadSdkQuery());
  const { sessionId, jobId } = options;

  const baseSdkOptions = buildSdkQueryOptions(options);

  let lastModel: string | undefined;
  let lastContextTokens: number | undefined;
  let activeProviderSessionId = options.resume;
  const inputController = options.inputController;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retryPrompt = attempt === 0
        ? options.promptText
        : "The previous turn ended successfully but produced no written response. Answer the user's most recent request now. Do not repeat completed tool actions; summarize them if any occurred.";
      const sdkOptions = {
        ...baseSdkOptions,
        ...(activeProviderSessionId ? { resume: activeProviderSessionId } : {}),
        ...(attempt > 0 ? { forkSession: false } : {}),
      };
      // A string prompt makes Anthropic's Query a single-user-turn query. The SDK then
      // closes CLI stdin on the FIRST result, including the empty interrupted result
      // produced by a priority-now steer. Keep the initial prompt and all live steers in
      // one primary AsyncIterable so the SDK leaves stdin open for the continuation.
      // The initial message is yielded before the controller is read, so it cannot be
      // overtaken by a live steer or a pending provider notification.
      const sdkPrompt = attempt === 0 && inputController
        ? initialPromptAndLiveInput(retryPrompt, inputController)
        : retryPrompt;
      const query = queryFn({ prompt: sdkPrompt, options: sdkOptions });
      let sawResult = false;
      let sawTerminalResult = false;
      let finalAssistantText = "";
      let finalAssistantTextSteerCount = inputController?.deliveredCount ?? 0;
      let handledSteerCount = 0;
      let retryEmptySuccess = false;

      try {
        for await (const item of sdkMessagesWithQuietStatus(
          query,
          options.quietStatusIntervalMs ?? 180_000,
        )) {
          if (item.kind === "quiet") {
            yield {
              type: "status_message",
              sessionId,
              jobId,
              text: formatSdkQuietWarning(item.quietForMs),
            };
            continue;
          }
          const message = item.message;
          if (message.type === "system" && message.subtype === "init") {
            if (message.session_id) {
              activeProviderSessionId = message.session_id;
              options.onProviderSessionId?.(message.session_id);
            }
            continue;
          }

          if (message.type === "system" && message.subtype === "compact_boundary") {
            const preTokens = asNumber(message.compact_metadata?.pre_tokens);
            const postTokens = asNumber(message.compact_metadata?.post_tokens);
            if (postTokens !== undefined) {
              lastContextTokens = postTokens;
            }
            yield {
              type: "compact_boundary",
              sessionId,
              summary: formatSdkCompactBoundary(preTokens, postTokens),
              postTokens,
            };
            continue;
          }

          if (message.type === "assistant") {
            // The prompt of the most recent API call is the live context size.
            const assistantUsage = message.message?.usage;
            if (assistantUsage) {
              const prompt = (asNumber(assistantUsage.input_tokens) ?? 0) +
                (asNumber(assistantUsage.cache_read_input_tokens) ?? 0) +
                (asNumber(assistantUsage.cache_creation_input_tokens) ?? 0);
              const completion = asNumber(assistantUsage.output_tokens) ?? 0;
              if (prompt > 0) {
                lastContextTokens = prompt + completion;
              }
            }
            const deliveredSteerCount = inputController?.deliveredCount ?? 0;
            if (deliveredSteerCount !== finalAssistantTextSteerCount) {
              // Text emitted before a priority-now steer belongs to the interrupted
              // response, not to the answer Claude still owes for the steer.
              finalAssistantText = "";
              finalAssistantTextSteerCount = deliveredSteerCount;
            }
            const model = message.message?.model;
            if (model && model !== "<synthetic>" && model !== lastModel) {
              lastModel = model;
              yield { type: "model_updated", sessionId, jobId, model };
            }
            for (const block of message.message?.content ?? []) {
              const blockType = typeof block.type === "string" ? block.type : "";
              if (blockType === "text" && typeof block.text === "string" && block.text.trim()) {
                finalAssistantText += `${finalAssistantText ? "\n\n" : ""}${block.text.trim()}`;
                yield { type: "assistant_text_delta", sessionId, jobId, text: block.text };
              } else if (blockType === "tool_use") {
                // Narration before a tool call is progress. Only text after the final
                // tool call can stand in for an SDK result whose result field is empty.
                finalAssistantText = "";
                finalAssistantTextSteerCount = deliveredSteerCount;
                yield {
                  type: "tool_started",
                  sessionId,
                  jobId,
                  toolName: typeof block.name === "string" && block.name ? block.name : "tool",
                  text: summarizeSdkToolInput(block.input),
                };
              }
            }
            continue;
          }

          if (message.type === "user") {
            for (const block of message.message?.content ?? []) {
              if (block.type !== "tool_result") {
                continue;
              }
              yield {
                type: block.is_error === true ? "tool_failed" : "tool_completed",
                sessionId,
                jobId,
                toolName: "tool",
              };
            }
            continue;
          }

          if (message.type === "result") {
            sawResult = true;
            const usage = message.usage ?? {};
            const inputTokens = asNumber(usage.input_tokens) ?? 0;
            const cachedInputTokens = (asNumber(usage.cache_read_input_tokens) ?? 0) +
              (asNumber(usage.cache_creation_input_tokens) ?? 0);
            const outputTokens = asNumber(usage.output_tokens) ?? 0;
            // These three are the turn's totals across every API call it made;
            // contextTokens is the live prompt size. Reporting the totals as
            // "context" produced millions-of-tokens readings on long turns.
            yield {
              type: "usage_updated",
              sessionId,
              jobId,
              inputTokens,
              cachedInputTokens,
              outputTokens,
              contextTokens: lastContextTokens,
            };

            if (message.subtype === "success") {
              const resultText = (message.result ?? "").trim();
              const deliveredSteerCount = inputController?.deliveredCount ?? 0;
              if (deliveredSteerCount !== finalAssistantTextSteerCount) {
                finalAssistantText = "";
                finalAssistantTextSteerCount = deliveredSteerCount;
              }
              const completionText = resultText || finalAssistantText.trim();
              if (completionText) {
                yield {
                  type: "assistant_message_complete",
                  sessionId,
                  jobId,
                  text: completionText,
                };
                sawTerminalResult = true;
              } else if (deliveredSteerCount > handledSteerCount) {
                // A priority-now steer interrupts Claude's current response. The SDK
                // reports that interrupted response as an empty successful result, then
                // continues the SAME query with the steered response. Do not close the
                // query on this intermediate result.
                handledSteerCount = deliveredSteerCount;
                bridgeLog(
                  "steer",
                  `sdk received empty interrupted result; awaiting steered continuation session=${activeProviderSessionId ?? sessionId}`,
                );
                continue;
              } else if (attempt === 0) {
                retryEmptySuccess = true;
                sawTerminalResult = true;
                bridgeLog("retry", `sdk turn returned empty success; retrying session=${activeProviderSessionId ?? sessionId}`);
              } else {
                yield {
                  type: "error",
                  sessionId,
                  jobId,
                  message: "Claude SDK returned a successful result without assistant text twice.",
                };
                sawTerminalResult = true;
              }
            } else {
              const detail = message.result?.trim() || describeSdkErrors(message.errors) || message.subtype || "unknown error";
              bridgeLog("error", `sdk turn result ${message.subtype ?? "?"}: ${detail}`);
              yield { type: "error", sessionId, jobId, message: `Claude SDK turn ended: ${detail}` };
              sawTerminalResult = true;
            }
            break;
          }

          // rate_limit_event, status, hook events, partial messages, etc. - not part
          // of the provider event contract; ignored deliberately.
        }
      } finally {
        if (attempt === 0) {
          inputController?.close();
        }
        query.close?.();
      }

      if (!sawResult) {
        yield {
          type: "error",
          sessionId,
          jobId,
          message: "Claude SDK stream ended without a result message (aborted or crashed).",
        };
        return;
      }
      if (!sawTerminalResult) {
        // The transport ended after the empty result that interrupted a live steer,
        // before it produced the continuation. Retry through resume instead of
        // silently accepting the interrupted response as a completed turn.
        if (attempt === 0) {
          retryEmptySuccess = true;
          bridgeLog(
            "retry",
            `sdk stream ended before steered continuation; retrying session=${activeProviderSessionId ?? sessionId}`,
          );
        } else {
          yield {
            type: "error",
            sessionId,
            jobId,
            message: "Claude SDK ended before producing a response to the live steer.",
          };
          return;
        }
      }
      if (!retryEmptySuccess) {
        return;
      }
    }
  } finally {
    inputController?.close();
  }
}

/**
 * Run Claude Code's native `/compact` command through the Agent SDK.
 *
 * A successful compact command normally has no assistant text. Its authoritative
 * success signal is the SDK's compact_boundary system event, so this path must
 * not use the normal empty-response retry behavior.
 */
export async function runClaudeSdkCompact(
  options: ClaudeSdkCompactOptions,
): Promise<ClaudeSdkCompactResult> {
  const resume = options.resume.trim();
  if (!resume) {
    throw new Error("Claude SDK compaction requires an existing provider session");
  }

  const queryFn = options.queryFn ?? (await loadSdkQuery());
  const abortController = options.abortController ?? new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, options.timeoutMs ?? 180_000);
  timer.unref?.();

  const command = options.instructions?.trim()
    ? `/compact ${options.instructions.trim()}`
    : "/compact";
  const query = queryFn({
    prompt: command,
    options: buildSdkQueryOptions({
      ...options,
      resume,
      abortController,
    }),
  });

  let providerSessionId = resume;
  let compactResult: ClaudeSdkCompactResult | undefined;
  let sawResult = false;

  try {
    for await (const message of query) {
      if (message.type === "system" && message.subtype === "init" && message.session_id) {
        providerSessionId = message.session_id;
        options.onProviderSessionId?.(message.session_id);
        continue;
      }

      if (message.type === "system" && message.subtype === "compact_boundary") {
        if (message.session_id) {
          providerSessionId = message.session_id;
          options.onProviderSessionId?.(message.session_id);
        }
        compactResult = {
          providerSessionId,
          preTokens: asNumber(message.compact_metadata?.pre_tokens),
          postTokens: asNumber(message.compact_metadata?.post_tokens),
          trigger: message.compact_metadata?.trigger,
        };
        continue;
      }

      if (message.type !== "result") {
        continue;
      }
      sawResult = true;
      if (message.subtype !== "success") {
        const detail = message.result?.trim() ||
          describeSdkErrors(message.errors) ||
          message.subtype ||
          "unknown error";
        throw new Error(`Claude SDK compaction ended: ${detail}`);
      }
      break;
    }
  } catch (error) {
    if (timedOut) {
      throw new Error("Claude SDK compaction did not finish before timeout", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    query.close?.();
  }

  if (!sawResult) {
    throw new Error("Claude SDK compaction stream ended without a result message");
  }
  if (!compactResult) {
    throw new Error("Claude SDK reported success without a compact boundary");
  }
  return compactResult;
}

async function* initialPromptAndLiveInput(
  promptText: string,
  inputController: ClaudeSdkInputController,
): AsyncIterable<SdkUserMessageLike> {
  yield sdkUserMessage(promptText);
  for await (const message of inputController) {
    yield message;
  }
}

type SdkMessageWaitResult =
  | { kind: "message"; message: SdkMessageLike }
  | { kind: "quiet"; quietForMs: number };

async function* sdkMessagesWithQuietStatus(
  messages: AsyncIterable<SdkMessageLike>,
  quietStatusIntervalMs: number,
): AsyncIterable<SdkMessageWaitResult> {
  const intervalMs = Math.max(1, quietStatusIntervalMs);
  const iterator = messages[Symbol.asyncIterator]();
  let nextMessage = iterator.next();
  let lastMessageAt = Date.now();

  while (true) {
    const outcome = await waitForSdkMessage(nextMessage, intervalMs);
    if (outcome.kind === "quiet") {
      yield { kind: "quiet", quietForMs: Date.now() - lastMessageAt };
      continue;
    }
    if (outcome.result.done) {
      return;
    }
    lastMessageAt = Date.now();
    yield { kind: "message", message: outcome.result.value };
    nextMessage = iterator.next();
  }
}

async function waitForSdkMessage(
  nextMessage: Promise<IteratorResult<SdkMessageLike>>,
  timeoutMs: number,
): Promise<
  | { kind: "message"; result: IteratorResult<SdkMessageLike> }
  | { kind: "quiet" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      nextMessage.then((result) => ({ kind: "message" as const, result })),
      new Promise<{ kind: "quiet" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "quiet" }), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function formatSdkQuietWarning(milliseconds: number): string {
  const duration = milliseconds < 60_000
    ? `${Math.max(1, Math.round(milliseconds / 1000))} ${milliseconds < 1_500 ? "second" : "seconds"}`
    : `${Math.max(1, Math.round(milliseconds / 60_000))} ${milliseconds < 90_000 ? "minute" : "minutes"}`;
  return [
    `Claude has been quiet for ${duration}.`,
    "It may still be working. Send /stop to stop it.",
    "If you do nothing, I will keep waiting.",
  ].join(" ");
}

async function loadSdkQuery(): Promise<NonNullable<ClaudeSdkTurnOptions["queryFn"]>> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query as unknown as NonNullable<ClaudeSdkTurnOptions["queryFn"]>;
}

function buildSdkQueryOptions(options: {
  cwd: string;
  claudeBin: string;
  model?: string;
  permissionMode: ClaudePermissionMode;
  resume?: string;
  forkSession?: boolean;
  abortController?: AbortController;
  autoCompactWindow?: number;
  onPermissionRequest?: ClaudeSdkTurnOptions["onPermissionRequest"];
}): Record<string, unknown> {
  return {
    cwd: options.cwd,
    model: options.model,
    permissionMode: options.permissionMode,
    pathToClaudeCodeExecutable: options.claudeBin,
    // Behave like the user's interactive sessions: Claude Code system prompt,
    // user + project settings, CLAUDE.md, and skills.
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project"],
    // The child must never start the user-scoped Telegram plugin's poller. It
    // would compete with this bridge for the same bot token.
    strictMcpConfig: true,
    env: scrubbedEnv(options.autoCompactWindow),
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.forkSession ? { forkSession: true } : {}),
    ...(options.abortController ? { abortController: options.abortController } : {}),
    ...(options.onPermissionRequest ? { canUseTool: sdkCanUseTool(options.onPermissionRequest) } : {}),
  };
}

interface SdkCanUseToolOptions {
  signal: AbortSignal;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  description?: string;
  toolUseID: string;
}

type SdkPermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[]; toolUseID: string }
  | { behavior: "deny"; message: string; toolUseID: string };

export function sdkCanUseTool(
  onPermissionRequest: NonNullable<ClaudeSdkTurnOptions["onPermissionRequest"]>,
): (toolName: string, input: Record<string, unknown>, options: SdkCanUseToolOptions) => Promise<SdkPermissionResult> {
  return async (toolName, input, options) => {
    const suggestions = options.suggestions ?? [];
    let decision: AgentPermissionDecision;
    try {
      decision = await onPermissionRequest({
        toolName,
        input,
        title: options.title,
        description: options.description,
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath,
        canAllowAlways: suggestions.length > 0,
        signal: options.signal,
      });
    } catch (error) {
      bridgeLog("permission", `permission request failed tool=${toolName}: ${String(error)}`);
      decision = "deny";
    }
    bridgeLog("permission", `tool=${toolName} decision=${decision}`);
    if (decision === "deny") {
      return { behavior: "deny", message: "The user denied this action in Telegram.", toolUseID: options.toolUseID };
    }
    return {
      behavior: "allow",
      updatedInput: input,
      // The SDK's own "don't ask again" rules, same as the terminal prompt offers.
      ...(decision === "allow_always" && suggestions.length > 0 ? { updatedPermissions: suggestions } : {}),
      toolUseID: options.toolUseID,
    };
  };
}

function sdkUserMessage(text: string, priority?: SdkUserMessageLike["priority"]): SdkUserMessageLike {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
    shouldQuery: true,
    timestamp: new Date().toISOString(),
  };
}

function scrubbedEnv(autoCompactWindow?: number): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  for (const key of Object.keys(env)) {
    if (
      key === "CLAUDECODE" ||
      key.startsWith("CLAUDE_CODE_") ||
      key.startsWith("TELECODE_") ||
      key.startsWith("TELECODEX_")
    ) {
      delete env[key];
    }
  }
  if (autoCompactWindow !== undefined && Number.isSafeInteger(autoCompactWindow) && autoCompactWindow > 0) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactWindow);
  }
  return env;
}

function formatSdkCompactBoundary(preTokens?: number, postTokens?: number): string {
  if (preTokens !== undefined && postTokens !== undefined) {
    return `Compacted: ${preTokens.toLocaleString("en-US")} -> ${postTokens.toLocaleString("en-US")} tokens`;
  }
  if (postTokens !== undefined) {
    return `Compacted to ${postTokens.toLocaleString("en-US")} tokens`;
  }
  return "Claude context compacted.";
}

function summarizeSdkToolInput(input: unknown): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  try {
    const text = typeof input === "string" ? input : JSON.stringify(input);
    const singleLine = text.replace(/\s+/g, " ").trim();
    return singleLine.length <= 300 ? singleLine : `${singleLine.slice(0, 299)}…`;
  } catch {
    return undefined;
  }
}

function describeSdkErrors(errors: unknown[] | undefined): string | undefined {
  if (!errors?.length) {
    return undefined;
  }
  try {
    return errors.map((error) => (typeof error === "string" ? error : JSON.stringify(error))).join("; ").slice(0, 500);
  } catch {
    return undefined;
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
