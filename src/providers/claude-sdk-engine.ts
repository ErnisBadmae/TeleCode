import { bridgeLog } from "../bridge-log.js";
import type { ClaudePermissionMode } from "../config.js";
import {
  buildVendorClaudeEnv,
  buildVendorClaudeSettingsEnv,
  resolveVendorModel,
} from "../model-vendors.js";
import {
  extractSystemNoticeText,
  isPriorityClaudeSystemNoticeSubtype,
} from "./claude-transcript.js";
import type { AgentProviderEvent } from "./types.js";

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
  /** SDK executable override; omitted keeps the CLI paired with the pinned SDK. */
  claudeBin?: string;
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
   * How long to keep the finished query alive after the turn's answer, draining
   * whatever the CLI still emits and forwarding it through onParkedEvent. The
   * CLI buffers background <task-notification>s and resume rescues in its own
   * pending queue; killing the process at the turn boundary turned each queued
   * item into a dead turn and a lost answer. 0 disables parking (legacy
   * teardown-at-answer behavior).
   */
  parkIdleMs?: number;
  /** Base park deadline; pending tasks extend it to at least PARK_PENDING_TASK_CAP_MS. */
  parkHardCapMs?: number;
  /** How long the parked drain groups text before sending. Defaults to PARK_FLUSH_DEBOUNCE_MS. */
  parkFlushDebounceMs?: number;
  /** Ceiling on how long the parked drain may hold text. Defaults to PARK_FLUSH_MAX_HOLD_MS. */
  parkFlushMaxHoldMs?: number;
  /** Receives events the CLI produced after the turn's answer (parked drain). */
  onParkedEvent?: (event: AgentProviderEvent) => void;
  /** Signals when the parked drain takes and releases the query + input controller. */
  onParkStateChanged?: (parked: boolean, query: ParkedQuery) => void;
  /**
   * Signals whether the parked CLI is doing work right now (true from the first
   * message of an injected turn until that turn's result). A park that is merely
   * waiting is idle; a park mid-turn is Claude actively working, and the bridge
   * must treat the lane as busy so the next message is offered as a steer rather
   * than silently pushed into the running turn.
   */
  onParkActivityChanged?: (active: boolean) => void;
  /**
   * A still-live query parked by this session's previous turn, already handed over
   * by the caller via takeOver(). When set, this turn steers the prompt into that
   * query instead of opening a new one, so the CLI is never interrupted mid-flight
   * on the work it queued after the last answer — the truncated turn that made
   * Claude Code inject "Continue from where you left off." on the next resume.
   * Its inputController must also be passed as options.inputController.
   */
  adoptedQuery?: ParkedQuery;
  /** Injectable for tests; defaults to the real SDK query(). */
  queryFn?: (input: {
    prompt: string | AsyncIterable<SdkUserMessageLike>;
    options: Record<string, unknown>;
  }) => AsyncIterable<SdkMessageLike> & {
    close?: () => void;
    setModel?: (model?: string) => Promise<void>;
    streamInput?: (stream: AsyncIterable<SdkUserMessageLike>) => Promise<void>;
  };
}

export interface ClaudeSdkCompactOptions {
  cwd: string;
  claudeBin?: string;
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
  content?: string;
  text?: string;
  notice?: string;
  original_model?: string;
  fallback_model?: string;
  api_refusal_category?: string | null;
  api_refusal_explanation?: string | null;
  scope?: "session" | "local";
  state?: "idle" | "running" | "requires_action";
  task_id?: string;
  run_id?: string;
  tasks?: Array<{ task_id: string; run_id?: string; ambient?: boolean }>;
  status?: string | null;
  is_backgrounded?: boolean;
  ambient?: boolean;
  skip_transcript?: boolean;
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

/**
 * Ceiling on injected-turn results we skip past in one attempt, so a CLI that only
 * ever emits silent results still terminates into the normal retry path.
 */
const MAX_IGNORED_INJECTED_RESULTS = 8;

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

  /** True once close() ran and before any reopen(); pushes would throw. */
  get isClosed(): boolean {
    return this.closed;
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

  /**
   * Re-arm the stream for the next attempt of the same turn. Each SDK query needs
   * its input iterable to end before it can shut down, but the turn as a whole is
   * still live and the user can still steer it. Without this a retry left the
   * controller permanently closed and every later steer threw.
   */
  reopen(): void {
    this.closed = false;
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

/**
 * Last-resort live-context recovery for vendors whose Anthropic-compatible
 * stream zeroes usage on every assistant message (Z.AI GLM does; verified
 * 2026-08-29): the live tracker above never engages, and the only real
 * per-call numbers are the usage blocks the CLI writes into the session
 * transcript. Read the LAST such block and return its prompt+completion
 * size, which is the live context at the end of the turn. Turn totals from
 * the stream's result message must never stand in for it: they re-count the
 * cached prefix on every API call and reach millions of tokens on long turns.
 */
export async function recoverSdkContextFromTranscript(
  providerSessionId: string,
  configDirs?: Array<string | undefined>,
): Promise<number | undefined> {
  try {
    const [{ findTranscript }, fs, os, path] = await Promise.all([
      import("./claude-transcript.js"),
      import("node:fs/promises"),
      import("node:os"),
      import("node:path"),
    ]);
    const candidates =
      configDirs ?? [undefined, path.join(os.homedir(), ".telecode", "claude-config")];
    let transcriptPath: string | null = null;
    for (const configDir of candidates) {
      transcriptPath = await findTranscript(providerSessionId, 0, configDir);
      if (transcriptPath) {
        break;
      }
    }
    if (!transcriptPath) {
      return undefined;
    }
    const handle = await fs.open(transcriptPath, "r");
    try {
      const { size } = await handle.stat();
      const readStart = Math.max(0, size - 128 * 1024);
      const length = size - readStart;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, readStart);
      const lines = buffer.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) {
          continue;
        }
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          // First tail line is usually a partial record; skip it.
          continue;
        }
        const record = entry as {
          type?: string;
          message?: { usage?: Record<string, unknown> };
        };
        if (record.type !== "assistant" || !record.message?.usage) {
          continue;
        }
        const usage = record.message.usage;
        const prompt = (asNumber(usage.input_tokens) ?? 0) +
          (asNumber(usage.cache_read_input_tokens) ?? 0) +
          (asNumber(usage.cache_creation_input_tokens) ?? 0);
        if (prompt <= 0) {
          continue;
        }
        return prompt + (asNumber(usage.output_tokens) ?? 0);
      }
      return undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Absolute ceiling on one parked query, whatever the traffic. */
export const PARK_HARD_CAP_MS = 30 * 60_000;

/** How long a new turn waits for the parked drain to let go before giving up on it. */
export const PARK_HANDOVER_TIMEOUT_MS = 5_000;

/**
 * How long the parked drain groups assistant text before sending it.
 *
 * Text used to be held until the injected turn's result message, which on a long
 * sub-turn meant minutes of silence while the CLI was visibly working. Grouping
 * for a beat keeps a rapid burst in one Telegram message without ever holding
 * finished narration hostage to a result that has not happened yet.
 */
export const PARK_FLUSH_DEBOUNCE_MS = 8_000;

/**
 * Ceiling on how long the debounce may keep holding text.
 *
 * The debounce restarts on every new block, so narration that keeps arriving just
 * inside the window would otherwise never be sent at all. This bounds the wait so
 * a steady stream still surfaces regularly instead of silently accumulating.
 */
export const PARK_FLUSH_MAX_HOLD_MS = 30_000;

/**
 * Ceiling on a park that is still waiting for a background task to report back.
 *
 * Claude Code ends the turn the moment it launches a background task and re-enters
 * itself when the task notification arrives. That gap is routinely longer than the
 * idle timeout, so such a park must outlive it, but not forever: each live park
 * holds a CLI process open.
 */
export const PARK_PENDING_TASK_CAP_MS = 60 * 60_000;

const TASK_ID_OPEN = "<task-id>";
const TASK_ID_CLOSE = "</task-id>";
const BACKGROUND_TASK_MARKER = "running in background with ID: ";
const TASK_ID_TERMINATORS = [" ", "\n", "\r", "\t", ".", ","];
const PARK_TASK_HANDOFF_MS = 30_000;
/** The CLI's synthetic answer to its own injected rescue prompt; never user-facing. */
const SYNTHETIC_BOILERPLATE = new Set(["No response requested."]);

/**
 * A live SDK query that outlives the turn that opened it. Two readers take turns
 * on it: the parked drain between turns, and runClaudeSdkTurn again when the next
 * prompt adopts the park instead of opening a fresh query.
 *
 * Handing the stream between readers must not drop a message, so the in-flight
 * iterator.next() promise is cached here. A reader that loses its race (idle
 * timeout, handover) leaves the pending promise behind for whoever reads next,
 * instead of abandoning it along with the message it is about to deliver.
 */
export class ParkedQuery implements AsyncIterable<SdkMessageLike> {
  private readonly iterator: AsyncIterator<SdkMessageLike>;
  private pending?: Promise<IteratorResult<SdkMessageLike>>;
  private closed = false;
  private active = false;
  private draining = false;
  private handoverWanted = false;
  private signalHandover?: () => void;
  private drainFinished?: Promise<void>;
  private resolveDrainFinished?: () => void;

  constructor(
    private readonly query: AsyncIterable<SdkMessageLike> & {
      close?: () => void;
      setModel?: (model?: string) => Promise<void>;
    },
    readonly inputController: ClaudeSdkInputController | undefined,
    public providerSessionId: string | undefined,
  ) {
    this.iterator = query[Symbol.asyncIterator]();
  }

  next(): Promise<IteratorResult<SdkMessageLike>> {
    if (!this.pending) {
      this.pending = this.iterator.next().then(
        (result) => {
          this.pending = undefined;
          return result;
        },
        (error) => {
          this.pending = undefined;
          throw error;
        },
      );
    }
    return this.pending;
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkMessageLike> {
    return { next: () => this.next() };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** True once a turn asked to adopt this query; the drain must then let go. */
  get handoverRequested(): boolean {
    return this.handoverWanted;
  }

  /** True while the parked CLI is mid-turn, i.e. genuinely working right now. */
  get isActive(): boolean {
    return this.active;
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  /**
   * Background work that keeps the query alive. New CLIs report its live set;
   * older ones track launches until their outcome notification arrives.
   *
   * Claude Code ends the turn as soon as it starts one and re-enters itself when the
   * task notification arrives, often minutes later. A park holding one of these is
   * waiting, not idle, and closing it on the idle timer throws the continuation away:
   * the notification then lands on a query that no longer exists and the work is lost.
   */
  private readonly pendingTasks = new Set<string>();
  private readonly backgroundTaskRuns = new Map<string, string>();
  /** Completion eligibility is separate from liveness: snapshots and notices can arrive in either order. */
  private readonly taskContinuations = new Map<string, { runId?: string; expiresAt?: number }>();
  private hasBackgroundTaskSnapshot = false;

  /** How many non-ambient background tasks still keep this query alive. */
  get pendingTaskCount(): number {
    return this.pendingTasks.size;
  }

  hasPendingTask(taskId: string, runId?: string): boolean {
    const currentRun = this.backgroundTaskRuns.get(taskId);
    return this.pendingTasks.has(taskId) && (!runId || !currentRun || runId === currentRun);
  }

  /**
   * New CLIs send a complete background-task snapshot, including tools moved into
   * the background by steering. Once available it is authoritative; mixing its
   * membership with the independently ordered task bookends can revive stale work.
   * Older CLIs fall back to task bookends and textual tool results.
   * Returns true when a tracked task completed and needs a model follow-up.
   */
  trackMessage(message: SdkMessageLike): boolean {
    const now = Date.now();
    for (const [id, candidate] of this.taskContinuations) {
      if (candidate.expiresAt !== undefined && candidate.expiresAt <= now) this.taskContinuations.delete(id);
    }
    let needsContinuation = false;
    if (message.type === "system" && message.subtype === "task_notification" && message.task_id) {
      const candidate = this.taskContinuations.get(message.task_id);
      if (candidate && (!message.run_id || !candidate.runId || message.run_id === candidate.runId)) {
        this.taskContinuations.delete(message.task_id);
        needsContinuation = !message.ambient && !message.skip_transcript;
      }
    }
    if (message.type === "system" && message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)) {
      this.hasBackgroundTaskSnapshot = true;
      const previousTasks = new Set(this.pendingTasks);
      const previousRuns = new Map(this.backgroundTaskRuns);
      this.pendingTasks.clear();
      this.backgroundTaskRuns.clear();
      for (const task of message.tasks) {
        if (task.task_id && !task.ambient) {
          if (!previousTasks.has(task.task_id) || previousRuns.get(task.task_id) !== task.run_id) {
            this.taskContinuations.set(task.task_id, { runId: task.run_id });
          } else {
            const candidate = this.taskContinuations.get(task.task_id);
            if (candidate) candidate.expiresAt = undefined;
          }
          this.pendingTasks.add(task.task_id);
          if (task.run_id) this.backgroundTaskRuns.set(task.task_id, task.run_id);
        }
      }
      for (const [id, candidate] of this.taskContinuations) {
        if (this.pendingTasks.has(id)) continue;
        if (message.tasks.some((task) => task.task_id === id && task.ambient)) {
          this.taskContinuations.delete(id);
        } else {
          // Older CLIs empty the snapshot before notifying. Remember only
          // recently removed work, once per run, without reviving its liveness.
          candidate.expiresAt ??= now + PARK_TASK_HANDOFF_MS;
        }
      }
      return false;
    }
    if (this.hasBackgroundTaskSnapshot) {
      return needsContinuation;
    }
    if (message.type === "system" && message.task_id) {
      if (message.subtype === "task_notification" && this.hasPendingTask(message.task_id, message.run_id)) {
        this.pendingTasks.delete(message.task_id);
        // Retain its run identity so a late start cannot revive completed work.
      } else if (
        message.subtype === "task_started" && message.is_backgrounded === true &&
        !message.ambient && !message.skip_transcript
      ) {
        const currentRun = this.backgroundTaskRuns.get(message.task_id);
        if (message.run_id && currentRun &&
          (message.run_id < currentRun || (message.run_id === currentRun && !this.pendingTasks.has(message.task_id)))) return false;
        if (!this.pendingTasks.has(message.task_id) || (message.run_id && message.run_id !== currentRun)) {
          this.taskContinuations.set(message.task_id, { runId: message.run_id });
        }
        this.pendingTasks.add(message.task_id);
        if (message.run_id) this.backgroundTaskRuns.set(message.task_id, message.run_id);
      }
      return needsContinuation;
    }
    if (message.type !== "user") {
      return false;
    }
    const raw = (message.message as { content?: unknown } | undefined)?.content;
    if (typeof raw === "string") {
      let matchedCompletion = false;
      let from = 0;
      while (from < raw.length) {
        const open = raw.indexOf(TASK_ID_OPEN, from);
        if (open < 0) {
          break;
        }
        const close = raw.indexOf(TASK_ID_CLOSE, open);
        if (close < 0) {
          break;
        }
        const taskId = raw.slice(open + TASK_ID_OPEN.length, close).trim();
        if (this.pendingTasks.delete(taskId)) matchedCompletion = true;
        this.taskContinuations.delete(taskId);
        from = close + TASK_ID_CLOSE.length;
      }
      return matchedCompletion;
    }
    if (!Array.isArray(raw)) {
      return false;
    }
    for (const entry of raw) {
      const block = entry as Record<string, unknown>;
      if (block.type !== "tool_result") {
        continue;
      }
      const content = block.content;
      if (typeof content !== "string") {
        continue;
      }
      let from = 0;
      while (from < content.length) {
        const at = content.indexOf(BACKGROUND_TASK_MARKER, from);
        if (at < 0) {
          break;
        }
        const start = at + BACKGROUND_TASK_MARKER.length;
        let end = start;
        while (end < content.length && !TASK_ID_TERMINATORS.includes(content[end])) {
          end += 1;
        }
        const id = content.slice(start, end).trim();
        if (id) {
          if (!this.pendingTasks.has(id)) this.taskContinuations.set(id, {});
          this.pendingTasks.add(id);
        }
        from = end + 1;
      }
    }
    return false;
  }

  /** Called by the drain as it takes the stream; re-arms after a previous handover. */
  beginDrain(): void {
    this.draining = true;
    this.handoverWanted = false;
    this.signalHandover = undefined;
    this.drainFinished = new Promise<void>((resolve) => {
      this.resolveDrainFinished = resolve;
    });
  }

  /** Race target for the drain: resolves when a turn wants the stream. */
  handoverSignal(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.handoverWanted) {
        resolve();
        return;
      }
      this.signalHandover = resolve;
    });
  }

  /** Called by the drain as it stops reading, whatever the reason. */
  endDrain(): void {
    this.draining = false;
    this.resolveDrainFinished?.();
  }

  /**
   * Hand the stream to the next turn. Resolves true when the caller now owns it
   * and may push its prompt into inputController; false when the park is already
   * gone (CLI exited, hard cap hit, drain closed it) and the caller must open a
   * fresh query. Always waits for the drain to stop reading first, so a turn
   * never races the drain for a message, and never opens a second CLI process
   * against a transcript the old one is still writing.
   */
  async takeOver(timeoutMs = PARK_HANDOVER_TIMEOUT_MS): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    if (this.draining) {
      this.handoverWanted = true;
      this.signalHandover?.();
      // Bounded: this sits on the path of the user's next message. A drain that
      // somehow fails to let go must cost one fresh query, not a stuck chat.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const handedOver = await Promise.race([
        this.drainFinished?.then(() => true) ?? Promise.resolve(true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }
      if (!handedOver) {
        bridgeLog("park", `parked query did not hand over within ${timeoutMs}ms; opening a fresh one`);
        this.close();
        return false;
      }
    }
    if (this.closed || this.inputController?.isClosed !== false) {
      return false;
    }
    return true;
  }

  /**
   * Switch the model of the live CLI behind this park. A park is the process
   * that answers the next prompt (adoption), so a /model while it is alive must
   * reach it now; otherwise the next turn runs on the old model and the observed
   * model then overwrites the user's choice. Returns false when the query has no
   * control channel (or is already closed) so the caller can close the park and
   * let the next turn open fresh on the new model instead.
   */
  async setModel(model: string | undefined): Promise<boolean> {
    if (this.closed || typeof this.query.setModel !== "function") {
      return false;
    }
    await this.query.setModel(model);
    return true;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.inputController?.close();
    } catch {
      // Teardown must never throw.
    }
    try {
      this.query.close?.();
    } catch {
      // Teardown must never throw.
    }
  }
}

type ParkedWaitOutcome =
  | { kind: "message"; result: IteratorResult<SdkMessageLike> }
  | { kind: "timeout" }
  | { kind: "handover" };

/**
 * Wait for the next parked message, giving up after timeoutMs or as soon as a new
 * turn asks to adopt the query. Unlike waitForSdkMessage, which keeps waiting and
 * only reports quiet periods, a parked drain's whole job is to let go when the CLI
 * goes silent or when the next prompt needs the stream.
 */
async function waitForParkedMessage(
  handle: ParkedQuery,
  timeoutMs: number,
): Promise<ParkedWaitOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<ParkedWaitOutcome>([
      handle.next().then((result) => ({ kind: "message", result }) as const),
      handle.handoverSignal().then(() => ({ kind: "handover" }) as const),
      new Promise<ParkedWaitOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Keep a finished query alive and forward whatever the CLI still says. The turn's
 * answer is already delivered; everything here is bonus material (late narration
 * the result message raced ahead of, background task notifications the CLI acts on
 * once it goes idle). Every failure is swallowed: parking must never turn a
 * completed turn into an error, and closing the input controller from outside ends
 * the drain promptly because the SDK query finishes once its input does.
 */
async function drainParkedSdkQuery(args: {
  handle: ParkedQuery;
  parkIdleMs: number;
  hardCapMs: number;
  flushDebounceMs?: number;
  flushMaxHoldMs?: number;
  onEvent: (event: AgentProviderEvent) => void;
  onActivityChanged?: (active: boolean) => void;
  sessionId: string;
  jobId: string;
}): Promise<void> {
  const startedAt = Date.now();
  let effectiveHardCapMs = args.hardCapMs;
  const sessionLabel = args.handle.providerSessionId ?? args.sessionId;
  const flushDebounceMs = args.flushDebounceMs ?? PARK_FLUSH_DEBOUNCE_MS;
  const flushMaxHoldMs = args.flushMaxHoldMs ?? PARK_FLUSH_MAX_HOLD_MS;
  args.handle.beginDrain();
  bridgeLog("park", `keeping finished sdk query alive session=${sessionLabel} idleMs=${args.parkIdleMs}`);
  let active = false;
  // A park that is merely waiting is idle. A park that is mid-injected-turn is
  // Claude working, and the bridge has to know the difference: the lane must look
  // busy then, or the user's next message is dispatched as a new turn and ends up
  // steering running work he never agreed to steer.
  const setActive = (next: boolean): void => {
    if (active === next) {
      return;
    }
    active = next;
    args.handle.setActive(next);
    bridgeLog("park", `parked cli ${next ? "busy" : "idle"} session=${sessionLabel}`);
    args.onActivityChanged?.(next);
  };
  try {
    let bufferedText = "";
    let finalAssistantText = "";
    let continuationDeadline: number | undefined;
    let flushDeadline: number | undefined;
    let flushHardDeadline: number | undefined;
    const flushText = (): void => {
      const text = bufferedText.trim();
      bufferedText = "";
      flushDeadline = undefined;
      flushHardDeadline = undefined;
      if (text) {
        args.onEvent({
          type: "assistant_text_delta",
          sessionId: args.sessionId,
          jobId: args.jobId,
          text,
        });
      }
    };
    while (true) {
      const now = Date.now();
      // A park still owed a background task result is waiting, not idle. That
      // notification routinely lands well after the idle timeout, and closing the
      // query first is exactly how a finished test run vanishes instead of being
      // reported. Such a park runs on the pending cap alone.
      const awaitingTask = args.handle.pendingTaskCount > 0;
      if (awaitingTask) effectiveHardCapMs = Math.max(effectiveHardCapMs, PARK_PENDING_TASK_CAP_MS);
      // Completing a long task must not shrink its deadline back below its
      // already elapsed age, or the follow-up is discarded before it can run.
      const capRemaining = effectiveHardCapMs - (now - startedAt);
      // Finishing a task removes it from the live snapshot before its follow-up
      // model call emits text. Keep that handoff alive, then keep a running turn
      // alive through quiet model/tool intervals. The hard cap still bounds both.
      const continuationRemaining = Math.max(0, (continuationDeadline ?? 0) - now);
      const idleRemaining = awaitingTask || active
        ? capRemaining
        : Math.min(Math.max(args.parkIdleMs, continuationRemaining), capRemaining);
      if (idleRemaining <= 0) {
        break;
      }
      // Text waiting to be grouped shortens the wait. Timing out on THAT deadline
      // means "send what you have and keep going", not "the park is over", so the
      // two cases must stay distinguishable after the race resolves.
      let waitMs = idleRemaining;
      let waitingForFlush = false;
      // The debounce restarts on every block, so a steady stream could hold text
      // indefinitely. The hard ceiling, armed when the buffer first fills, bounds it.
      const effectiveFlushDeadline = flushDeadline === undefined
        ? flushHardDeadline
        : Math.min(flushDeadline, flushHardDeadline ?? flushDeadline);
      if (effectiveFlushDeadline !== undefined) {
        const flushRemaining = Math.max(0, effectiveFlushDeadline - now);
        if (flushRemaining < idleRemaining) {
          waitMs = flushRemaining;
          waitingForFlush = true;
        }
      }
      const outcome = await waitForParkedMessage(args.handle, waitMs);
      if (outcome.kind === "handover") {
        // The next turn is adopting this query. Flush whatever the CLI said since
        // the last result before letting go, or that text dies with the drain.
        flushText();
        break;
      }
      if (outcome.kind === "timeout") {
        if (waitingForFlush) {
          flushText();
          continue;
        }
        // Park went quiet (or hit its cap). The park is over.
        break;
      }
      if (outcome.result.done) {
        // The query finished: input closed from outside, or the CLI exited.
        break;
      }
      const message = outcome.result.value;
      if (args.handle.trackMessage(message)) {
        continuationDeadline = Date.now() + PARK_TASK_HANDOFF_MS;
      }
      if (message.type === "system" && message.subtype === "init" &&
        continuationDeadline !== undefined && continuationDeadline > Date.now()) {
        // A fresh init after our task's completion starts its injected turn.
        // Unrelated idle metadata must not mark a parked query as working.
        setActive(true);
        continuationDeadline = undefined;
        continue;
      }
      if (message.type === "system" && message.subtype === "session_state_changed") {
        // The SDK's idle state is authoritative. Metadata and ambient task
        // notifications after a result must not invent another running turn.
        setActive(message.state === "running" || message.state === "requires_action");
        if (message.state === "idle") continuationDeadline = undefined;
        continue;
      }
      if (message.type === "assistant") {
        const model = message.message?.model;
        if (!model) {
          continue;
        }
        // The CLI's own notices (spend limit, refusals) arrive as synthetic
        // assistant messages. Inside a park they used to be dropped, so a limit hit
        // looked like Claude simply going quiet. Deliver them; only the boilerplate
        // reply to an injected rescue prompt stays out.
        const synthetic = model === "<synthetic>";
        if (!synthetic && (message.message?.content ?? []).some((block) =>
          block.type === "text" || block.type === "thinking" || block.type === "tool_use",
        )) {
          setActive(true);
        }
        for (const block of message.message?.content ?? []) {
          const blockType = typeof block.type === "string" ? block.type : "";
          if (synthetic && (blockType !== "text" || typeof block.text !== "string" || SYNTHETIC_BOILERPLATE.has(block.text.trim()))) {
            continue;
          }
          if (blockType === "text" && typeof block.text === "string" && block.text.trim()) {
            bufferedText += `${bufferedText ? "\n\n" : ""}${block.text.trim()}`;
            finalAssistantText += `${finalAssistantText ? "\n\n" : ""}${block.text.trim()}`;
            flushDeadline = Date.now() + flushDebounceMs;
            flushHardDeadline = flushHardDeadline ?? Date.now() + flushMaxHoldMs;
          } else if (blockType === "tool_use") {
            flushText();
            finalAssistantText = "";
            args.onEvent({
              type: "tool_started",
              sessionId: args.sessionId,
              jobId: args.jobId,
              toolName: typeof block.name === "string" && block.name ? block.name : "tool",
              text: summarizeSdkToolInput(block.input),
            });
          }
        }
        continue;
      }
      if (message.type === "user") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "tool_result") {
            args.onEvent({
              type: block.is_error === true ? "tool_failed" : "tool_completed",
              sessionId: args.sessionId,
              jobId: args.jobId,
              toolName: "tool",
            });
          }
        }
        continue;
      }
      if (message.type === "result") {
        continuationDeadline = undefined;
        if (message.subtype !== "success") {
          const detail = message.result?.trim() || describeSdkErrors(message.errors) || message.subtype || "unknown error";
          bridgeLog("park", `parked sdk turn ended: ${detail} session=${sessionLabel}`);
          // The user must hear this, not just the log: a park dying on a spend
          // limit or API error otherwise looks like Claude losing its track.
          flushText();
          setActive(false);
          args.onEvent({ type: "error", sessionId: args.sessionId, jobId: args.jobId, message: detail });
          break;
        }
        // Debounced blocks are commentary, not completed turns. Always publish
        // the actual result separately, even if its text was already flushed.
        // This lets an unselected session stay quiet until it really finishes.
        const resultText = (message.result ?? "").trim() || finalAssistantText.trim();
        if (resultText && bufferedText.trimEnd().endsWith(resultText)) {
          bufferedText = bufferedText.trimEnd().slice(0, -resultText.length).trim();
        }
        flushText();
        setActive(false);
        if (resultText) {
          args.onEvent({
            type: "assistant_message_complete", sessionId: args.sessionId, jobId: args.jobId, text: resultText,
          });
        }
        finalAssistantText = "";
        continue;
      }
    }
    flushText();
  } catch (error) {
    bridgeLog(
      "park",
      `park drain failed (turn unaffected): ${error instanceof Error ? error.message : String(error)} session=${sessionLabel}`,
    );
  } finally {
    setActive(false);
    // Close BEFORE releasing the drain: a takeOver() waiting on drainFinished then
    // observes the closed handle and opens a fresh query instead of pushing a
    // prompt into a stream nobody is reading.
    if (args.handle.handoverRequested) {
      bridgeLog("park", `park handed to next turn after ${Date.now() - startedAt}ms session=${sessionLabel}`);
    } else {
      args.handle.close();
      bridgeLog("park", `park ended after ${Date.now() - startedAt}ms session=${sessionLabel}`);
    }
    args.handle.endDrain();
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
  const parkIdleMs = Math.max(0, options.parkIdleMs ?? 0);
  const parkEnabled = parkIdleMs > 0 && Boolean(options.onParkedEvent);
  // Set the moment the turn's answer is accepted; the outer finally then hands
  // the query to the parked drain, which owns closing it and the input controller.
  // Hoisted because the drain must launch on every generator exit (normal return,
  // early consumer return, throw) or the query and its CLI process would leak.
  let parked = false;
  let activeQuery: ParkedQuery | undefined;
  // /stop must reach the query that is actually live. An adopted park was opened
  // by an earlier turn under a different AbortController, so the SDK never sees
  // this turn's abort and the CLI kept running. Close the live query ourselves
  // whenever the signal fires; the SDK's own abort handling covers fresh queries
  // too, but this path is the one that works for both.
  const abortSignal = options.abortController?.signal;
  const onAbort = (): void => {
    bridgeLog("abort", `closing live sdk query session=${activeProviderSessionId ?? sessionId}`);
    activeQuery?.close();
    inputController?.close();
  };
  if (abortSignal?.aborted) {
    onAbort();
  } else {
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  }
  let adoptedQuery = inputController ? options.adoptedQuery : undefined;
  // Set when an adopted query died before answering: attempt 1 must then re-send
  // the user's own prompt to a fresh CLI, not the "you produced no response" nudge,
  // because from the user's point of view the prompt never ran at all.
  let replayOriginalPrompt = false;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retryPrompt = attempt === 0 || replayOriginalPrompt
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
      // Every attempt gets the live-input iterable, not just the first: a retry is
      // still the same user-visible turn and must stay steerable.
      // Adopting a park makes this prompt a priority-now steer into a query that is
      // already running. That reuses the steer accounting below verbatim: the SDK
      // reports the interrupted work as an empty successful result, deliveredCount
      // moves, and text produced before the push is discarded as belonging to the
      // interrupted response rather than to this answer.
      let query: ParkedQuery | undefined;
      let adopting = false;
      if (adoptedQuery && inputController) {
        try {
          inputController.push(retryPrompt, "now");
          query = adoptedQuery;
          adopting = true;
          bridgeLog(
            "park",
            `steered new prompt into parked query session=${adoptedQuery.providerSessionId ?? sessionId}`,
          );
        } catch (error) {
          bridgeLog(
            "park",
            `could not steer into parked query, opening a fresh one: ${error instanceof Error ? error.message : String(error)}`,
          );
          adoptedQuery.close();
          query = undefined;
        }
        adoptedQuery = undefined;
      }
      if (adopting && query && query.pendingTaskCount > 0) {
        // The park only stayed alive because a background task has not reported
        // back yet. The prompt was steered into it silently; say so, or the user
        // cannot tell a steer into live work from a fresh turn.
        bridgeLog(
          "park",
          `adopted park still awaits ${query.pendingTaskCount} background task(s) session=${activeProviderSessionId ?? sessionId}`,
        );
        yield {
          type: "status_message",
          sessionId,
          jobId,
          text: "Your message went into the live session, which is still waiting on a background task.",
          priority: true,
        };
      }
      if (!query) {
        inputController?.reopen();
        const sdkPrompt = inputController
          ? initialPromptAndLiveInput(retryPrompt, inputController)
          : retryPrompt;
        query = new ParkedQuery(
          queryFn({ prompt: sdkPrompt, options: sdkOptions }),
          inputController,
          activeProviderSessionId,
        );
      }
      activeQuery = query;
      replayOriginalPrompt = false;
      let sawResult = false;
      let sawTerminalResult = false;
      let finalAssistantText = "";
      let finalAssistantTextSteerCount = inputController?.deliveredCount ?? 0;
      let handledSteerCount = 0;
      let retryEmptySuccess = false;
      // Real (non-synthetic) assistant output seen in THIS attempt. Until it flips,
      // any result the CLI emits belongs to a turn it injected ahead of ours.
      let sawAssistantActivity = false;
      let ignoredInjectedResults = 0;

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
          // Launches happen inside the live turn; the park needs to know about them
          // before it starts counting down, or it closes on work already in flight.
          query?.trackMessage(message);
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

          if (
            message.type === "system" &&
            isPriorityClaudeSystemNoticeSubtype(message.subtype)
          ) {
            const noticeText = extractSystemNoticeText(message as unknown as Record<string, unknown>);
            if (noticeText) {
              yield {
                type: "status_message",
                sessionId,
                jobId,
                text: noticeText,
                priority: true,
              };
            }
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
            if (model && model !== "<synthetic>") {
              sawAssistantActivity = true;
            }
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
            // When the live tracker is empty (Z.AI zeroes assistant usage),
            // recover the real last-call size from the session transcript
            // instead of ever falling back to the totals.
            let contextTokens = lastContextTokens;
            if (
              contextTokens === undefined &&
              activeProviderSessionId &&
              inputTokens + cachedInputTokens > 0
            ) {
              const recovered = await recoverSdkContextFromTranscript(activeProviderSessionId);
              if (recovered !== undefined) {
                contextTokens = recovered;
                lastContextTokens = recovered;
                bridgeLog(
                  "usage",
                  `sdk live context recovered from transcript session=${activeProviderSessionId} context=${recovered}`,
                );
              }
            }
            yield {
              type: "usage_updated",
              sessionId,
              jobId,
              inputTokens,
              cachedInputTokens,
              outputTokens,
              contextTokens,
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
                if (parkEnabled) {
                  // Before the yield: if the consumer walks away at this yield the
                  // outer finally must still find the query parked, not leak it.
                  parked = true;
                }
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
              } else if (!sawAssistantActivity && ignoredInjectedResults < MAX_IGNORED_INJECTED_RESULTS) {
                // Claude Code drains its own pending queue before our prompt runs, and
                // each injected item (background <task-notification>s, the resume
                // rescue prompt) completes as its own successful-but-silent turn. Those
                // results are not ours: tearing the query down here killed the user's
                // prompt mid-flight, which is what left orphaned tool calls and forced
                // a from-scratch retry. Keep reading; the real result still follows.
                ignoredInjectedResults += 1;
                bridgeLog(
                  "sdk",
                  `ignored empty success before any assistant output session=${activeProviderSessionId ?? sessionId}`,
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
        // A parked query outlives this generator: the drain closes it (and the
        // input controller) when the CLI goes quiet, the cap hits, or the next
        // turn adopts it.
        if (!parked) {
          activeQuery?.close();
        }
      }

      if (abortSignal?.aborted) {
        // The stream ended because /stop closed it. Neither retry nor replay:
        // the user asked for silence, not a second run of the same prompt.
        yield { type: "error", sessionId, jobId, message: "Claude turn aborted." };
        return;
      }
      if (!sawResult) {
        if (adopting && attempt === 0) {
          // The park looked alive but its CLI was already gone, so the steer went
          // nowhere. The user's prompt has not run: re-send it to a fresh query
          // rather than reporting a crash for something that never started.
          replayOriginalPrompt = true;
          retryEmptySuccess = true;
          bridgeLog(
            "park",
            `adopted query produced no result; retrying with a fresh query session=${activeProviderSessionId ?? sessionId}`,
          );
          continue;
        }
        yield {
          type: "error",
          sessionId,
          jobId,
          message: "Claude SDK stream ended without a result message (aborted or crashed).",
        };
        return;
      }
      if (!sawTerminalResult) {
        // The stream ended on a result we deliberately did not accept: either the empty
        // result that interrupted a live steer, or an injected turn's silent result.
        // Retry through resume instead of passing that off as a completed turn.
        const cause = handledSteerCount > 0
          ? "steered continuation"
          : "assistant text";
        if (attempt === 0) {
          retryEmptySuccess = true;
          bridgeLog(
            "retry",
            `sdk stream ended before ${cause}; retrying session=${activeProviderSessionId ?? sessionId}`,
          );
        } else {
          yield {
            type: "error",
            sessionId,
            jobId,
            message: handledSteerCount > 0
              ? "Claude SDK ended before producing a response to the live steer."
              : "Claude SDK returned a successful result without assistant text twice.",
          };
          return;
        }
      }
      if (!retryEmptySuccess) {
        return;
      }
    }
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    if (parked && activeQuery) {
      // Single launch site for the parked drain: every exit path funnels here,
      // so the query can never be parked without a reader and never leaked.
      const handle = activeQuery;
      handle.providerSessionId = activeProviderSessionId ?? handle.providerSessionId;
      options.onParkStateChanged?.(true, handle);
      void drainParkedSdkQuery({
        handle,
        parkIdleMs,
        hardCapMs: options.parkHardCapMs ?? PARK_HARD_CAP_MS,
        flushDebounceMs: options.parkFlushDebounceMs,
        flushMaxHoldMs: options.parkFlushMaxHoldMs,
        onEvent: (event) => options.onParkedEvent?.(event),
        onActivityChanged: (active) => options.onParkActivityChanged?.(active),
        sessionId,
        jobId,
      }).finally(() => {
        options.onParkStateChanged?.(false, handle);
      });
    } else {
      inputController?.close();
    }
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

export interface ClaudeModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
}

/**
 * Asks Claude Code which models it offers and which exact model each alias maps to
 * right now ("opus" -> "claude-opus-5-5"). No prompt is sent, so no tokens are spent.
 */
export async function probeClaudeModels(options: {
  claudeBin?: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<ClaudeModelInfo[]> {
  const queryFn = await loadSdkQuery();
  let releasePrompt: () => void = () => undefined;
  const promptHeld = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  async function* idlePrompt(): AsyncIterable<SdkUserMessageLike> {
    await promptHeld;
  }
  const abortController = new AbortController();
  const query = queryFn({
    prompt: idlePrompt(),
    options: {
      ...buildSdkQueryOptions({
        cwd: options.cwd,
        claudeBin: options.claudeBin,
        permissionMode: "default",
        abortController,
      }),
    },
  }) as unknown as { supportedModels(): Promise<ClaudeModelInfo[]> };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      query.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude model probe timed out.")), options.timeoutMs ?? 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    releasePrompt();
    abortController.abort();
  }
}

async function loadSdkQuery(): Promise<NonNullable<ClaudeSdkTurnOptions["queryFn"]>> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query as unknown as NonNullable<ClaudeSdkTurnOptions["queryFn"]>;
}

function buildSdkQueryOptions(options: {
  cwd: string;
  claudeBin?: string;
  model?: string;
  permissionMode: ClaudePermissionMode;
  resume?: string;
  forkSession?: boolean;
  abortController?: AbortController;
  autoCompactWindow?: number;
}): Record<string, unknown> {
  return {
    cwd: options.cwd,
    model: options.model,
    permissionMode: options.permissionMode,
    ...(options.claudeBin ? { pathToClaudeCodeExecutable: options.claudeBin } : {}),
    // Behave like the user's interactive sessions: Claude Code system prompt,
    // user + project settings, CLAUDE.md, and skills.
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project"],
    // The child must never start the user-scoped Telegram plugin's poller. It
    // would compete with this bridge for the same bot token.
    strictMcpConfig: true,
    env: scrubbedEnv(options.autoCompactWindow, options.model, options.cwd),
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.forkSession ? { forkSession: true } : {}),
    ...(options.abortController ? { abortController: options.abortController } : {}),
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

function scrubbedEnv(
  autoCompactWindow?: number,
  model?: string,
  workspace?: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  // Updates belong to TeleCode's dependency rollout, never an SDK child process.
  env.DISABLE_AUTOUPDATER = "1";
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
  // The SDK backend takes no --settings file, so a vendor's endpoint, model pins and
  // auth all go into the child environment. Applied after the scrub above, otherwise
  // the CLAUDE_CODE_* pins would be deleted again.
  const vendorHit = model ? resolveVendorModel(model) : null;
  if (vendorHit) {
    Object.assign(
      env,
      buildVendorClaudeSettingsEnv(vendorHit),
      buildVendorClaudeEnv(vendorHit, { workspace }),
    );
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
