import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { CodexSessionCallbacks } from "../src/codex-session.js";
import type { TeleCodeConfig } from "../src/config.js";
import { VENDOR_CREDENTIALS_FILENAME } from "../src/model-vendors.js";
import { SessionRegistry } from "../src/session-registry.js";

const mockVendorUsage = vi.hoisted(() => ({
  read: vi.fn(async () => "Mock Qwen plan usage"),
}));

const mockPeerReviews = vi.hoisted(() => new Set<string>());
vi.mock("../src/peer-review-sessions.js", () => ({ getPeerReviewSessionIds: () => mockPeerReviews }));

vi.mock("../src/usage-vendors.js", () => ({
  USAGE_READERS: {
    modelstudio: {
      label: "QwenCloud Token Plan",
      cmd: ["python", "qwen_usage.py"],
      timeout: 60,
    },
  },
  hasUsageReader: (vendorId: string) => vendorId === "modelstudio",
  readVendorUsage: mockVendorUsage.read,
}));

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
  let modelCatalog: Array<Record<string, string>> | undefined;
  let outOfBandHandler: ((sessionId: string, event: Record<string, unknown>) => void) | undefined;
  let parkActivityHandler: ((sessionId: string, active: boolean) => void) | undefined;
  let parkStateHandler: ((sessionId: string, parked: boolean) => void) | undefined;
  const parkedSessions = new Set<string>();
  // Provider session id per runtime, like the real adapter; getSessionInfo on a
  // runtime the mock never created falls back to the last active id.
  const sessionProviderIds = new Map<string, string>();
  const aborts: string[] = [];

  return {
    aborts,
    rememberSession: (sessionId: string, providerSessionId: string) => {
      sessionProviderIds.set(sessionId, providerSessionId);
    },
    providerSessionIdFor: (sessionId: string) => sessionProviderIds.get(sessionId) ?? activeProviderSessionId,
    parkedRuntimeFor: (providerSessionId: string) => [...sessionProviderIds].find(([sessionId, providerId]) =>
      providerId === providerSessionId && parkedSessions.has(sessionId),
    )?.[0],
    prompts,
    rawPrompts,
    promptSessionIds,
    steers,
    setArtifactFileName: (name: string | undefined) => {
      artifactFileName = name;
    },
    getArtifactFileName: () => artifactFileName,
    setModelCatalog: (catalog: Array<Record<string, string>> | undefined) => {
      modelCatalog = catalog;
    },
    getModelCatalog: () => modelCatalog,
    setOutOfBandHandler: (handler: ((sessionId: string, event: Record<string, unknown>) => void) | undefined) => {
      outOfBandHandler = handler;
    },
    emitOutOfBand: (sessionId: string, event: Record<string, unknown>): void => {
      outOfBandHandler?.(sessionId, event);
    },
    setParkActivityHandler: (handler: ((sessionId: string, active: boolean) => void) | undefined) => {
      parkActivityHandler = handler;
    },
    emitParkActivity: (sessionId: string, active: boolean): void => {
      parkActivityHandler?.(sessionId, active);
    },
    setParkStateHandler: (handler: ((sessionId: string, parked: boolean) => void) | undefined) => {
      parkStateHandler = handler;
    },
    emitParkState: (sessionId: string, parked: boolean): void => {
      parkStateHandler?.(sessionId, parked);
    },
    setParked: (sessionId: string, parked: boolean): void => {
      if (parked) {
        parkedSessions.add(sessionId);
      } else {
        parkedSessions.delete(sessionId);
      }
    },
    isParked: (sessionId: string): boolean => parkedSessions.has(sessionId),
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
      parkedSessions.clear();
      sessionProviderIds.clear();
      aborts.length = 0;
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
      modelCatalog = undefined;
      outOfBandHandler = undefined;
      parkActivityHandler = undefined;
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
      mockClaude.rememberSession(descriptor.id, descriptor.providerSessionId);
      mockClaude.createSession(options);
      return descriptor;
    }

    setOutOfBandHandler(handler: (sessionId: string, event: Record<string, unknown>) => void) {
      mockClaude.setOutOfBandHandler(handler);
    }

    setParkActivityHandler(handler: (sessionId: string, active: boolean) => void) {
      mockClaude.setParkActivityHandler(handler);
    }

    setParkStateHandler(handler: (sessionId: string, parked: boolean) => void) {
      mockClaude.setParkStateHandler(handler);
    }

    isParked(sessionId: string) {
      return mockClaude.isParked(sessionId);
    }

    async resumeSession(session: unknown) {
      const backend = (session as { metadata?: { backend?: string } }).metadata?.backend;
      const providerSessionId = (session as { providerSessionId?: string }).providerSessionId;
      if (backend) {
        mockClaude.setActiveBackend(backend);
      }
      if (providerSessionId) {
        mockClaude.setActiveProviderSessionId(providerSessionId);
        mockClaude.rememberSession((session as { id: string }).id, providerSessionId);
      }
      mockClaude.resumeSession(session);
      const parkedId = providerSessionId ? mockClaude.parkedRuntimeFor(providerSessionId) : undefined;
      return parkedId ? { ...session as Record<string, unknown>, id: parkedId } : session;
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
      mockClaude.rememberSession(descriptor.id, descriptor.providerSessionId);
      return descriptor;
    }

    async getSessionInfo(sessionId: string) {
      const descriptor = {
        id: sessionId,
        provider: "claude",
        workspace: "C:\\workspace",
        displayName: "Mock Claude",
        providerSessionId: mockClaude.providerSessionIdFor(sessionId),
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

    async abort(sessionId: string) {
      mockClaude.aborts.push(sessionId);
      mockClaude.setNextEvents([{ type: "error", sessionId, message: "Claude turn aborted" }]);
      mockClaude.releaseBlockedPrompt();
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

    async listModels() {
      return mockClaude.getModelCatalog();
    }

    async getContext() {
      return {
        usedTokens: 3,
        contextWindow: mockClaude.getActiveModel() === "qwen3.8-max" ? 1_000_000 : 200_000,
        autoCompactWindow: 200_000,
      };
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

// The login flow is the only pty.spawn in bot.ts, so a stub is enough to prove
// /login reaches it instead of being blocked in a Claude lane.
const mockPty = vi.hoisted(() => {
  const spawns: Array<{ file: string; args: string[] }> = [];
  const writes: string[] = [];
  let emit: ((data: string) => void) | undefined;
  return {
    spawns,
    writes,
    emitData: (data: string) => emit?.(data),
    setEmitter: (listener: (data: string) => void) => {
      emit = listener;
    },
    reset: () => {
      spawns.length = 0;
      writes.length = 0;
      emit = undefined;
    },
  };
});

vi.mock("node-pty", () => ({
  spawn: (file: string, args: string[]) => {
    mockPty.spawns.push({ file, args });
    return {
      onData: (listener: (data: string) => void) => {
        mockPty.setEmitter(listener);
        return { dispose: () => {} };
      },
      onExit: () => ({ dispose: () => {} }),
      write: (data: string) => {
        mockPty.writes.push(data);
      },
      kill: () => {},
    };
  },
}));

import { createBot } from "../src/bot.js";

describe("Claude bot flow", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecode-bot-claude-"));
    mockClaude.reset();
    mockPty.reset();
    mockVendorUsage.read.mockClear();
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

  it("routes an inline Claude vendor-model command through the fresh-session switch", async () => {
    writeFileSync(
      path.join(tempDir, VENDOR_CREDENTIALS_FILENAME),
      JSON.stringify({ modelstudio: "sk-test" }),
      "utf8",
    );
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude original session"));
    await waitFor(() => mockClaude.prompts.includes("original session"));
    await waitForAgentSessionsIdle(tempDir);
    await bot.handleUpdate(textUpdate(2, "/claude /model qwen"));

    expect(mockClaude.createSession).toHaveBeenCalledTimes(2);
    expect(mockClaude.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ model: "qwen3.8-max" }),
    }));
    expect(mockClaude.dispose).toHaveBeenCalledWith("claude-provider-1");
    expect(mockClaude.prompts).toEqual(["original session"]);
    expect(sent.map((entry) => entry.text)).toContain(
      "New Claude session on qwen3.8-max (QwenCloud Token Plan). The next normal message will use it.",
    );
  });

  it("reports Qwen usage with Claude session context instead of the Claude panel", async () => {
    writeFileSync(
      path.join(tempDir, VENDOR_CREDENTIALS_FILENAME),
      JSON.stringify({ modelstudio: "sk-test" }),
      "utf8",
    );
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude /model qwen"));
    await bot.handleUpdate(textUpdate(2, "/usage"));

    const report = sent.map((entry) => entry.text ?? "").find((text) =>
      text.includes("Mock Qwen plan usage"),
    );
    expect(mockVendorUsage.read).toHaveBeenCalledWith("modelstudio");
    expect(report).toContain("Mock Qwen plan usage");
    expect(report).toContain("Session context: 3 of 1000000 tokens (0%).");
    expect(report).not.toContain("Mock Claude usage panel");
  });

  it("routes inline /claude /usage through the same Qwen-aware usage handler", async () => {
    writeFileSync(
      path.join(tempDir, VENDOR_CREDENTIALS_FILENAME),
      JSON.stringify({ modelstudio: "sk-test" }),
      "utf8",
    );
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude /model qwen"));
    await bot.handleUpdate(textUpdate(2, "/claude /usage"));

    expect(mockVendorUsage.read).toHaveBeenCalledWith("modelstudio");
    expect(mockClaude.prompts).toEqual([]);
    expect(sent.map((entry) => entry.text ?? "").join("\n")).toContain("Mock Qwen plan usage");
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

  it("keeps Claude fallback and quiet notices in replay while Claude is backgrounded", async () => {
    const { bot, sent, registry } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();
    mockClaude.setNextEvents([
      {
        type: "status_message",
        sessionId: "claude-provider-1",
        jobId: "job-1",
        text: "Claude model fallback: Fable 5.1 switched to Opus 4.8. Reason: cyber safeguards. This session will continue on Opus 4.8.",
        priority: true,
      },
      {
        type: "status_message", sessionId: "claude-provider-1", jobId: "job-1",
        text: "Claude has been quiet for 3 minutes. Still waiting.",
      },
      {
        type: "assistant_text_delta",
        sessionId: "claude-provider-1",
        jobId: "job-1",
        text: "BACKGROUND_FINAL",
      },
      {
        type: "assistant_message_complete",
        sessionId: "claude-provider-1",
        jobId: "job-1",
        text: "BACKGROUND_FINAL",
      },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude guarded task"));
    await waitFor(() => mockClaude.prompts.includes("guarded task"));
    registry.setActiveProvider("123", "codex");
    mockClaude.releaseBlockedPrompt();

    await waitForAgentSessionsIdle(tempDir);
    expect(sent.some((entry) => entry.text?.includes("Claude model fallback:"))).toBe(false);
    expect(sent.some((entry) => entry.text?.includes("Claude has been quiet"))).toBe(false);
    await bot.handleUpdate(textUpdate(2, "/claude"));
    await bot.handleUpdate(textUpdate(3, "/replay all"));
    const replay = sent.filter((entry) => entry.text?.includes("Buffered Claude output")).map((entry) => entry.text).join("\n");
    expect(replay).toContain("Claude model fallback: Fable 5.1 switched to Opus 4.8.");
    expect(replay).toContain("Claude has been quiet for 3 minutes");
  });

  it.each(["messages", "none"] as const)("keeps background commentary quiet and replayable with progress=%s", async (progressDelivery) => {
    const { bot, sent, registry } = await createTestBot(tempDir, { progressDelivery });
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

    const queueHint = "Send s to steer it into the running turn, d to drop it, or nothing to leave it queued. /stop aborts the running turn.";
    expect(sent.map((entry) => entry.text)).toContain(
      `Claude is still working. I queued this Claude message and will run it next.\n${queueHint}`,
    );
    expect(sent.map((entry) => entry.text)).toContain(
      `Claude is still working. I queued this Claude message as item #2.\n${queueHint}`,
    );

    mockClaude.releaseBlockedPrompt();
    await waitFor(() => mockClaude.prompts.length === 3);

    expect(mockClaude.prompts).toEqual(["first task", "second task", "third task"]);
  });

  it("starts the Claude login flow from /login instead of blocking it", async () => {
    // A bare binary name keeps the existence check happy; node-pty is stubbed above.
    const { bot, sent, registry } = await createTestBot(tempDir, { claudeBin: "claude" });

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "/login"));
    await waitFor(() => mockPty.spawns.length === 1);

    expect(mockPty.spawns[0]).toEqual({ file: "claude", args: ["auth", "login", "--claudeai"] });
    expect(sent.map((entry) => entry.text)).toContain(
      "Claude login started. Waiting for the browser login URL...",
    );
    expect(sent.map((entry) => entry.text ?? "").join("\n")).not.toContain("blocked from Telegram");

    mockPty.emitData("Browse to https://claude.com/cai/oauth/authorize?state=abc123\r\nPaste code here:");
    await waitFor(() =>
      sent.some((entry) => entry.text?.includes("https://claude.com/cai/oauth/authorize?state=abc123")),
    );

    // Drop the lane so the 10 minute login timeout does not outlive the test.
    registry.remove("123");
  });

  it("steers a queued Claude message into the running turn on s", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();

    await bot.handleUpdate(textUpdate(1, "/claude long task"));
    await waitFor(() => mockClaude.prompts.includes("long task"));
    await bot.handleUpdate(textUpdate(2, "actually use the venv python"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Send s to steer it")));

    await bot.handleUpdate(textUpdate(3, "s"));
    await waitFor(() => mockClaude.steers.includes("actually use the venv python"));
    expect(sent.map((entry) => entry.text)).toContain("Steer sent to the active Claude turn.");

    mockClaude.releaseBlockedPrompt();
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to long task"));

    // The steered message must not also run as a queued follow-up turn.
    expect(mockClaude.prompts).toEqual(["long task"]);
  });

  it("drops a queued Claude message on d and passes a bare d through when nothing is queued", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();

    await bot.handleUpdate(textUpdate(1, "/claude long task"));
    await waitFor(() => mockClaude.prompts.includes("long task"));
    await bot.handleUpdate(textUpdate(2, "oops wrong chat"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Send s to steer it")));

    await bot.handleUpdate(textUpdate(3, "d"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Dropped the queued message")));

    mockClaude.releaseBlockedPrompt();
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to long task"));
    await waitForAgentSessionsIdle(tempDir);
    expect(mockClaude.prompts).toEqual(["long task"]);
    expect(mockClaude.steers).toEqual([]);

    // Nothing queued anymore: a literal d is an ordinary prompt.
    await bot.handleUpdate(textUpdate(4, "d"));
    await waitFor(() => mockClaude.prompts.includes("d"));
  });

  it("keeps the s/d offer pointed at the newest queued message", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();

    await bot.handleUpdate(textUpdate(1, "/claude long task"));
    await waitFor(() => mockClaude.prompts.includes("long task"));
    await bot.handleUpdate(textUpdate(2, "first follow-up"));
    await bot.handleUpdate(textUpdate(3, "second follow-up"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("as item #2")));

    await bot.handleUpdate(textUpdate(4, "d"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Dropped the queued message")));

    mockClaude.releaseBlockedPrompt();
    await waitFor(() => mockClaude.prompts.includes("first follow-up"));
    await waitForAgentSessionsIdle(tempDir);
    expect(mockClaude.prompts).toEqual(["long task", "first follow-up"]);
  });

  it("steers a queued Claude message with /qsteer and reports when nothing is queued", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/qsteer"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("No queued message to steer")));

    mockClaude.blockNextPrompt();
    await bot.handleUpdate(textUpdate(2, "/claude long task"));
    await waitFor(() => mockClaude.prompts.includes("long task"));
    await bot.handleUpdate(textUpdate(3, "check the logs too"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Send s to steer it")));

    await bot.handleUpdate(textUpdate(4, "/qsteer"));
    await waitFor(() => mockClaude.steers.includes("check the logs too"));

    mockClaude.releaseBlockedPrompt();
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to long task"));
    await waitForAgentSessionsIdle(tempDir);
    expect(mockClaude.prompts).toEqual(["long task"]);
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

  it("starts later /new claude sessions on the last /model choice, across restarts", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude first"));
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to first"));
    await waitForAgentSessionsIdle(tempDir);
    await bot.handleUpdate(textUpdate(2, "/model opus"));
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to /model opus"));
    await waitForAgentSessionsIdle(tempDir);

    const preferences = JSON.parse(readFileSync(path.join(tempDir, ".telecode", "preferences.json"), "utf8"));
    expect(preferences.selectedClaudeModel).toBe("opus");

    // A restarted bridge reads the saved choice back, so /new keeps using it.
    const restarted = await createTestBot(tempDir);
    await restarted.bot.handleUpdate(textUpdate(3, "/new claude"));
    expect(mockClaude.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ model: "opus" }),
    }));
    expect(restarted.sent.map((entry) => entry.text)).toContain(
      "New Claude session selected with model opus. The next normal message will use it.",
    );
  });

  it("does not save a one-off /new claude model as the default", async () => {
    const { bot } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/new claude opus"));
    await bot.handleUpdate(textUpdate(2, "/new claude"));

    expect(mockClaude.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ model: "sonnet" }),
    }));
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

  it("reports the exact model an alias runs on in /status, /model and /new", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setModelCatalog([
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5 \u00b7 Best for everyday, complex tasks" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 \u00b7 Efficient for routine tasks" },
    ]);

    await bot.handleUpdate(textUpdate(1, "/new claude opus"));
    expect(sent.map((entry) => entry.text)).toContain(
      "New Claude session selected with model opus, currently Opus 5.5 (claude-opus-5-5). The next normal message will use it.",
    );

    await bot.handleUpdate(textUpdate(2, "/status"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Claude session:")));
    expect(sent.map((entry) => entry.text).find((text) => text?.includes("Claude session:"))).toContain(
      "Model: opus, currently Opus 5.5 (claude-opus-5-5)",
    );

    await bot.handleUpdate(textUpdate(3, "/model"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("New sessions start on:")));
    const modelReply = sent.map((entry) => entry.text).find((text) => text?.includes("New sessions start on:"));
    expect(modelReply).toContain("Claude Model: opus, currently Opus 5.5 (claude-opus-5-5)");
    expect(modelReply).toContain("New sessions start on: sonnet, currently Sonnet 5 (claude-sonnet-5)");
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

  it("toggles Claude and Codex with /prev without listing or starting an extra turn", async () => {
    const { bot, sent, registry } = await createTestBot(tempDir);
    const codexSession = {
      getInfo: () => ({ workspace: tempDir, threadId: "existing-codex", model: "gpt-5.5" }),
      getCurrentWorkspace: () => tempDir,
      isProcessing: () => false,
    };
    vi.spyOn(registry, "get").mockReturnValue(codexSession as never);
    const selected = () => {
      const state = JSON.parse(readFileSync(path.join(tempDir, ".telecode", "agent-sessions.json"), "utf8"));
      return state.sessions.find((session: { id: string }) => session.id === state.lanes[0].selectedSessionId);
    };
    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to hello"));
    await waitForAgentSessionsIdle(tempDir);
    const claudeId = selected().id;
    await bot.handleUpdate(textUpdate(20, "/sessionorder created"));
    expect(sent.at(-1)?.text).toContain("Session order: recently created");
    await bot.handleUpdate(textUpdate(21, "/sessionorder used"));
    await bot.handleUpdate(textUpdate(2, "/codex"));
    expect(selected().provider).toBe("codex");
    const codexId = selected().id;
    await bot.handleUpdate(textUpdate(3, "/prev"));
    expect(selected().id).toBe(claudeId);
    await bot.handleUpdate(textUpdate(4, "/prev"));
    expect(selected().id).toBe(codexId);
    expect(mockClaude.prompts).toEqual(["hello"]);
  });

  it("orders Claude transcripts by creation time rather than file activity", async () => {
    const transcriptDir = path.join(tempDir, ".claude-config", "projects", "project");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(path.join(transcriptDir, "11111111-1111-4111-8111-111111111111.jsonl"), JSON.stringify({
      type: "user", timestamp: "2020-01-01T00:00:00Z", cwd: tempDir,
      message: { content: "Old creation transcript" },
    }));
    writeFileSync(path.join(transcriptDir, "22222222-2222-4222-8222-222222222222.jsonl"), JSON.stringify({
      type: "user", timestamp: "2021-01-01T00:00:00Z", cwd: tempDir,
      message: { content: "New creation transcript" },
    }));
    const future = new Date(Date.now() + 10000);
    utimesSync(path.join(transcriptDir, "11111111-1111-4111-8111-111111111111.jsonl"), future, future);
    const { bot, sent } = await createTestBot(tempDir, { claudeStrictMcpConfig: false });
    await bot.handleUpdate(textUpdate(1, "/sessionorder created"));
    await bot.handleUpdate(textUpdate(2, "/sessions all"));
    const list = sent.map((entry) => entry.text ?? "").join("\n");
    expect(list).toContain("New creation transcript");
    expect(list).toContain("Old creation transcript");
    expect(list.indexOf("New creation transcript")).toBeLessThan(list.indexOf("Old creation transcript"));
    expect(list).toContain("created");
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

  it("hands documents and photos to Claude as saved files with the caption", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hello world")));
    try {
      const { bot, sent } = await createTestBot(tempDir);

      await bot.handleUpdate(textUpdate(1, "/claude"));
      await bot.handleUpdate({
        update_id: 2,
        message: {
          ...textMessage(2, ""),
          text: undefined,
          caption: "read this",
          document: { file_id: "doc1", file_unique_id: "doc1", file_name: "notes.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", file_size: 11 },
        },
      });
      await waitFor(() => mockClaude.prompts.some((prompt) => prompt.startsWith("read this")));
      const docPrompt = mockClaude.prompts.find((prompt) => prompt.startsWith("read this")) ?? "";
      const savedPath = docPrompt.match(/saved at: (.+?\.docx)\./u)?.[1] ?? "";
      expect(savedPath).toContain(path.join(".telecode", "inbox", "claude-"));
      expect(readFileSync(savedPath, "utf8")).toBe("hello world");
      expect(sent.map((entry) => entry.text ?? "").join(" ")).not.toContain("not supported");

      await waitForAgentSessionsIdle(tempDir);
      await bot.handleUpdate({
        update_id: 3,
        message: {
          ...textMessage(3, ""),
          text: undefined,
          photo: [{ file_id: "pic1", file_unique_id: "pic1", width: 10, height: 10, file_size: 11 }],
        },
      });
      await waitFor(() => mockClaude.prompts.some((prompt) => prompt.startsWith("The user sent a file without a message.")));
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("delivers parked out-of-band Claude output straight to the lane", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));

    // The turn's finally clears the busy flag after the final answer is delivered,
    // so keep emitting until the lane is idle enough for direct delivery. While
    // still busy the event is buffered by design, exactly as in production.
    await waitFor(() => {
      mockClaude.emitOutOfBand("claude-provider-1", {
        type: "assistant_message_complete",
        sessionId: "claude-provider-1",
        jobId: "parked-job",
        text: "LATE ARRIVAL",
      });
      return sent.some((entry) => entry.text?.includes("LATE ARRIVAL"));
    });
  });

  it("buffers parked output arriving mid-turn, then delivers it once the lane frees up", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    mockClaude.blockNextPrompt();
    await bot.handleUpdate(textUpdate(2, "busy turn"));
    await waitFor(() => mockClaude.prompts.includes("busy turn"));

    // The lane is busy, so this is buffered rather than cutting into the turn.
    // It has to be filed under the AGENT SESSION id: keying it on the provider
    // descriptor id put it in a bucket /replay never drains, which lost exactly
    // the late answers parking exists to rescue.
    mockClaude.emitOutOfBand("claude-provider-1", {
      type: "assistant_message_complete",
      sessionId: "claude-provider-1",
      jobId: "parked-job",
      text: "PARKED_WHILE_BUSY",
    });

    mockClaude.releaseBlockedPrompt();

    // ...and it is sent on its own as soon as the turn ends. Leaving it to sit
    // until someone typed /replay meant real answers were silently never read.
    await waitFor(() => sent.some((entry) => entry.text?.includes("PARKED_WHILE_BUSY")));
    const delivered = sent.filter((entry) => entry.text?.includes("PARKED_WHILE_BUSY"));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).not.toContain("Buffered Claude output");
  });

  it("keeps parked Claude commentary quiet while Codex is selected and replays it on request", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    await bot.handleUpdate(textUpdate(1, "/claude first turn"));
    await waitForAgentSessionsIdle(tempDir);
    await bot.handleUpdate(textUpdate(2, "/codex"));

    mockClaude.emitOutOfBand("claude-provider-1", {
      type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "parked-job", text: "PARKED_INTERIM",
    });
    mockClaude.emitOutOfBand("claude-provider-1", {
      type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "parked-job", text: "PARKED_FINAL",
    });
    await waitFor(() => sent.some((entry) => entry.text?.includes("PARKED_FINAL")));
    expect(sent.filter((entry) => entry.text?.includes("PARKED_FINAL"))).toHaveLength(1);
    expect(sent.find((entry) => entry.text?.includes("PARKED_FINAL"))?.text).toContain("From ");
    expect(sent.some((entry) => entry.text?.includes("PARKED_INTERIM"))).toBe(false);

    await bot.handleUpdate(textUpdate(3, "/claude"));
    expect(sent.some((entry) => entry.text?.includes("PARKED_INTERIM"))).toBe(false);
    await bot.handleUpdate(textUpdate(4, "/replay all"));
    expect(sent.filter((entry) => entry.text?.includes("PARKED_INTERIM"))).toHaveLength(1);
    await bot.handleUpdate(textUpdate(5, "/repeat"));
    expect(sent.filter((entry) => entry.text?.includes("PARKED_FINAL"))).toHaveLength(2);
  });

  it("does not repeat a parked final paragraph already delivered in the foreground", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    await bot.handleUpdate(textUpdate(1, "/claude first turn"));
    await waitForAgentSessionsIdle(tempDir);
    mockClaude.emitOutOfBand("claude-provider-1", {
      type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "parked-job", text: "ALREADY_STREAMED_FINAL",
    });
    mockClaude.emitOutOfBand("claude-provider-1", {
      type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "parked-job", text: "ALREADY_STREAMED_FINAL",
    });
    await waitFor(() => sent.some((entry) => entry.text?.includes("ALREADY_STREAMED_FINAL")));
    await bot.handleUpdate(textUpdate(2, "/repeat"));
    expect(sent.filter((entry) => entry.text?.includes("ALREADY_STREAMED_FINAL"))).toHaveLength(2);
  });

  it("keeps later parked commentary quiet when Telegram is delayed across a provider switch", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    await bot.handleUpdate(textUpdate(1, "/claude first turn"));
    await waitForAgentSessionsIdle(tempDir);
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    let sendStarted = false;
    bot.api.config.use(async (prev, method, payload: { text?: string }) => {
      if (method === "sendMessage" && payload.text?.includes("IN_FLIGHT_PROGRESS")) {
        sendStarted = true;
        await sendGate;
      }
      return prev(method, payload);
    });
    mockClaude.emitOutOfBand("claude-provider-1", {
      type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "parked-job", text: "IN_FLIGHT_PROGRESS",
    });
    await waitFor(() => sendStarted);
    try {
      await bot.handleUpdate(textUpdate(2, "/codex"));
      mockClaude.emitOutOfBand("claude-provider-1", {
        type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "parked-job", text: "QUEUED_PARK_PROGRESS",
      });
      mockClaude.emitOutOfBand("claude-provider-1", {
        type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "parked-job", text: "QUEUED_PARK_FINAL",
      });
    } finally {
      releaseSend();
    }
    await waitFor(() => sent.some((entry) => entry.text?.includes("QUEUED_PARK_FINAL")));
    expect(sent.some((entry) => entry.text?.includes("QUEUED_PARK_PROGRESS"))).toBe(false);
    expect(sent.find((entry) => entry.text?.includes("QUEUED_PARK_FINAL"))?.text).toContain("From ");
    await bot.handleUpdate(textUpdate(3, "/claude"));
    await bot.handleUpdate(textUpdate(4, "/replay all"));
    expect(sent.some((entry) => entry.text?.includes("QUEUED_PARK_PROGRESS"))).toBe(true);
  });

  it("hides a registered Claude peer review from /sessions while keeping ordinary sessions", async () => {
    const { bot, sent } = await createTestBot(tempDir, { claudeStrictMcpConfig: false });
    await bot.handleUpdate(textUpdate(1, "/claude first turn"));
    await waitForAgentSessionsIdle(tempDir);
    const transcriptDir = path.join(tempDir, ".claude-config", "projects", "project");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(path.join(transcriptDir, "peer-review-hidden.jsonl"), [
      JSON.stringify({ type: "user", cwd: tempDir, message: { content: "Review this code" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "PEER_REVIEW_SHOULD_BE_HIDDEN" }),
    ].join("\n"));
    writeFileSync(path.join(transcriptDir, "ordinary-visible.jsonl"), [
      JSON.stringify({ type: "user", cwd: tempDir, message: { content: "Normal conversation" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "ORDINARY_SESSION_VISIBLE" }),
    ].join("\n"));
    mockPeerReviews.add("peer-review-hidden");
    try {
      await bot.handleUpdate(textUpdate(2, "/sessions"));
      const answer = sent.map((entry) => entry.text).at(-1) ?? "";
      expect(answer).toContain("ORDINARY_SESSION_VISIBLE");
      expect(answer).not.toContain("PEER_REVIEW_SHOULD_BE_HIDDEN");
    } finally { mockPeerReviews.clear(); }
  });

  it.each([false, true])("uses the same Claude title for /sessions and parked completion, renamed=%s", async (renamed) => {
    const { bot, sent } = await createTestBot(tempDir, { claudeStrictMcpConfig: false });
    await bot.handleUpdate(textUpdate(1, "/claude first turn"));
    await waitForAgentSessionsIdle(tempDir);
    const transcriptDir = path.join(tempDir, ".claude-config", "projects", "project");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(path.join(transcriptDir, "provider-session-1.jsonl"), [
      JSON.stringify({ type: "user", cwd: "C:\\workspace", message: { content: "first turn" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "TeleCode native title" }),
    ].join("\n"));
    writeFileSync(path.join(transcriptDir, "other-session.jsonl"), [
      JSON.stringify({ type: "user", cwd: "C:\\workspace", message: { content: "another topic" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "DJ pro accessibility" }),
    ].join("\n"));
    if (renamed) {
      await bot.handleUpdate(textUpdate(2, "/rename TeleCode custom name"));
    }
    const expectedTitle = renamed ? "TeleCode custom name" : "TeleCode native title";
    await bot.handleUpdate(textUpdate(3, "/sessions"));
    expect(sent.map((entry) => entry.text).at(-1)).toContain(expectedTitle);
    await bot.handleUpdate(textUpdate(4, "/codex"));
    mockClaude.emitOutOfBand("claude-provider-1", {
      type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "parked-job", text: "NATIVE_TITLE_FINAL",
    });
    await waitFor(() => sent.some((entry) => entry.text?.includes("NATIVE_TITLE_FINAL")));
    const answer = sent.find((entry) => entry.text?.includes("NATIVE_TITLE_FINAL"))?.text ?? "";
    expect(answer).toContain(`From "${expectedTitle}":`);
    expect(answer).not.toContain("DJ pro");
  });

  it("uses a rename made after a parked final entered the delivery queue", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    await bot.handleUpdate(textUpdate(1, "/claude first turn"));
    await waitForAgentSessionsIdle(tempDir);
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    let sendStarted = false;
    bot.api.config.use(async (prev, method, payload: { text?: string }) => {
      if (method === "sendMessage" && payload.text?.includes("HELD_PARK_PROGRESS")) {
        sendStarted = true;
        await sendGate;
      }
      return prev(method, payload);
    });
    mockClaude.emitOutOfBand("claude-provider-1", {
      type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "parked-job", text: "HELD_PARK_PROGRESS",
    });
    await waitFor(() => sendStarted);
    try {
      mockClaude.emitOutOfBand("claude-provider-1", {
        type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "parked-job", text: "RENAMED_PARK_FINAL",
      });
      await bot.handleUpdate(textUpdate(2, "/rename TeleCode parked fix"));
      await bot.handleUpdate(textUpdate(3, "/codex"));
    } finally {
      releaseSend();
    }
    await waitFor(() => sent.some((entry) => entry.text?.includes("RENAMED_PARK_FINAL")));
    const answer = sent.find((entry) => entry.text?.includes("RENAMED_PARK_FINAL"))?.text ?? "";
    expect(answer).toContain('From "TeleCode parked fix":');
    expect(answer).not.toContain("first turn");
  });

  it("keeps an undelivered parked final available when Telegram rejects it", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    await bot.handleUpdate(textUpdate(1, "/claude first turn"));
    await waitForAgentSessionsIdle(tempDir);
    await bot.handleUpdate(textUpdate(2, "/codex"));
    let failSend = true;
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    bot.api.config.use(async (prev, method, payload: { text?: string }) => {
      if (failSend && method === "sendMessage" && payload.text?.includes("REJECTED_PARK_FINAL")) {
        throw new Error("Telegram send failed");
      }
      return prev(method, payload);
    });
    mockClaude.emitOutOfBand("claude-provider-1", {
      type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "parked-job", text: "REJECTED_PARK_FINAL",
    });
    await waitFor(() => warnings.mock.calls.some((call) => call[0] === "Failed to deliver parked Claude output"));
    expect(sent.some((entry) => entry.text?.includes("REJECTED_PARK_FINAL"))).toBe(false);
    failSend = false;
    await bot.handleUpdate(textUpdate(3, "/claude"));
    expect(sent.filter((entry) => entry.text?.includes("REJECTED_PARK_FINAL"))).toHaveLength(1);
  });

  it("recovers the Claude queue when an active park closes without an activity callback", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    await bot.handleUpdate(textUpdate(1, "/claude first turn"));
    await waitForAgentSessionsIdle(tempDir);
    mockClaude.emitParkActivity("claude-provider-1", true);
    await bot.handleUpdate(textUpdate(2, "queued behind the park"));
    expect(mockClaude.prompts).not.toContain("queued behind the park");
    mockClaude.emitParkState("claude-provider-1", false);
    await waitFor(() => sent.some((entry) => entry.text?.includes("mock reply to queued behind the park")));
  });

  it.each(["idle", "closed"])("delivers a parked turn's final before its follow-up on %s", async (endSignal) => {
    const { bot, sent } = await createTestBot(tempDir);
    await bot.handleUpdate(textUpdate(1, "/claude first turn"));
    await waitForAgentSessionsIdle(tempDir);
    mockClaude.emitParkActivity("claude-provider-1", true);
    await bot.handleUpdate(textUpdate(2, "queued after parked work"));
    if (endSignal === "idle") {
      mockClaude.emitParkActivity("claude-provider-1", false);
    } else {
      mockClaude.emitParkState("claude-provider-1", false);
    }
    mockClaude.emitOutOfBand("claude-provider-1", {
      type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "parked-job", text: "PARKED_ORDER_FINAL",
    });
    await waitFor(() => sent.some((entry) => entry.text?.includes("mock reply to queued after parked work")));
    await waitFor(() => sent.some((entry) => entry.text?.includes("PARKED_ORDER_FINAL")));
    expect(sent.findIndex((entry) => entry.text?.includes("PARKED_ORDER_FINAL"))).toBeLessThan(
      sent.findIndex((entry) => entry.text?.includes("mock reply to queued after parked work")),
    );
  });

  it("does not flush parked commentary into Codex when a Claude turn finishes", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();
    await bot.handleUpdate(textUpdate(1, "/claude held turn"));
    await waitFor(() => mockClaude.prompts.includes("held turn"));
    await bot.handleUpdate(textUpdate(2, "/codex"));
    mockClaude.emitOutOfBand("claude-provider-1", {
      type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "parked-job", text: "HIDDEN_PARKED_INTERIM",
    });
    mockClaude.releaseBlockedPrompt();
    await waitForAgentSessionsIdle(tempDir);
    expect(sent.some((entry) => entry.text?.includes("HIDDEN_PARKED_INTERIM"))).toBe(false);
    await bot.handleUpdate(textUpdate(3, "/claude"));
    await bot.handleUpdate(textUpdate(4, "/replay all"));
    expect(sent.some((entry) => entry.text?.includes("HIDDEN_PARKED_INTERIM"))).toBe(true);
  });

  it("delivers the full background final after foreground narration and a delayed result", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setNextEvents([
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "FOREGROUND_NARRATION" },
      { type: "tool_started", sessionId: "claude-provider-1", jobId: "job-1", toolName: "Read" },
      { __delayMs: 300 },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "DELAYED_BACKGROUND_FINAL" },
      { __delayMs: 1800 },
      { type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "job-1", text: "DELAYED_BACKGROUND_FINAL" },
    ]);
    await bot.handleUpdate(textUpdate(1, "/claude delayed answer"));
    await waitFor(() => sent.some((entry) => entry.text === "FOREGROUND_NARRATION"));
    await bot.handleUpdate(textUpdate(2, "/codex"));
    await waitForAgentSessionsIdle(tempDir);
    const answer = sent.find((entry) => entry.text?.includes("finished in background"))?.text;
    expect(answer).toContain("DELAYED_BACKGROUND_FINAL");
    await bot.handleUpdate(textUpdate(3, "/claude"));
    await bot.handleUpdate(textUpdate(4, "/replay all"));
    expect(sent.filter((entry) => entry.text?.includes("DELAYED_BACKGROUND_FINAL"))).toHaveLength(1);
  });

  it("dispatches Claude's queue while a separate Codex turn is busy", async () => {
    const { bot, sent, registry } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();
    await bot.handleUpdate(textUpdate(1, "/claude held turn"));
    await waitFor(() => mockClaude.prompts.includes("held turn"));
    await bot.handleUpdate(textUpdate(2, "queued follow-up"));
    mockClaude.emitParkActivity("claude-provider-1", true);
    mockClaude.releaseBlockedPrompt();
    await waitForAgentSessionsIdle(tempDir);

    let releaseCodex!: () => void;
    const codexGate = new Promise<void>((resolve) => { releaseCodex = resolve; });
    let codexStarted = false;
    const codexSession = {
      getInfo: () => ({ workspace: tempDir, threadId: "held-codex", model: "gpt-5.5" }),
      getCurrentWorkspace: () => tempDir,
      hasActiveThread: () => true,
      isProcessing: () => codexStarted,
      prompt: async (_input: unknown, callbacks: CodexSessionCallbacks) => {
        codexStarted = true;
        await codexGate;
        callbacks.onTextDelta("CODEX_DONE", { phase: "final_answer" });
        callbacks.onAgentEnd();
        codexStarted = false;
      },
    };
    vi.spyOn(registry, "get").mockReturnValue(codexSession as never);
    vi.spyOn(registry, "getOrCreate").mockResolvedValue(codexSession as never);
    await bot.handleUpdate(textUpdate(3, "/codex"));
    await bot.handleUpdate(textUpdate(4, "codex held turn"));
    await waitFor(() => codexStarted);
    // The queued Claude message belongs to its own runtime even while Codex works.
    mockClaude.emitParkActivity("claude-provider-1", false);
    try {
      await waitFor(() => mockClaude.prompts.includes("queued follow-up"));
      await waitFor(() => sent.some((entry) => entry.text?.includes("mock reply to queued follow-up")));
      expect(codexStarted).toBe(true);
    } finally {
      releaseCodex();
    }
    await waitForAgentSessionsIdle(tempDir);
  });

  /**
   * A parked query whose CLI picked up queued work is a running turn from the
   * user's side. His next plain message must be held and offered as a steer,
   * exactly as Codex does, not dispatched as a turn that silently steers work
   * already in flight while telling him nothing was running.
   */
  it("holds a plain message and offers the steer while a parked Claude turn is working", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "first turn"));
    await waitFor(() => mockClaude.prompts.includes("first turn"));
    await waitForAgentSessionsIdle(tempDir);

    mockClaude.emitParkActivity("claude-provider-1", true);
    await bot.handleUpdate(textUpdate(3, "are you still going"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Claude is still working")));

    expect(mockClaude.prompts).not.toContain("are you still going");
    const notice = sent.map((entry) => entry.text ?? "").find((text) => text.includes("Claude is still working"));
    expect(notice).toContain("Send s to steer it into the running turn");

    // The park goes idle and the held message runs on its own.
    mockClaude.emitParkActivity("claude-provider-1", false);
    await waitFor(() => mockClaude.prompts.includes("are you still going"));
  });

  it("does not wedge the lane when the session a park belonged to is replaced", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude first turn"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("mock reply to first turn")));
    await waitForAgentSessionsIdle(tempDir);

    // The park is working, then the session it belonged to is thrown away. The
    // busy flag must go with it: a leftover entry that still matched the lane
    // would hold every later message in the queue with nothing to release it.
    mockClaude.emitParkActivity("claude-provider-1", true);
    await bot.handleUpdate(textUpdate(2, "/new claude"));
    await waitForAgentSessionsIdle(tempDir);

    await bot.handleUpdate(textUpdate(3, "fresh start"));
    await waitFor(() => mockClaude.prompts.includes("fresh start"));
  });

  it("steers the held message into the parked turn when the user answers s", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "first turn"));
    await waitFor(() => mockClaude.prompts.includes("first turn"));
    await waitForAgentSessionsIdle(tempDir);

    mockClaude.emitParkActivity("claude-provider-1", true);
    await bot.handleUpdate(textUpdate(3, "stop and check the log"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Claude is still working")));

    await bot.handleUpdate(textUpdate(4, "s"));
    await waitFor(() => mockClaude.steers.includes("stop and check the log"));
    expect(sent.some((entry) => entry.text?.includes("Steer sent to the active Claude turn"))).toBe(true);
    expect(mockClaude.prompts).not.toContain("stop and check the log");
  });

  it("keeps a parked Claude session alive across /switch and labels its later output", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude first conversation"));
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to first conversation"));
    await waitForAgentSessionsIdle(tempDir);
    await bot.handleUpdate(textUpdate(2, "/fork second conversation"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Forked this conversation")));
    await bot.handleUpdate(textUpdate(3, "reply on the fork"));
    await waitFor(() => sent.some((entry) => entry.text === "mock reply to reply on the fork"));
    await waitForAgentSessionsIdle(tempDir);
    const forkSessionId = mockClaude.promptSessionIds.at(-1);
    expect(forkSessionId).toBeDefined();

    // The fork's CLI is still alive in a park when the user switches back.
    mockClaude.setParked(forkSessionId ?? "", true);
    await bot.handleUpdate(textUpdate(4, "/sessions"));
    const sessionList = sent.map((entry) => entry.text ?? "").filter((text) => text.includes("Recent provider sessions")).at(-1);
    const originalLine = sessionList?.split("\n").find((line) =>
      /^\d+\. Claude/u.test(line) && !line.includes(", selected") && !line.includes(", old"),
    );
    const originalNumber = originalLine?.match(/^(\d+)\./u)?.[1];
    expect(originalNumber).toBeDefined();
    await bot.handleUpdate(textUpdate(5, `/switch ${originalNumber}`));
    await waitFor(() => sent.some((entry) => entry.text?.includes(`Selected #${originalNumber}`)));

    // Switching away no longer kills the park.
    expect(mockClaude.dispose).not.toHaveBeenCalledWith(forkSessionId);

    // Commentary from another Claude session stays quiet; its final is named.
    mockClaude.emitOutOfBand(forkSessionId ?? "", {
      type: "assistant_text_delta",
      sessionId: forkSessionId,
      jobId: "parked-job",
      text: "FORK_INTERIM",
    });
    mockClaude.emitOutOfBand(forkSessionId ?? "", {
      type: "assistant_message_complete",
      sessionId: forkSessionId,
      jobId: "parked-job",
      text: "FORK FINISHED LATER",
    });
    await waitFor(() => sent.some((entry) => entry.text?.includes("FORK FINISHED LATER")));
    const labeled = sent.find((entry) => entry.text?.includes("FORK FINISHED LATER"))?.text ?? "";
    expect(labeled).toContain("From ");
    expect(labeled).toContain("second conversation");
    expect(sent.some((entry) => entry.text?.includes("FORK_INTERIM"))).toBe(false);

    await bot.handleUpdate(textUpdate(6, "/sessions"));
    const refreshedList = sent.map((entry) => entry.text ?? "").filter((text) => text.includes("Recent provider sessions")).at(-1);
    const forkNumber = refreshedList?.split("\n").find((line) =>
      /^\d+\. Claude/u.test(line) && line.includes("second conversation"),
    )?.match(/^(\d+)\./u)?.[1];
    expect(forkNumber).toBeDefined();
    await bot.handleUpdate(textUpdate(7, `/use ${forkNumber}`));
    await bot.handleUpdate(textUpdate(8, "/replay all"));
    expect(sent.some((entry) => entry.text?.includes("FORK_INTERIM"))).toBe(true);
    await bot.handleUpdate(textUpdate(9, "/use provider-session-1"));

    // Once the background park ends on its own, the runtime is dropped.
    mockClaude.emitParkState(forkSessionId ?? "", false);
    await waitFor(() => mockClaude.dispose.mock.calls.some((call) => call[0] === forkSessionId));
  });

  it("drops parked output for a session the lane does not know", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));

    const before = sent.length;
    mockClaude.emitOutOfBand("claude-provider-does-not-exist", {
      type: "assistant_message_complete",
      sessionId: "claude-provider-does-not-exist",
      jobId: "parked-job",
      text: "SHOULD NOT APPEAR",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sent.slice(before).some((entry) => entry.text?.includes("SHOULD NOT APPEAR"))).toBe(false);
  });

  describe("background Claude turns", () => {
    // Two conversations: the original, then a fork that is selected and runs a
    // long turn. Returns the list numbers of both once the fork is working.
    const startLongTurnOnFork = async (
      bot: Awaited<ReturnType<typeof createTestBot>>["bot"],
      sent: Array<{ text?: string }>,
    ) => {
      await bot.handleUpdate(textUpdate(1, "/claude first conversation"));
      await waitFor(() => sent.some((entry) => entry.text === "mock reply to first conversation"));
      await waitForAgentSessionsIdle(tempDir);
      await bot.handleUpdate(textUpdate(2, "/fork second conversation"));
      await waitFor(() => sent.some((entry) => entry.text?.includes("Forked this conversation")));
      mockClaude.blockNextPrompt();
      await bot.handleUpdate(textUpdate(3, "long task on the fork"));
      await waitFor(() => mockClaude.prompts.includes("long task on the fork"));
      const forkSessionId = mockClaude.promptSessionIds.at(-1) ?? "";
      await bot.handleUpdate(textUpdate(4, "/sessions"));
      const list = sent.map((entry) => entry.text ?? "").filter((text) => text.includes("Recent provider sessions")).at(-1) ?? "";
      const lines = list.split("\n");
      const originalNumber = lines.find((line) =>
        /^\d+\. Claude/u.test(line) && !line.includes(", selected") && !line.includes(", old"),
      )?.match(/^(\d+)\./u)?.[1];
      const forkLine = lines.find((line) => /^\d+\. Claude, selected/u.test(line)) ?? "";
      const forkNumber = forkLine.match(/^(\d+)\./u)?.[1];
      expect(originalNumber).toBeDefined();
      expect(forkNumber).toBeDefined();
      expect(forkLine).toContain(", running");
      return { originalNumber: originalNumber!, forkNumber: forkNumber!, forkSessionId };
    };

    it("keeps a rename made during a turn on its background answer", async () => {
      const { bot, sent } = await createTestBot(tempDir);
      const { originalNumber, forkSessionId } = await startLongTurnOnFork(bot, sent);
      await bot.handleUpdate(textUpdate(5, "/rename TeleCode routing fix"));
      await bot.handleUpdate(textUpdate(6, `/use ${originalNumber}`));
      mockClaude.releaseBlockedPrompt();
      await waitFor(() => sent.some((entry) => entry.text?.includes("mock reply to long task on the fork")));
      const answer = sent.find((entry) => entry.text?.includes("mock reply to long task on the fork"))?.text ?? "";
      expect(answer).toContain('"TeleCode routing fix"');
      expect(answer).not.toContain("second conversation");
      await waitFor(() => mockClaude.dispose.mock.calls.some((call) => call[0] === forkSessionId));
      await bot.handleUpdate(textUpdate(7, "/sessions"));
      expect(sent.map((entry) => entry.text).at(-1)).toContain("TeleCode routing fix");
    });

    it("keeps a running turn going in the background after /use and labels its answer", async () => {
      const { bot, sent } = await createTestBot(tempDir);
      const { originalNumber, forkSessionId } = await startLongTurnOnFork(bot, sent);

      await bot.handleUpdate(textUpdate(5, `/use ${originalNumber}`));
      const switched = sent.map((entry) => entry.text ?? "").find((text) => text.includes(`Selected #${originalNumber}`)) ?? "";
      expect(switched).toContain("keeps running");
      expect(switched).toContain("second conversation");

      // The selected session works normally while the fork is still running.
      await bot.handleUpdate(textUpdate(6, "quick question"));
      await waitFor(() => sent.some((entry) => entry.text === "mock reply to quick question"));
      expect(mockClaude.promptSessionIds.at(-1)).not.toBe(forkSessionId);

      mockClaude.releaseBlockedPrompt();
      await waitFor(() => sent.some((entry) => entry.text?.includes("mock reply to long task on the fork")));
      const answer = sent.find((entry) => entry.text?.includes("mock reply to long task on the fork"))?.text ?? "";
      expect(answer).toMatch(/^Background Claude, session \d+ "second conversation", finished after /u);
      await waitFor(() => mockClaude.dispose.mock.calls.some((call) => call[0] === forkSessionId));

      // The lane was never wedged by the background turn.
      await bot.handleUpdate(textUpdate(7, "after the fork"));
      await waitFor(() => sent.some((entry) => entry.text === "mock reply to after the fork"));
    });

    it("refuses to leave a running turn once the parallel limit is reached", async () => {
      const { bot, sent } = await createTestBot(tempDir, { claudeMaxParallelTurns: 1 });
      const { originalNumber } = await startLongTurnOnFork(bot, sent);

      await bot.handleUpdate(textUpdate(5, `/use ${originalNumber}`));
      await waitFor(() => sent.some((entry) => entry.text?.includes("the limit is 1")));
      expect(sent.some((entry) => entry.text?.includes(`Selected #${originalNumber}`))).toBe(false);

      mockClaude.releaseBlockedPrompt();
      await waitFor(() => sent.some((entry) => entry.text === "mock reply to long task on the fork"));
    });

    it("picks a background turn back up when the user switches to it again", async () => {
      const { bot, sent } = await createTestBot(tempDir);
      const { originalNumber, forkSessionId } = await startLongTurnOnFork(bot, sent);

      await bot.handleUpdate(textUpdate(5, `/use ${originalNumber}`));
      await waitFor(() => sent.some((entry) => entry.text?.includes("keeps running")));
      await bot.handleUpdate(textUpdate(6, "/prev"));
      await waitFor(() => sent.some((entry) => entry.text?.includes("This session is still working")));

      // Selected again, so its answer arrives as a normal reply and a new message queues behind it.
      await bot.handleUpdate(textUpdate(7, "follow-up on the fork"));
      mockClaude.releaseBlockedPrompt();
      await waitFor(() => sent.some((entry) => entry.text === "mock reply to long task on the fork"));
      await waitFor(() => sent.some((entry) => entry.text === "mock reply to follow-up on the fork"));
      expect(mockClaude.promptSessionIds.at(-1)).toBe(forkSessionId);
      expect(sent.some((entry) => entry.text?.includes("finished after"))).toBe(false);
    });

    it("stops a background turn by its /sessions number", async () => {
      const { bot, sent } = await createTestBot(tempDir);
      const { originalNumber, forkSessionId } = await startLongTurnOnFork(bot, sent);

      await bot.handleUpdate(textUpdate(5, `/use ${originalNumber}`));
      await waitFor(() => sent.some((entry) => entry.text?.includes("keeps running")));
      await bot.handleUpdate(textUpdate(6, "/sessions"));
      const list = sent.map((entry) => entry.text ?? "").at(-1) ?? "";
      const forkNumber = list.split("\n").find((line) => /^\d+\. Claude, running/u.test(line))?.match(/^(\d+)\./u)?.[1];
      expect(forkNumber).toBeDefined();
      await bot.handleUpdate(textUpdate(7, `/stop ${forkNumber}`));
      await waitFor(() => sent.some((entry) => entry.text?.startsWith("Stop sent to Background Claude")));
      expect(mockClaude.aborts).toEqual([forkSessionId]);
      await waitFor(() => sent.some((entry) => entry.text?.includes("stopped after")));
      const stopped = sent.find((entry) => entry.text?.includes("stopped after"))?.text ?? "";
      expect(stopped).toContain("second conversation");
      expect(stopped).toContain("Claude turn aborted");
    });

    it("keeps the running turn going when /new starts a fresh session", async () => {
      const { bot, sent } = await createTestBot(tempDir);
      const { forkSessionId } = await startLongTurnOnFork(bot, sent);

      await bot.handleUpdate(textUpdate(5, "/new"));
      await waitFor(() => sent.some((entry) => entry.text?.includes("New Claude session selected")));
      const reply = sent.find((entry) => entry.text?.includes("New Claude session selected"))?.text ?? "";
      expect(reply).toMatch(/^Background Claude, session \d+ "second conversation" keeps running/u);

      await bot.handleUpdate(textUpdate(6, "fresh question"));
      await waitFor(() => sent.some((entry) => entry.text === "mock reply to fresh question"));
      expect(mockClaude.promptSessionIds.at(-1)).not.toBe(forkSessionId);

      mockClaude.releaseBlockedPrompt();
      await waitFor(() => sent.some((entry) => /^Background Claude.*finished after[\s\S]*mock reply to long task on the fork/u.test(entry.text ?? "")));
    });
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
    if (method === "getFile") {
      const fileId = (payload as { file_id?: string }).file_id ?? "file";
      return { ok: true, result: { file_id: fileId, file_unique_id: fileId, file_size: 11, file_path: `documents/${fileId}.docx` } };
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
