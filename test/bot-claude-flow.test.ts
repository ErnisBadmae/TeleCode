import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { TeleCodeConfig } from "../src/config.js";
import { SessionRegistry } from "../src/session-registry.js";

const mockClaude = vi.hoisted(() => {
  const prompts: string[] = [];
  const rawPrompts: string[] = [];
  const promptSessionIds: string[] = [];
  const steers: string[] = [];
  const createSession = vi.fn();
  const resumeSession = vi.fn();
  const getSessionInfo = vi.fn();
  const compact = vi.fn();
  const dispose = vi.fn();
  let createCount = 0;
  let activeModel = "sonnet";
  let activeBackend = "pty";
  let activeProviderSessionId = "provider-session-1";
  let promptGate: Promise<void> | undefined;
  let releasePromptGate: (() => void) | undefined;
  let nextEvents: Array<Record<string, unknown>> | undefined;
  const queuedReplies: string[] = [];
  let failNextPromptDelivery = false;
  let artifactFileName: string | undefined;

  return {
    prompts,
    rawPrompts,
    promptSessionIds,
    steers,
    setArtifactFileName: (name: string | undefined) => {
      artifactFileName = name;
    },
    getArtifactFileName: () => artifactFileName,
    createSession,
    resumeSession,
    getSessionInfo,
    compact,
    dispose,
    nextCreateCount: () => {
      createCount += 1;
      return createCount;
    },
    setActiveModel: (model: string) => {
      activeModel = model;
    },
    getActiveModel: () => activeModel,
    setActiveBackend: (backend: string) => {
      activeBackend = backend;
    },
    getActiveBackend: () => activeBackend,
    setActiveProviderSessionId: (sessionId: string) => {
      activeProviderSessionId = sessionId;
    },
    getActiveProviderSessionId: () => activeProviderSessionId,
    setNextEvents: (events: Array<Record<string, unknown>>) => {
      nextEvents = events;
    },
    takeNextEvents: () => {
      const events = nextEvents;
      nextEvents = undefined;
      return events;
    },
    queueReplies: (...replies: string[]) => {
      queuedReplies.push(...replies);
    },
    takeNextReply: () => (
      queuedReplies.length > 0
        ? { value: queuedReplies.shift()! }
        : undefined
    ),
    failNextDelivery: () => {
      failNextPromptDelivery = true;
    },
    takeDeliveryFailure: () => {
      const fail = failNextPromptDelivery;
      failNextPromptDelivery = false;
      return fail;
    },
    blockNextPrompt: () => {
      promptGate = new Promise<void>((resolve) => {
        releasePromptGate = resolve;
      });
    },
    releaseBlockedPrompt: () => {
      releasePromptGate?.();
      releasePromptGate = undefined;
    },
    takePromptGate: () => {
      const gate = promptGate;
      promptGate = undefined;
      return gate;
    },
    reset: () => {
      prompts.length = 0;
      rawPrompts.length = 0;
      promptSessionIds.length = 0;
      steers.length = 0;
      createCount = 0;
      activeModel = "sonnet";
      activeBackend = "pty";
      activeProviderSessionId = "provider-session-1";
      releasePromptGate?.();
      promptGate = undefined;
      releasePromptGate = undefined;
      nextEvents = undefined;
      queuedReplies.length = 0;
      failNextPromptDelivery = false;
      artifactFileName = undefined;
      createSession.mockReset();
      resumeSession.mockReset();
      getSessionInfo.mockReset();
      compact.mockReset();
      dispose.mockReset();
    },
  };
});

vi.mock("../src/providers/claude-adapter.js", async () => {
  const { stripOutputFilesInstruction, extractOutputFilesDir } = await import("../src/attachments.js");
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  class MockPromptNotDeliveredError extends Error {
    constructor(
      readonly promptText: string,
      message: string,
    ) {
      super(message);
      this.name = "PromptNotDeliveredError";
    }
  }
  return {
  PromptNotDeliveredError: MockPromptNotDeliveredError,
  ClaudeProviderAdapter: class {
    readonly capabilities = {
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

    async createSession(options: { workspace?: string; displayName?: string; metadata?: Record<string, unknown> }) {
      const createCount = mockClaude.nextCreateCount();
      if (typeof options.metadata?.model === "string") {
        mockClaude.setActiveModel(options.metadata.model);
      }
      if (typeof options.metadata?.backend === "string") {
        mockClaude.setActiveBackend(options.metadata.backend);
      }
      const descriptor = {
        id: `claude-provider-${createCount}`,
        provider: "claude",
        workspace: options.workspace ?? "C:\\workspace",
        displayName: options.displayName,
        providerSessionId: `provider-session-${createCount}`,
        status: "idle",
        capabilities: this.capabilities,
        createdAt: 1000,
        updatedAt: 1000,
        metadata: options.metadata,
      };
      mockClaude.setActiveProviderSessionId(descriptor.providerSessionId);
      mockClaude.createSession(options);
      return descriptor;
    }

    async resumeSession(session: unknown) {
      const backend = (session as { metadata?: { backend?: string } }).metadata?.backend;
      const providerSessionId = (session as { providerSessionId?: string }).providerSessionId;
      if (backend) {
        mockClaude.setActiveBackend(backend);
      }
      if (providerSessionId) {
        mockClaude.setActiveProviderSessionId(providerSessionId);
      }
      await mockClaude.resumeSession(session);
      return session;
    }

    getBackend() {
      return mockClaude.getActiveBackend();
    }

    async setBackend(_sessionId: string, backend: string) {
      mockClaude.setActiveBackend(backend);
    }

    async forkSession(sourceSessionId: string, displayName?: string) {
      const createCount = mockClaude.nextCreateCount();
      const descriptor = {
        id: `claude-fork-${createCount}`,
        provider: "claude",
        workspace: "C:\\workspace",
        displayName: displayName ?? "Mock Claude (fork)",
        providerSessionId: `forked-session-${createCount}`,
        status: "idle",
        capabilities: this.capabilities,
        createdAt: 2000,
        updatedAt: 2000,
        metadata: { model: mockClaude.getActiveModel(), backend: "pty" },
      };
      mockClaude.setActiveProviderSessionId(descriptor.providerSessionId);
      return descriptor;
    }

    async getSessionInfo(sessionId: string) {
      const descriptor = {
        id: sessionId,
        provider: "claude",
        workspace: "C:\\workspace",
        displayName: "Mock Claude",
        providerSessionId: mockClaude.getActiveProviderSessionId(),
        status: "idle",
        capabilities: this.capabilities,
        createdAt: 1000,
        updatedAt: 2000,
        metadata: {
          model: mockClaude.getActiveModel(),
          permissionMode: "acceptEdits",
          backend: mockClaude.getActiveBackend(),
        },
      };
      mockClaude.getSessionInfo();
      return descriptor;
    }

    async *sendPrompt(options: { sessionId: string; jobId: string; input: { text?: string } }) {
      const rawText = options.input.text ?? "";
      // The bridge appends a per-turn outbox instruction to normal prompts; tests
      // assert on the user's text, so strip it here and honor it when a test asks
      // for an artifact to be produced.
      const text = stripOutputFilesInstruction(rawText);
      mockClaude.prompts.push(text);
      mockClaude.rawPrompts.push(rawText);
      mockClaude.promptSessionIds.push(options.sessionId);
      if (mockClaude.takeDeliveryFailure()) {
        throw new MockPromptNotDeliveredError(
          rawText,
          "Claude's input box never echoed the prompt text; refusing to press Enter.",
        );
      }
      const artifactFileName = mockClaude.getArtifactFileName();
      const outDir = extractOutputFilesDir(rawText);
      if (artifactFileName && outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(nodePath.join(outDir, artifactFileName), "mock artifact content");
      }
      const modelMatch = text.match(/^\/model\s+(.+)$/u);
      if (modelMatch?.[1]) {
        mockClaude.setActiveModel(modelMatch[1].trim());
      }
      yield {
        type: "session_status_changed",
        sessionId: options.sessionId,
        status: "running",
      };
      const gate = mockClaude.takePromptGate();
      if (gate) {
        await gate;
      }
      const customEvents = mockClaude.takeNextEvents();
      if (customEvents) {
        for (const event of customEvents) {
          const delay = (event as { __delayMs?: number }).__delayMs;
          if (typeof delay === "number") {
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          yield event;
        }
        return;
      }
      const queuedReply = mockClaude.takeNextReply();
      const reply = queuedReply?.value ?? `mock reply to ${text}`;
      yield {
        type: "assistant_text_delta",
        sessionId: options.sessionId,
        jobId: options.jobId,
        text: reply,
      };
      yield {
        type: "usage_updated",
        sessionId: options.sessionId,
        jobId: options.jobId,
        inputTokens: 1,
        cachedInputTokens: 2,
        outputTokens: 3,
      };
      yield {
        type: "assistant_message_complete",
        sessionId: options.sessionId,
        jobId: options.jobId,
        text: reply,
      };
    }

    async streamInput(_sessionId: string, input: { text?: string }) {
      mockClaude.steers.push(input.text ?? "");
    }

    async compact(sessionId: string, instructions?: string) {
      mockClaude.compact(sessionId, instructions);
    }

    async getUsage() {
      return { contextTokens: 3 };
    }

    async getUsageReport() {
      return "Mock Claude usage panel";
    }

    async getContext() {
      return { usedTokens: 3, contextWindow: 200000, autoCompactWindow: 200000 };
    }

    async dispose(sessionId?: string) {
      if (sessionId === undefined) {
        mockClaude.dispose();
        return;
      }
      mockClaude.dispose(sessionId);
    }
  },
  };
});

vi.mock("../src/codex-backend.js", () => ({
  createCodexSession: vi.fn(() => {
    throw new Error("Codex session should not be created in Claude bot flow tests");
  }),
}));

vi.mock("../src/startup-safety.js", () => ({
  findRunningClaudeTelegramPluginProcesses: vi.fn(async () => []),
}));

import { createBot } from "../src/bot.js";

describe("Claude bot flow", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecode-bot-claude-"));
    mockClaude.reset();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows can briefly keep handles open after a failed test.
    }
    vi.restoreAllMocks();
  });

  it("routes normal text to Claude after /claude switches the context", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "hello"));

    await waitFor(() => mockClaude.prompts.includes("hello"));

    expect(mockClaude.createSession).toHaveBeenCalledTimes(1);
    expect(mockClaude.prompts).toEqual(["hello"]);
    expect(sent.map((entry) => entry.text)).toContain("Claude Code selected for this Telegram context. The next normal message will start or resume Claude.");
    expect(sent.map((entry) => entry.text)).toContain("mock reply to hello");
  });

  it("repairs a stale Claude session index from authoritative provider state on startup", async () => {
    const stateDir = path.join(tempDir, ".telecode");
    const providerStateDir = path.join(stateDir, "provider-state");
    mkdirSync(providerStateDir, { recursive: true });
    writeFileSync(path.join(providerStateDir, "claude.json"), `${JSON.stringify({
      version: 1,
      sessions: [{
        telegramContextKey: "123",
        sessionId: "live-session",
        workspace: tempDir,
        displayName: "Current Claude",
        model: "claude-fable-5",
        permissionMode: "acceptEdits",
        transcriptPath: "C:\\transcripts\\live-session.jsonl",
        createdAt: 100,
        lastUsedAt: 300,
      }],
    }, null, 2)}\n`, "utf8");
    writeFileSync(path.join(providerStateDir, "claude-backend.json"), `${JSON.stringify({
      version: 1,
      backends: { "123": "sdk" },
    }, null, 2)}\n`, "utf8");
    writeFileSync(path.join(stateDir, "agent-sessions.json"), `${JSON.stringify({
      version: 1,
      lanes: [{
        laneKey: "123",
        defaultProvider: "codex",
        sessionIds: ["claude-current"],
        deliveryMode: "buffer-background",
        notifyOnBackgroundCompletion: true,
        createdAt: 100,
        updatedAt: 200,
      }],
      sessions: [{
        id: "claude-current",
        laneKey: "123",
        provider: "claude",
        workspace: tempDir,
        displayName: "Current Claude",
        providerSessionId: "stale-canary",
        status: "completed",
        createdAt: 100,
        updatedAt: 200,
        metadata: { model: "claude-opus-4-8", transcriptPath: "C:\\transcripts\\stale-canary.jsonl" },
      }],
      jobs: [],
    }, null, 2)}\n`, "utf8");

    await createTestBot(tempDir);

    const repaired = JSON.parse(readFileSync(path.join(stateDir, "agent-sessions.json"), "utf8")) as {
      sessions: Array<{ providerSessionId?: string; metadata?: Record<string, unknown> }>;
    };
    expect(repaired.sessions[0]?.providerSessionId).toBe("live-session");
    expect(repaired.sessions[0]?.metadata).toMatchObject({
      model: "claude-fable-5",
      transcriptPath: "C:\\transcripts\\live-session.jsonl",
      backend: "sdk",
    });
  });

  it("treats /claude with trailing text as an inline Claude prompt", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude say CANARY_OK only"));

    await waitFor(() => mockClaude.prompts.includes("say CANARY_OK only"));

    expect(mockClaude.createSession).toHaveBeenCalledTimes(1);
    expect(mockClaude.prompts).toEqual(["say CANARY_OK only"]);
    expect(sent.map((entry) => entry.text)).toContain("mock reply to say CANARY_OK only");
  });

  it("honors a persisted SDK backend when creating the Claude runtime", async () => {
    const providerStateDir = path.join(tempDir, ".telecode", "provider-state");
    mkdirSync(providerStateDir, { recursive: true });
    writeFileSync(path.join(providerStateDir, "claude-backend.json"), `${JSON.stringify({
      version: 1,
      backends: { "123": "sdk" },
    }, null, 2)}\n`, "utf8");
    const { bot } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello through sdk"));
    await waitFor(() => mockClaude.prompts.includes("hello through sdk"));

    expect(mockClaude.createSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ backend: "sdk" }),
    }));
    expect(mockClaude.getActiveBackend()).toBe("sdk");
  });

  it("switches a broken PTY delivery to the SDK engine before retrying", async () => {
    mockClaude.failNextDelivery();
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude preserve this exact prompt"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("switched this chat to the SDK engine")));

    expect(mockClaude.getActiveBackend()).toBe("sdk");
    expect(mockClaude.prompts).toEqual(["preserve this exact prompt"]);
    const backendState = JSON.parse(readFileSync(
      path.join(tempDir, ".telecode", "provider-state", "claude-backend.json"),
      "utf8",
    )) as { backends: Record<string, string> };
    expect(backendState.backends["123"]).toBe("sdk");
  });

  it("delivers the Claude final answer even if Claude is backgrounded before completion", async () => {
    const { bot, sent, registry } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();

    await bot.handleUpdate(textUpdate(1, "/claude long answer"));
    await waitFor(() => mockClaude.prompts.includes("long answer"));
    registry.setActiveProvider("123", "codex");
    mockClaude.releaseBlockedPrompt();

    await waitFor(() => sent.some((entry) => entry.text?.includes("Claude Code finished in background")));

    expect(sent.map((entry) => entry.text)).toContain(
      "Claude Code finished in background: long answer\n\nmock reply to long answer",
    );
  });

  it("keeps background commentary quiet, delivers the full final, and replays commentary only on command", async () => {
    const { bot, sent, registry } = await createTestBot(tempDir);
    const finalText = `FULL_FINAL ${"x".repeat(900)}`;
    mockClaude.blockNextPrompt();
    mockClaude.setNextEvents([
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "COMMENTARY_ONE" },
      { type: "tool_failed", sessionId: "claude-provider-1", jobId: "job-1", toolName: "Read", text: "RECOVERED_FAILURE" },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "COMMENTARY_TWO" },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: finalText },
      { type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "job-1", text: finalText },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude background buffers"));
    await waitFor(() => mockClaude.prompts.includes("background buffers"));
    registry.setActiveProvider("123", "codex");
    mockClaude.releaseBlockedPrompt();

    await waitFor(() => sent.some((entry) => entry.text?.includes("FULL_FINAL")));
    const beforeReplay = sent.map((entry) => entry.text ?? "");
    expect(beforeReplay.some((text) => text.includes("Claude Code finished in background: background buffers"))).toBe(true);
    expect(beforeReplay.join("\n")).toContain(finalText);
    expect(beforeReplay.join("\n")).not.toContain("COMMENTARY_ONE");
    expect(beforeReplay.join("\n")).not.toContain("COMMENTARY_TWO");
    expect(beforeReplay.join("\n")).not.toContain("RECOVERED_FAILURE");

    await bot.handleUpdate(textUpdate(2, "/claude"));
    await bot.handleUpdate(textUpdate(3, "/replay all"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("COMMENTARY_ONE")));

    const replay = sent.map((entry) => entry.text ?? "").filter((text) => text.includes("Buffered Claude output"));
    expect(replay.join("\n")).toContain("COMMENTARY_ONE");
    expect(replay.join("\n")).toContain("COMMENTARY_TWO");
    expect(replay.join("\n")).not.toContain("FULL_FINAL");
    expect(replay.join("\n")).not.toContain("RECOVERED_FAILURE");
  });

  it("suppresses recoverable Claude tool failures at the default summary verbosity", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setNextEvents([
      { type: "tool_failed", sessionId: "claude-provider-1", jobId: "job-1", toolName: "Read", text: "temporary miss" },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "RECOVERED_FINAL" },
      { type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "job-1", text: "RECOVERED_FINAL" },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude recover"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("RECOVERED_FINAL")));

    expect(sent.map((entry) => entry.text ?? "").join("\n")).not.toContain("temporary miss");
  });

  it("shows Claude tool failures when errors-only verbosity is explicitly selected", async () => {
    const { bot, sent } = await createTestBot(tempDir, { toolVerbosity: "errors-only" });
    mockClaude.setNextEvents([
      { type: "tool_failed", sessionId: "claude-provider-1", jobId: "job-1", toolName: "Read", text: "explicit failure" },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "FINAL_AFTER_FAILURE" },
      { type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "job-1", text: "FINAL_AFTER_FAILURE" },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude show failures"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("FINAL_AFTER_FAILURE")));

    expect(sent.map((entry) => entry.text)).toContain("Claude tool failed: Read: explicit failure");
  });

  it("delivers a timeout completion warning after prior Claude progress was flushed", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setNextEvents([
      {
        type: "assistant_text_delta",
        sessionId: "claude-provider-1",
        jobId: "job-1",
        text: "Working on it.",
      },
      {
        type: "tool_started",
        sessionId: "claude-provider-1",
        jobId: "job-1",
        toolName: "PowerShell",
        text: "ytclip --selftest",
      },
      {
        type: "assistant_message_complete",
        sessionId: "claude-provider-1",
        jobId: "job-1",
        text: "Working on it.\n\nClaude stopped before finishing the turn: Claude active tool idle timeout after 1800 seconds. Screen tail: switched to Opus 4.8",
      },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude long tool"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Claude active tool idle timeout")));

    expect(sent.map((entry) => entry.text)).toContain("Working on it.");
    expect(sent.map((entry) => entry.text)).toContain(
      "Claude stopped before finishing the turn: Claude active tool idle timeout after 1800 seconds. Screen tail: switched to Opus 4.8",
    );
  });

  it("sends /steer into the active Claude turn while Claude is already running", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();

    await bot.handleUpdate(textUpdate(1, "/claude first task"));
    await waitFor(() => mockClaude.prompts.includes("first task"));
    await bot.handleUpdate(textUpdate(2, "/steer add this detail"));

    await waitFor(() => mockClaude.steers.includes("add this detail"));
    expect(sent.map((entry) => entry.text)).toContain(
      "Steer sent to the active Claude turn.",
    );

    mockClaude.releaseBlockedPrompt();

    expect(mockClaude.prompts).toEqual(["first task"]);
    expect(mockClaude.steers).toEqual(["add this detail"]);
  });

  it("asks y/n for /steer with no active turn and starts the turn on y", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "/steer investigate the login bug"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("No Claude turn is running")));
    expect(mockClaude.prompts).toEqual([]);

    await bot.handleUpdate(textUpdate(3, "y"));
    await waitFor(() => mockClaude.prompts.includes("investigate the login bug"));
    expect(mockClaude.prompts).toEqual(["investigate the login bug"]);
  });

  it("discards an idle steer on n and passes a bare y through when nothing is pending", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "/steer try the other approach"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("No Claude turn is running")));
    await bot.handleUpdate(textUpdate(3, "n"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Discarded the steer text")));
    expect(mockClaude.prompts).toEqual([]);

    // No pending question anymore: a literal y is a normal prompt.
    await bot.handleUpdate(textUpdate(4, "y"));
    await waitFor(() => mockClaude.prompts.includes("y"));
    expect(mockClaude.prompts).toEqual(["y"]);
  });

  it("serializes same-tick Claude messages and runs the queued prompts FIFO", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();

    await bot.handleUpdate(textUpdate(1, "/claude"));
    const first = bot.handleUpdate(textUpdate(2, "first task"));
    const second = bot.handleUpdate(textUpdate(3, "second task"));
    const third = bot.handleUpdate(textUpdate(4, "third task"));

    await waitFor(() => mockClaude.prompts.includes("first task"));
    expect(mockClaude.prompts).toEqual(["first task"]);
    await Promise.all([first, second, third]);

    expect(sent.map((entry) => entry.text)).toContain(
      "Claude is still working. I queued this Claude message and will run it next. Use /stop if the current task is stuck.",
    );
    expect(sent.map((entry) => entry.text)).toContain(
      "Claude is still working. I queued this Claude message as item #2. Use /stop if the current task is stuck.",
    );

    mockClaude.releaseBlockedPrompt();
    await waitFor(() => mockClaude.prompts.length === 3);

    expect(mockClaude.prompts).toEqual(["first task", "second task", "third task"]);
  });

  it("rejects embedded slash commands before they are pasted into Claude", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "please answer this\n/exit"));

    await waitFor(() => sent.some((entry) => entry.text?.includes("contains /exit on its own line")));

    expect(mockClaude.prompts).toEqual([]);
    expect(sent.map((entry) => entry.text)).toContain(
      "I did not send this to Claude because it contains /exit on its own line.\nSend the text first, then send the command as a separate Telegram message.",
    );
  });

  it("rejects embedded slash commands separated by carriage returns", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "please answer this\r/exit"));

    await waitFor(() => sent.some((entry) => entry.text?.includes("contains /exit on its own line")));

    expect(mockClaude.prompts).toEqual([]);
  });

  it("does not resume a persisted Claude session with stale permission mode", async () => {
    const staleSessionId = "11111111-1111-4111-8111-111111111111";
    const providerStateDir = path.join(tempDir, ".telecode", "provider-state");
    const transcriptDir = path.join(tempDir, ".claude-config", "projects", "project");
    mkdirSync(providerStateDir, { recursive: true });
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      path.join(providerStateDir, "claude.json"),
      JSON.stringify({
        version: 1,
        sessions: [{
          telegramContextKey: "123",
          sessionId: staleSessionId,
          workspace: tempDir,
          displayName: "Old Claude",
          model: "sonnet",
          permissionMode: "bypassPermissions",
          createdAt: 1,
          lastUsedAt: 2,
        }],
      }),
      "utf8",
    );
    writeFileSync(
      path.join(transcriptDir, `${staleSessionId}.jsonl`),
      `${JSON.stringify({ type: "user", permissionMode: "acceptEdits" })}\n`,
      "utf8",
    );

    const { bot } = await createTestBot(tempDir, {
      claudePermissionMode: "bypassPermissions",
      claudeStrictMcpConfig: false,
    });

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));

    expect(mockClaude.resumeSession).not.toHaveBeenCalled();
    expect(mockClaude.createSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ permissionMode: "bypassPermissions" }),
    }));
  });

  it("disposes the previous integrated Claude runtime when /new claude replaces it", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude first"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("mock reply to first")));
    await waitForAgentSessionsIdle(tempDir);
    await bot.handleUpdate(textUpdate(2, "/new claude"));

    expect(mockClaude.createSession).toHaveBeenCalledTimes(2);
    expect(mockClaude.dispose).toHaveBeenCalledWith("claude-provider-1");
  });

  it("starts /new claude with the requested model", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/new claude opus"));

    expect(mockClaude.createSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ model: "opus" }),
    }));
    expect(sent.map((entry) => entry.text)).toContain(
      "New Claude session selected with model opus. The next normal message will use it.",
    );
  });

  it("creates a fresh Claude session from a generated handoff summary", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude original task"));
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to original task"));
    await waitForAgentSessionsIdle(tempDir);
    await bot.handleUpdate(textUpdate(2, "/backend sdk"));
    mockClaude.queueReplies(
      "HANDOFF SUMMARY WITH CURRENT STATE",
      "Summary loaded.",
    );

    await bot.handleUpdate(textUpdate(3, "/newsummary"));

    expect(mockClaude.createSession).toHaveBeenCalledTimes(2);
    expect(mockClaude.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      workspace: "C:\\workspace",
      displayName: expect.stringContaining("(summary)"),
      metadata: expect.objectContaining({
        model: "sonnet",
        permissionMode: "acceptEdits",
        backend: "sdk",
      }),
    }));
    expect(mockClaude.prompts[1]).toContain(
      "Create a compact handoff summary for continuing this Claude session in a fresh session.",
    );
    expect(mockClaude.prompts[2]).toContain("HANDOFF SUMMARY WITH CURRENT STATE");
    expect(mockClaude.prompts[2]).toContain("Reply only: Summary loaded.");
    expect(mockClaude.rawPrompts[1]).not.toContain("Output files: write any files");
    expect(mockClaude.rawPrompts[2]).not.toContain("Output files: write any files");
    expect(mockClaude.dispose).toHaveBeenCalledWith("claude-provider-1");
    const completionMessage = sent
      .map((entry) => entry.text ?? "")
      .find((text) => text.includes("New Claude session created from summary."));
    expect(completionMessage).toContain("Workspace: <code>C:\\workspace</code>");
    expect(completionMessage).toContain("Model: <code>sonnet</code>");
    expect(completionMessage).toContain("Backend: <code>sdk</code>");
    expect(completionMessage).toContain("HANDOFF SUMMARY WITH CURRENT STATE");
  });

  it("keeps the original Claude session selected if the summary seed fails", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude original task"));
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to original task"));
    await waitForAgentSessionsIdle(tempDir);
    mockClaude.queueReplies("RECOVERABLE HANDOFF", "");

    await bot.handleUpdate(textUpdate(2, "/newsummary"));

    expect(sent.some((entry) =>
      entry.text?.includes("Claude handoff generation returned empty text."),
    )).toBe(true);
    expect(mockClaude.dispose).toHaveBeenCalledWith("claude-provider-2");
    expect(mockClaude.dispose).not.toHaveBeenCalledWith("claude-provider-1");

    await bot.handleUpdate(textUpdate(3, "continue in original"));
    await waitFor(() => mockClaude.prompts.includes("continue in original"));
    expect(mockClaude.promptSessionIds.at(-1)).toBe("claude-provider-1");
  });

  it("changes Claude model inside the active Claude runtime", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude first"));
    await waitFor(() => mockClaude.prompts.includes("first"));
    await bot.handleUpdate(textUpdate(2, "/model opus"));
    await waitFor(() => mockClaude.prompts.includes("/model opus"));

    expect(mockClaude.createSession).toHaveBeenCalledTimes(1);
    expect(mockClaude.dispose).not.toHaveBeenCalledWith("claude-provider-1");
    expect(mockClaude.prompts).toEqual(["first", "/model opus"]);
    expect(sent.map((entry) => entry.text)).toContain("mock reply to /model opus");

    await bot.handleUpdate(textUpdate(3, "/status"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Model: opus")));
    expect(sent.map((entry) => entry.text).find((text) => text?.includes("Claude session:"))).toContain("Model: opus");
  });

  it("delivers every narration block exactly once when complete arrives promptly", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setNextEvents([
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "BLOCK_ONE" },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "BLOCK_TWO" },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "FINAL_BLOCK" },
      { type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "job-1", text: "FINAL_BLOCK" },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude narrate"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("FINAL_BLOCK")));

    const texts = sent.map((entry) => entry.text ?? "");
    for (const marker of ["BLOCK_ONE", "BLOCK_TWO", "FINAL_BLOCK"]) {
      expect(texts.filter((text) => text.includes(marker))).toHaveLength(1);
    }
  });

  it("does not re-send a final block that the idle timer already flushed as progress", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setNextEvents([
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "ONLY_BLOCK" },
      { __delayMs: 1800 },
      { type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "job-1", text: "ONLY_BLOCK" },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude slow finish"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("ONLY_BLOCK")), 3000);
    // Let the delayed completion land and the turn finish fully before counting.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const texts = sent.map((entry) => entry.text ?? "");
    expect(texts.filter((text) => text.includes("ONLY_BLOCK"))).toHaveLength(1);
  });

  it("flushes the held narration block before reporting a mid-turn error", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setNextEvents([
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "PART_ONE" },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "PART_TWO" },
      { type: "error", sessionId: "claude-provider-1", jobId: "job-1", message: "boom mid-turn" },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude fail midway"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("boom mid-turn")), 3000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const texts = sent.map((entry) => entry.text ?? "");
    expect(texts.filter((text) => text.includes("PART_ONE"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("PART_TWO"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("boom mid-turn"))).toHaveLength(1);
    expect(texts.some((text) => text.includes("Claude failed: boom mid-turn"))).toBe(true);
  });

  it("reports a provider stream that ends without a completion instead of marking it successful", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setNextEvents([
      { type: "status_message", sessionId: "claude-provider-1", jobId: "job-1", text: "Still working." },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude incomplete"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("without a completion event")), 3000);

    const texts = sent.map((entry) => entry.text ?? "");
    expect(texts.some((text) => text.includes("Claude failed:"))).toBe(true);
    expect(texts.some((text) => text.includes("Claude finished without text"))).toBe(false);
  });

  it("delivers narration in full in edit mode, rolling oversized blocks into their own messages", async () => {
    const { bot, sent } = await createTestBot(tempDir, { progressDelivery: "edit" });
    const midBlock = `MID ${"m".repeat(2000)}`;
    const hugeBlock = `HUGE ${"h".repeat(6000)}`;
    mockClaude.setNextEvents([
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: midBlock },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: hugeBlock },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "FINAL_MARK" },
      { type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "job-1", text: "FINAL_MARK" },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude narrate a lot"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("FINAL_MARK")));

    const texts = sent.map((entry) => entry.text ?? "");
    const midMessage = texts.find((text) => text.includes("MID "));
    expect(midMessage).toBeDefined();
    expect(midMessage).toContain(midBlock);

    const hugeChars = texts.join("").split("h").length - 1;
    expect(hugeChars).toBeGreaterThanOrEqual(6000);

    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).not.toMatch(/[mh]{3}\.\.\./u);
    }
  });

  it("shows the unified session list for /sessions while Claude is active", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    const prompt = "Hello there, I’m currently working on the weather app that gives me detailed observations from the area that I’m in in the world, and I want to improve it.";

    await bot.handleUpdate(textUpdate(1, `/claude ${prompt}`));
    await waitFor(() => mockClaude.prompts.includes(prompt));
    await bot.handleUpdate(textUpdate(2, "/sessions"));

    expect(sent.map((entry) => entry.text)).not.toContain(
      "Claude command /sessions is not classified yet, so I did not run it.",
    );
    const list = sent.map((entry) => entry.text).find((text) => text?.includes("Recent provider sessions"));
    expect(list).toBeDefined();
    expect(list).toContain("Claude");
    expect(list).toContain("Selected: #1, Claude");
    expect(list).toContain("Weather app with detailed local observations");
    expect(list?.match(/Weather app with detailed local observations/gu)).toHaveLength(1);
    expect(list).toContain("Subagent child threads are omitted here");
  });

  it("uses a nested Claude working directory as a title hint without replacing the session workspace", async () => {
    const transcriptDir = path.join(tempDir, ".claude-config", "projects", "project");
    const nestedProject = path.join(tempDir, "accessible-weather");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      path.join(transcriptDir, "22222222-2222-4222-8222-222222222222.jsonl"),
      [
        JSON.stringify({
          type: "user",
          cwd: tempDir,
          message: { content: "thinking about decimals in the observations and forecasts" },
        }),
        JSON.stringify({ type: "assistant", cwd: nestedProject, message: { content: "Working on it" } }),
      ].join("\n"),
      "utf8",
    );
    const { bot, sent } = await createTestBot(tempDir, { claudeStrictMcpConfig: false });

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));
    await bot.handleUpdate(textUpdate(2, "/sessions"));

    const list = sent.map((entry) => entry.text ?? "").find((text) => text.includes("Recent provider sessions"));
    const weatherLine = list?.split("\n").find((line) => line.includes("Accessible weather"));
    expect(weatherLine).toContain(`${path.basename(tempDir)}: Accessible weather`);
    expect(weatherLine).not.toContain("accessible-weather: Accessible weather");
  });

  it("passes sentences starting with shortcut words through to Claude", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));

    await bot.handleUpdate(textUpdate(2, "use the venv python for this script"));
    await waitFor(() => mockClaude.prompts.includes("use the venv python for this script"));

    await bot.handleUpdate(textUpdate(3, "new plan, check the other file first"));
    await waitFor(() => mockClaude.prompts.includes("new plan, check the other file first"));

    await bot.handleUpdate(textUpdate(4, "launch the app and test it"));
    await waitFor(() => mockClaude.prompts.includes("launch the app and test it"));

    // None of these may be answered with a session/workspace/launch error.
    const texts = sent.map((entry) => entry.text ?? "");
    expect(texts.some((text) => text.includes("Unknown provider session"))).toBe(false);
    expect(texts.some((text) => text.includes("Usage: /launch_profiles"))).toBe(false);
  });

  it("re-sends the last Claude prompt with /retry", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));
    await bot.handleUpdate(textUpdate(2, "remember this exact prompt"));
    await waitFor(() => mockClaude.prompts.includes("remember this exact prompt"));
    await waitForAgentSessionsIdle(tempDir);

    await bot.handleUpdate(textUpdate(3, "/retry"));
    await waitFor(() =>
      mockClaude.prompts.filter((prompt) => prompt === "remember this exact prompt").length >= 2,
    );

    expect(sent.map((entry) => entry.text)).not.toContain(
      "Claude command /retry is not classified yet, so I did not run it.",
    );
  });

  it("switches sessions with /switch while Claude is active", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));
    await bot.handleUpdate(textUpdate(2, "/sessions"));
    await bot.handleUpdate(textUpdate(3, "/switch 1"));

    const selection = sent.map((entry) => entry.text).find((text) => text?.includes("Selected #1"));
    expect(selection).toBeDefined();
  });

  it("keeps the previous choice on failed Claude resume and shows resume details on success", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const transcriptDir = path.join(tempDir, ".claude-config", "projects", "project");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "user", cwd: tempDir, message: { content: "Terminal work" } }),
      "utf8",
    );
    const { bot, sent, registry } = await createTestBot(tempDir, { claudeStrictMcpConfig: false });
    const statePath = path.join(tempDir, ".telecode", "agent-sessions.json");
    const selected = () => {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as {
        lanes: Array<{ laneKey: string; selectedSessionId?: string }>;
      };
      return state.lanes[0];
    };

    await bot.handleUpdate(textUpdate(1, "/sessions"));
    const previousSelected = selected()?.selectedSessionId;
    mockClaude.resumeSession.mockRejectedValueOnce(new Error("resume unavailable"));
    await bot.handleUpdate(textUpdate(2, `/switch ${sessionId}`));

    const lane = selected();
    expect(lane.selectedSessionId).toBe(previousSelected);
    expect(registry.getActiveProvider(lane.laneKey)).toBe("codex");
    expect(sent.map((entry) => entry.text).join("\n")).toContain("Could not resume Claude session: resume unavailable");

    await bot.handleUpdate(textUpdate(3, `/switch ${sessionId}`));
    const selection = sent.map((entry) => entry.text ?? "").find((text) => text.includes("Selected #1: Claude"));
    expect(selection).toContain("Permission mode: acceptEdits");
    expect(selection).toContain("do not write in both places at once");
    expect(selection).toContain(`cd "${tempDir}"`);
    expect(selection).toContain(`claude --resume ${sessionId}`);
    expect(registry.getActiveProvider(lane.laneKey)).toBe("claude");
    expect(selected().selectedSessionId).toBeDefined();
  });

  it("lists sessions for bare /resume and selects with /resume <n> while Claude is active", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));
    await bot.handleUpdate(textUpdate(2, "/resume"));

    const list = sent.map((entry) => entry.text).find((text) => text?.includes("Recent provider sessions"));
    expect(list).toBeDefined();

    await bot.handleUpdate(textUpdate(3, "/resume 1"));
    const selection = sent.map((entry) => entry.text).find((text) => text?.includes("Selected #1"));
    expect(selection).toBeDefined();
  });

  it("forks the Claude conversation with /fork and keeps the original in /sessions", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to hello"));
    await waitForAgentSessionsIdle(tempDir);

    await bot.handleUpdate(textUpdate(2, "/fork my experiment"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Forked this conversation")));

    await bot.handleUpdate(textUpdate(3, "/sessions"));
    const list = sent
      .map((entry) => entry.text ?? "")
      .filter((text) => text.includes("Recent provider sessions"))
      .pop();
    expect(list).toContain("my experiment");
    // The original session must still be listed alongside the selected fork.
    expect((list?.match(/^\d+\. Claude/gm) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("repeats the last reply from the selected provider session", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude first conversation"));
    await waitFor(() => mockClaude.prompts.includes("first conversation"));
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to first conversation"));
    await waitForAgentSessionsIdle(tempDir);
    await bot.handleUpdate(textUpdate(2, "/fork second conversation"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Forked this conversation")));
    await bot.handleUpdate(textUpdate(3, "reply on the fork"));
    await waitFor(() => mockClaude.prompts.includes("reply on the fork"));
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to reply on the fork"));
    await waitForAgentSessionsIdle(tempDir);

    await bot.handleUpdate(textUpdate(4, "/sessions"));
    const sessionList = sent.map((entry) => entry.text ?? "").filter((text) => text.includes("Recent provider sessions")).at(-1);
    const originalLine = sessionList?.split("\n").find((line) =>
      /^\d+\. Claude/u.test(line) && !line.includes(", selected") && !line.includes(", old"),
    );
    const originalNumber = originalLine?.match(/^(\d+)\./u)?.[1];
    expect(originalNumber).toBeDefined();
    await bot.handleUpdate(textUpdate(5, `/switch ${originalNumber}`));
    await bot.handleUpdate(textUpdate(6, "/last"));

    expect(sent.map((entry) => entry.text).at(-1)).toBe("mock reply to first conversation");
  });

  it("switches the Claude engine with /backend while Claude is active", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));
    await waitForAgentSessionsIdle(tempDir);

    await bot.handleUpdate(textUpdate(2, "/backend"));
    expect(sent.map((entry) => entry.text).find((text) => text?.includes("Claude engine for this Telegram context: pty"))).toBeDefined();

    await bot.handleUpdate(textUpdate(3, "/backend sdk"));
    expect(sent.map((entry) => entry.text).find((text) => text?.includes("Claude engine for this Telegram context is now sdk"))).toBeDefined();

    await bot.handleUpdate(textUpdate(4, "/backend"));
    expect(sent.map((entry) => entry.text).find((text) => text?.includes("Claude engine for this Telegram context: sdk"))).toBeDefined();

    await bot.handleUpdate(textUpdate(5, "/compact preserve decisions and pending tests"));
    expect(mockClaude.compact).toHaveBeenCalledWith(
      expect.any(String),
      "preserve decisions and pending tests",
    );
    expect(sent.map((entry) => entry.text).find((text) => text === "Claude compaction completed.")).toBeDefined();
  });

  it("reports Claude diagnostics through /doctor while Claude is active", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "/doctor"));

    const diagnostics = sent.map((entry) => entry.text).find((text) => text?.includes("Claude provider diagnostics"));
    expect(diagnostics).toContain("Binary exists:");
    expect(diagnostics).toContain("Transcript root:");
    expect(diagnostics).toContain("Registered Claude PIDs:");
    expect(diagnostics).toContain("Legacy Claude Telegram plugin processes: 0");
  });

  it("delivers files Claude writes to the turn outbox", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    mockClaude.setArtifactFileName("result.txt");
    await bot.handleUpdate(textUpdate(2, "make me a file"));

    await waitFor(() => mockClaude.prompts.includes("make me a file"));
    await waitFor(() => sent.some((entry) => entry.method === "sendDocument" && entry.text === "result.txt"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("1 artifact generated")));
  });

  it("appends outbox instructions to normal prompts but not slash commands", async () => {
    const { bot } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));
    await bot.handleUpdate(textUpdate(3, "/model opus"));
    await waitFor(() => mockClaude.prompts.includes("/model opus"));

    const helloRaw = mockClaude.rawPrompts.find((raw) => raw.startsWith("hello"));
    expect(helloRaw).toContain("Output files: write any files the user should receive to ");
    expect(mockClaude.rawPrompts).toContain("/model opus");
  });

  it("exposes a shutdown hook that disposes all integrated Claude runtimes", async () => {
    const { bot } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude first"));
    await waitFor(() => mockClaude.prompts.includes("first"));
    await bot.disposeProviders();

    expect(mockClaude.dispose).toHaveBeenCalledWith();
  });
});

async function createTestBot(workspace: string, overrides: Partial<TeleCodeConfig> = {}) {
  const config = { ...createConfig(workspace), ...overrides };
  const registry = new SessionRegistry(config);
  const bot = createBot(config, registry);
  const sent: Array<{ method: string; text?: string }> = [];
  let messageId = 1;

  bot.api.config.use(async (_prev, method, payload: { text?: string }) => {
    if (method === "sendMessage") {
      sent.push({ method, text: payload.text });
      return { ok: true, result: textMessage(messageId++, payload.text ?? "") };
    }
    if (method === "editMessageText") {
      sent.push({ method, text: payload.text });
      return { ok: true, result: true };
    }
    if (method === "sendChatAction" || method === "answerCallbackQuery" || method === "setMessageReaction") {
      sent.push({ method });
      return { ok: true, result: true };
    }
    if (method === "sendDocument") {
      const document = (payload as { document?: { filename?: string } }).document;
      sent.push({ method, text: document?.filename });
      return { ok: true, result: textMessage(messageId++, "") };
    }
    throw new Error(`Unhandled Telegram API method in test: ${method}`);
  });

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
  return { bot, sent, registry };
}

function createConfig(workspace: string): TeleCodeConfig {
  const launchProfile = createDefaultLaunchProfile("danger-full-access", "never");
  return {
    telegramBotToken: "123:abc",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace,
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: undefined,
    codexModel: "gpt-5.5",
    codexBackend: "app-server",
    codexAppServerPath: undefined,
    codexSandboxMode: "danger-full-access",
    codexApprovalPolicy: "never",
    launchProfiles: [launchProfile],
    defaultLaunchProfileId: launchProfile.id,
    enableUnsafeLaunchProfiles: true,
    toolVerbosity: "summary",
    streamAssistantText: false,
    progressDelivery: "messages",
    showTurnTokenUsage: false,
    enableTelegramLogin: false,
    enableTelegramReactions: false,
    enableClaudeProvider: true,
    claudeBin: "C:\\Users\\Dev\\.local\\bin\\claude.exe",
    claudeConfigDir: path.join(workspace, ".claude-config"),
    claudeStrictMcpConfig: true,
    claudeDefaultModel: "sonnet",
    claudeWorkspace: workspace,
    claudePermissionMode: "acceptEdits",
    claudeLargeSessionResume: "summary",
    claudeTurnIdleTimeoutSeconds: 180,
    claudeContextWindow: 200000,
    claudeAutoCompactWindow: 200000,
    claudeBackend: "pty",
  };
}

function textUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: textMessage(updateId, text),
  };
}

function textMessage(messageId: number, text: string) {
  const commandMatch = text.match(/^\/\S+/u);
  return {
    message_id: messageId,
    date: 1,
    chat: { id: 123, type: "private" },
    from: { id: 123, is_bot: false, first_name: "Tester" },
    text,
    entities: commandMatch
      ? [{ type: "bot_command", offset: 0, length: commandMatch[0].length }]
      : undefined,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function waitForAgentSessionsIdle(workspace: string): Promise<void> {
  await waitFor(() => {
    try {
      const state = JSON.parse(
        readFileSync(path.join(workspace, ".telecode", "agent-sessions.json"), "utf8"),
      ) as { sessions?: Array<{ status?: string }> };
      return Boolean(state.sessions?.length) && state.sessions!.every((session) => session.status !== "running");
    } catch {
      return false;
    }
  });
}
