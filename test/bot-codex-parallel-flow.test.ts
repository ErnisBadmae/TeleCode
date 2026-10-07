import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import { AgentSessionManager } from "../src/agent-session-manager.js";
import type { CodexThreadRecord } from "../src/codex-state.js";
import type { CodexSessionCallbacks, CodexSessionInfo, CodexThreadGoal, CodexThreadGoalSetParams } from "../src/codex-session.js";
import type { TeleCodeConfig } from "../src/config.js";
import type { CodexReasoningEffort } from "../src/reasoning-effort.js";
import { SessionRegistry } from "../src/session-registry.js";
import type { SessionSearchHit } from "../src/session-search.js";

vi.mock("../src/codex-auth.js", () => ({
  checkAuthStatus: vi.fn(async () => ({ authenticated: true, method: "test", detail: "authenticated" })),
  clearAuthCache: vi.fn(),
  startLogin: vi.fn(),
  startLogout: vi.fn(),
}));

// Keep the machine's real Codex threads out of /sessions.
const codexThreads = vi.hoisted(() => new Map<string, CodexThreadRecord>());
vi.mock("../src/codex-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/codex-state.js")>()),
  listThreads: () => [...codexThreads.values()],
  listSpawnedThreadIds: () => [],
  getThread: (id: string) => codexThreads.get(id),
}));

const searchState = vi.hoisted(() => ({ hits: [] as SessionSearchHit[], queries: [] as string[] }));
vi.mock("../src/session-search.js", () => ({
  createSessionSearchIndex: () => ({
    status: () => ({ ready: true, refreshing: false, indexedFiles: 2, pendingFiles: 0 }),
    refresh: async () => undefined,
    search: (query: string) => {
      searchState.queries.push(query);
      return { hits: [...searchState.hits], totalMatches: searchState.hits.length };
    },
  }),
}));

const runtimes: FakeRuntime[] = [];
vi.mock("../src/codex-backend.js", () => ({
  createCodexSession: async (_config: unknown, options?: { resumeThreadId?: string; workspace?: string; reasoningEffort?: string }) => {
    const runtime = new FakeRuntime(options?.resumeThreadId ?? null, options?.reasoningEffort as CodexReasoningEffort | undefined);
    runtimes.push(runtime);
    return runtime;
  },
}));

import { createBot } from "../src/bot.js";

let threadCounter = 0;
const holds = new Map<string, () => void>();
const resumeFailures = new Map<string, string>();

/** Prompts containing "hold" wait until released by name; others finish at once. */
class FakeRuntime {
  processing = false;
  kind: "prompt" | "goal" | null = null;
  aborted = false;
  goal: CodexThreadGoal | null = null;
  readonly pauseActiveGoal = vi.fn(async () => {
    this.setGoalStatus("paused");
    holds.get(this.goalHold)?.();
    return this.goal;
  });
  private goalHold = "";
  readonly dispose = vi.fn();
  readonly prompts: string[] = [];
  readonly promptEfforts: Array<CodexReasoningEffort | undefined> = [];
  callbacks?: CodexSessionCallbacks;

  constructor(public threadId: string | null, public reasoningEffort?: CodexReasoningEffort) {}

  getInfo(): CodexSessionInfo {
    return {
      threadId: this.threadId,
      workspace: workspaceDir,
      model: "gpt-5.5",
      reasoningEffort: this.reasoningEffort,
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "danger-full-access, never approve",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      unsafeLaunch: true,
    };
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getProcessingKind(): "prompt" | "goal" | null {
    return this.processing ? this.kind : null;
  }

  async getThreadGoal(): Promise<CodexThreadGoal | null> {
    return this.goal;
  }

  async setThreadGoal(params: CodexThreadGoalSetParams): Promise<CodexThreadGoal | null> {
    if (params.status) {
      this.setGoalStatus(params.status);
    }
    return this.goal;
  }

  async clearThreadGoal(): Promise<boolean> {
    const had = Boolean(this.goal);
    this.goal = null;
    return had;
  }

  /** Goal objectives name a hold too; the goal completes when it is released. */
  async runThreadGoal(params: CodexThreadGoalSetParams, callbacks: CodexSessionCallbacks): Promise<CodexThreadGoal | null> {
    this.goalHold = params.objective?.match(/hold \w+/)?.[0] ?? "";
    this.goal = {
      threadId: this.threadId ?? "",
      objective: params.objective ?? "",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    this.prompts.push(`goal ${this.goalHold}`);
    this.processing = true;
    this.kind = "goal";
    try {
      await new Promise<void>((resolve) => holds.set(this.goalHold, resolve));
      if (this.goal.status === "active") {
        this.setGoalStatus("complete");
        callbacks.onTextDelta(`FINAL goal ${this.goalHold}`, { phase: "final_answer" });
      }
      return this.goal;
    } finally {
      this.processing = false;
      this.kind = null;
    }
  }

  private setGoalStatus(status: CodexThreadGoal["status"]): void {
    if (this.goal) {
      this.goal = { ...this.goal, status };
    }
  }

  hasActiveThread(): boolean {
    return Boolean(this.threadId);
  }

  getCurrentWorkspace(): string {
    return workspaceDir;
  }

  async newThread(): Promise<CodexSessionInfo> {
    this.threadId = `thread-${++threadCounter}`;
    return this.getInfo();
  }

  prepareNewThread(): CodexSessionInfo {
    this.threadId = null;
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    const failure = resumeFailures.get(threadId);
    if (failure) {
      throw new Error(failure);
    }
    this.threadId = threadId;
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    return await this.resumeThread(threadId);
  }

  listAllSessions(): [] {
    return [];
  }

  listModels() {
    return [{ slug: "gpt-5.5", supportedReasoningEfforts: ["medium", "high", "max"] as CodexReasoningEffort[] }];
  }

  setReasoningEffort(effort: CodexReasoningEffort): void {
    if (this.processing) throw new Error("Cannot change effort during a turn");
    this.reasoningEffort = effort;
  }

  listWorkspaces(): string[] {
    return [workspaceDir];
  }

  async prompt(input: unknown, callbacks: CodexSessionCallbacks): Promise<void> {
    this.callbacks = callbacks;
    const text = (typeof input === "string" ? input : JSON.stringify(input)).match(/(hold \w+|quick \w+)/)?.[1] ?? "?";
    this.prompts.push(text);
    this.promptEfforts.push(this.reasoningEffort);
    this.processing = true;
    this.kind = "prompt";
    try {
      if (text.startsWith("hold")) {
        await new Promise<void>((resolve) => holds.set(text, resolve));
      }
      if (this.aborted) {
        throw new Error("Codex turn aborted");
      }
      callbacks.onTextDelta(`FINAL ${text}`, { phase: "final_answer" });
      callbacks.onAgentEnd();
    } finally {
      this.processing = false;
      this.kind = null;
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    for (const [name, release] of holds) {
      if (this.prompts.includes(name)) {
        release();
      }
    }
  }
}

let workspaceDir = "";
let debugSent: string[] = [];

describe("background Codex turns", () => {
  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "telecode-codex-parallel-"));
    runtimes.length = 0;
    holds.clear();
    codexThreads.clear();
    searchState.hits.length = 0;
    searchState.queries.length = 0;
    resumeFailures.clear();
    threadCounter = 0;
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("toggles the last two sessions with /prev and /use previous without listing first", async () => {
    const { bot, sent, registry } = createHarness();
    await createThreeIdleSessions(bot, sent);
    await bot.handleUpdate(textUpdate(20, "/prev"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-2");
    expect(sent.at(-1)).toContain("Selected Codex");
    await bot.handleUpdate(textUpdate(21, "/prev"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-3");
    await bot.handleUpdate(textUpdate(22, "/use previous"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-2");
    await bot.handleUpdate(textUpdate(23, "/next"));
    expect(sent.at(-1)).toContain("no newer session");
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-2");
    expect(runtimes.flatMap((runtime) => runtime.prompts)).toHaveLength(3);
  });

  it("uses live recent-use ranks for /use and /switch without a list or after an old list", async () => {
    const { bot, sent, registry } = createHarness();
    await createThreeIdleSessions(bot, sent);
    await bot.handleUpdate(textUpdate(20, "/use 3"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-1");
    await bot.handleUpdate(textUpdate(21, "/sessions"));
    expect(sent.at(-1)).toContain("Order: recently used");
    await bot.handleUpdate(textUpdate(22, "/use 3"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-2");
    await bot.handleUpdate(textUpdate(23, "/switch 2"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-1");
  });

  it("uses canonical creation dates and navigates older and newer without reshuffling", async () => {
    const { bot, sent, registry } = createHarness();
    await createThreeIdleSessions(bot, sent);
    codexThreads.set("thread-1", threadRecord("thread-1", "Oldest", 1000, Date.now() + 10000));
    codexThreads.set("thread-2", threadRecord("thread-2", "Middle", 2000, 2000));
    codexThreads.set("thread-3", threadRecord("thread-3", "Newest", 3000, 1000));
    await bot.handleUpdate(textUpdate(20, "/sessionorder created"));
    await bot.handleUpdate(textUpdate(21, "/prev"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-2");
    await bot.handleUpdate(textUpdate(22, "/previous"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-1");
    await bot.handleUpdate(textUpdate(23, "/prev"));
    expect(sent.at(-1)).toContain("no older session");
    await bot.handleUpdate(textUpdate(24, "/next"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-2");
    await bot.handleUpdate(textUpdate(25, "/sessions"));
    const lines = sent.at(-1)!.split("\n");
    expect(lines.find((line) => line.startsWith("1."))).toContain("Newest");
    expect(lines.find((line) => line.startsWith("2."))).toContain("selected");
    expect(lines.find((line) => line.startsWith("3."))).toContain("Oldest");
    await bot.handleUpdate(textUpdate(26, "/switch 3"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-1");
    await bot.handleUpdate(textUpdate(27, "/sessionorder used"));
    await bot.handleUpdate(textUpdate(28, "/prev"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-2");
  });

  it("restores the saved ordering and recent selections when the bot is recreated", async () => {
    const first = createHarness();
    await createThreeIdleSessions(first.bot, first.sent);
    codexThreads.set("thread-1", threadRecord("thread-1", "Oldest", 1000));
    codexThreads.set("thread-2", threadRecord("thread-2", "Middle", 2000));
    codexThreads.set("thread-3", threadRecord("thread-3", "Newest", 3000));
    await first.bot.handleUpdate(textUpdate(20, "/sessionorder created"));
    await first.bot.handleUpdate(textUpdate(21, "/use 2"));
    await first.bot.disposeProviders();
    const restored = createHarness();
    await restored.bot.handleUpdate(textUpdate(22, "/sessionorder"));
    expect(restored.sent.at(-1)).toContain("recently created");
    await restored.bot.handleUpdate(textUpdate(23, "/prev"));
    expect(restored.registry.get("123")?.getInfo().threadId).toBe("thread-1");
    await restored.bot.handleUpdate(textUpdate(24, "/sessionorder used"));
    await restored.bot.handleUpdate(textUpdate(25, "/prev"));
    expect(restored.registry.get("123")?.getInfo().threadId).toBe("thread-2");
  });

  it("opens successive search results with /use and /switch, then /prev returns to normal ranks", async () => {
    const { bot, sent, registry } = createHarness();
    await createThreeIdleSessions(bot, sent);
    searchState.hits.push(searchHit("receipt-A", "Receipt A"), searchHit("receipt-B", "Receipt B"));
    await bot.handleUpdate(textUpdate(20, "/find kwitantie"));
    await bot.handleUpdate(textUpdate(21, "/use 1"));
    expect(registry.get("123")?.getInfo().threadId).toBe("receipt-A");
    await bot.handleUpdate(textUpdate(22, "/switch 2"));
    expect(registry.get("123")?.getInfo().threadId).toBe("receipt-B");
    await bot.handleUpdate(textUpdate(23, "/prev"));
    expect(registry.get("123")?.getInfo().threadId).toBe("receipt-A");
    await bot.handleUpdate(textUpdate(24, "/use 2"));
    expect(registry.get("123")?.getInfo().threadId).toBe("receipt-B");
  });

  it("returns to normal numbered ranks when work resumes after a search", async () => {
    const { bot, sent, registry } = createHarness();
    await createThreeIdleSessions(bot, sent);
    searchState.hits.push(searchHit("receipt-A", "Receipt A"), searchHit("receipt-B", "Receipt B"));
    await bot.handleUpdate(textUpdate(20, "/find kwitantie"));
    await bot.handleUpdate(textUpdate(21, "/use 1"));
    await bot.handleUpdate(textUpdate(22, "quick four"));
    await waitFor(() => sent.includes("FINAL quick four"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await bot.handleUpdate(textUpdate(23, "/use 2"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-3");
  });

  it("resolves IDs outside search results while preserving numbered search selections", async () => {
    const { bot, sent, registry } = createHarness();
    await createThreeIdleSessions(bot, sent);
    searchState.hits.push(searchHit("receipt-A", "Receipt A"), searchHit("receipt-B", "Receipt B"));
    await bot.handleUpdate(textUpdate(20, "/find kwitantie"));
    await bot.handleUpdate(textUpdate(21, "/switch thread-1"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-1");
    await bot.handleUpdate(textUpdate(22, "/use 2"));
    expect(registry.get("123")?.getInfo().threadId).toBe("receipt-B");
  });

  it("clears search numbering when /use previous resumes ordinary navigation", async () => {
    const { bot, sent, registry } = createHarness();
    await createThreeIdleSessions(bot, sent);
    searchState.hits.push(searchHit("receipt-A", "Receipt A"), searchHit("receipt-B", "Receipt B"));
    await bot.handleUpdate(textUpdate(20, "/find kwitantie"));
    await bot.handleUpdate(textUpdate(21, "/use 1"));
    await bot.handleUpdate(textUpdate(22, "/use previous"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-3");
    await bot.handleUpdate(textUpdate(23, "/use 3"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-2");
  });

  it.each(["/sessions", "/sessionorder used", "/codex"])("clears search numbering after %s", async (command) => {
    const { bot, sent, registry } = createHarness();
    await createThreeIdleSessions(bot, sent);
    searchState.hits.push(searchHit("receipt-A", "Receipt A"), searchHit("receipt-B", "Receipt B"));
    await bot.handleUpdate(textUpdate(20, "/find kwitantie"));
    await bot.handleUpdate(textUpdate(21, command));
    await bot.handleUpdate(textUpdate(22, "/switch 2"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-2");
  });

  it("keeps the running turn going after /use and delivers its answer with the session named", async () => {
    const { bot, sent } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);

    await bot.handleUpdate(textUpdate(10, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("keeps running")));
    expect(sent.find((text) => text.includes("keeps running"))).toMatch(/^Background Codex, session 2 /);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1].threadId).toBe("thread-1");

    // The lane is free: the selected session runs a turn of its own meanwhile.
    await bot.handleUpdate(textUpdate(11, "quick two"));
    await waitFor(() => sent.includes("FINAL quick two"));
    expect(runtimes[1].prompts).toEqual(["quick two"]);

    holds.get("hold A")!();
    await waitFor(() => sent.some((text) => text.includes("FINAL hold A")));
    const finished = sent.find((text) => text.includes("FINAL hold A"))!;
    expect(finished).toMatch(/^Background Codex, session \d+ .*, finished after /);
    await waitFor(() => runtimes[0].dispose.mock.calls.length === 1);
    expect(runtimes[1].dispose).not.toHaveBeenCalled();
  });

  it("refuses the switch at the parallel turn limit", async () => {
    const { bot, sent } = createHarness({ codexMaxParallelTurns: 1 });
    await startHeldTurnInSecondSession(bot, sent);

    await bot.handleUpdate(textUpdate(10, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("the limit is 1")));
    expect(runtimes).toHaveLength(1);
    holds.get("hold A")!();
    await waitFor(() => sent.includes("FINAL hold A"));
  });

  it("keeps the running session selected when /find then /use 1 cannot reopen the result", async () => {
    const { bot, sent, registry } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);
    const running = registry.get("123");
    searchState.hits.push(searchHit("thread-1", "Receipt document"));
    await bot.handleUpdate(textUpdate(9, "/find kwitantie"));
    expect(searchState.queries).toEqual(["kwitantie"]);
    expect(sent.at(-1)).toContain("1. Codex");
    resumeFailures.set("thread-1", "thread/resume failed (-32600): thread thread-1 already has an active writer");

    await bot.handleUpdate(textUpdate(10, "/use 1"));
    expect(sent.at(-1)).toContain("Could not open");
    expect(sent.at(-1)).toContain("already has an active writer");
    expect(sent.at(-1)).toContain("previous session is still selected");
    expect(registry.get("123")).toBe(running);
    expect(running?.isProcessing()).toBe(true);
    expect(runtimes[0].aborted).toBe(false);
    expect(runtimes[0].dispose).not.toHaveBeenCalled();
    expect(runtimes[1].dispose).toHaveBeenCalledOnce();
    const state = JSON.parse(readFileSync(path.join(workspaceDir, ".telecode", "agent-sessions.json"), "utf8"));
    const selected = state.sessions.find((session: { id: string }) => session.id === state.lanes[0].selectedSessionId);
    expect(selected.providerSessionId).toBe("thread-2");
    expect(selected.status).toBe("running");
    expect(registry.listContexts()[0].threadId).toBe("thread-2");

    holds.get("hold A")!();
    await waitFor(() => sent.includes("FINAL hold A"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await bot.handleUpdate(textUpdate(11, "quick next"));
    await waitFor(() => sent.includes("FINAL quick next"));
    expect(runtimes[0].threadId).toBe("thread-2");
    expect(runtimes[0].prompts).toEqual(["quick one", "hold A", "quick next"]);
  });

  it("keeps an idle session selected when opening a search result fails", async () => {
    const { bot, sent, registry } = createHarness();
    await bot.handleUpdate(textUpdate(1, "quick one"));
    await waitFor(() => sent.includes("FINAL quick one"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    searchState.hits.push(searchHit("receipt-thread", "Receipt document"));
    await bot.handleUpdate(textUpdate(2, "/find kwitantie"));
    resumeFailures.set("receipt-thread", "receipt session is locked");
    await bot.handleUpdate(textUpdate(3, "/use 1"));
    expect(sent.at(-1)).toContain("Could not open");
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-1");
    const state = JSON.parse(readFileSync(path.join(workspaceDir, ".telecode", "agent-sessions.json"), "utf8"));
    expect(state.sessions.find((session: { id: string }) => session.id === state.lanes[0].selectedSessionId).providerSessionId)
      .toBe("thread-1");
    await bot.handleUpdate(textUpdate(4, "quick next"));
    await waitFor(() => sent.includes("FINAL quick next"));
    expect(runtimes).toHaveLength(1);
  });

  it("preserves search result numbers when a nonmatching running turn moves to the background", async () => {
    const { bot, sent, registry } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);
    searchState.hits.push(searchHit("thread-1", "Receipt document"), searchHit("other-receipt", "Another receipt"));
    await bot.handleUpdate(textUpdate(9, "/find kwitantie"));
    await bot.handleUpdate(textUpdate(10, "/use 1"));
    expect(registry.get("123")?.getInfo().threadId).toBe("thread-1");
    expect(runtimes[0].processing).toBe(true);
    await bot.handleUpdate(textUpdate(11, "/use 2"));
    expect(registry.get("123")?.getInfo().threadId).toBe("other-receipt");
    holds.get("hold A")!();
    await waitFor(() => sent.some((text) => text.includes("FINAL hold A")));
  });

  it("preserves search result numbers when a nonmatching background turn finishes", async () => {
    const { bot, sent, registry } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);
    await bot.handleUpdate(textUpdate(9, "/use previous"));
    searchState.hits.push(searchHit("thread-1", "Receipt document"), searchHit("other-receipt", "Another receipt"));
    await bot.handleUpdate(textUpdate(10, "/find kwitantie"));
    holds.get("hold A")!();
    await waitFor(() => sent.some((text) => text.includes("FINAL hold A")));
    await bot.handleUpdate(textUpdate(11, "/use 2"));
    expect(registry.get("123")?.getInfo().threadId).toBe("other-receipt");
  });

  it("identifies the selected running conversation in search results and reuses its runtime", async () => {
    const { bot, sent, registry } = createHarness();
    await bot.handleUpdate(textUpdate(1, "hold A"));
    await waitFor(() => holds.has("hold A"));
    searchState.hits.push(searchHit("thread-1", "Saxo recovery"));
    await bot.handleUpdate(textUpdate(2, "/find saxo"));
    expect(sent.at(-1)).toContain("1. Codex, selected, running");
    await bot.handleUpdate(textUpdate(3, "/use 1"));
    expect(runtimes).toHaveLength(1);
    expect(registry.get("123")).toBe(runtimes[0]);
    expect(runtimes[0].processing).toBe(true);
    holds.get("hold A")!();
    await waitFor(() => sent.includes("FINAL hold A"));
  });

  it("reconnects a search result to its running background process", async () => {
    const { bot, sent, registry } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);
    await bot.handleUpdate(textUpdate(10, "/use previous"));
    searchState.hits.push(searchHit("thread-2", "Saxo recovery"));
    await bot.handleUpdate(textUpdate(11, "/find saxo"));
    expect(sent.at(-1)).toContain("1. Codex, running");
    // A second writer would fail, so only adopting the existing runtime works.
    resumeFailures.set("thread-2", "thread-2 already has an active writer");
    await bot.handleUpdate(textUpdate(12, "/use 1"));
    expect(sent.at(-1)).toContain("This session is still working");
    expect(runtimes).toHaveLength(2);
    expect(registry.get("123")).toBe(runtimes[0]);
    expect(runtimes[0].processing).toBe(true);
    expect(runtimes[0].dispose).not.toHaveBeenCalled();
    expect(runtimes[1].dispose).toHaveBeenCalledOnce();
    holds.get("hold A")!();
    await waitFor(() => sent.includes("FINAL hold A"));
    expect(sent.some((text) => text.includes("finished after"))).toBe(false);
  });

  it("keeps another Codex session's commentary and plan quiet until replay", async () => {
    const { bot, sent } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);
    const background = runtimes[0];
    await bot.handleUpdate(textUpdate(10, "/use previous"));
    background.callbacks!.onTextDelta("CODEX_HIDDEN_INTERIM", { phase: "commentary" });
    background.callbacks!.onToolStart("Read", "background-read");
    background.callbacks!.onTodoUpdate?.([{ text: "CODEX_HIDDEN_PLAN", completed: false }]);
    holds.get("hold A")!();
    await waitFor(() => sent.some((text) => text.includes("FINAL hold A")));
    expect(sent.join("\n")).not.toContain("CODEX_HIDDEN_INTERIM");
    expect(sent.join("\n")).not.toContain("CODEX_HIDDEN_PLAN");
    await bot.handleUpdate(textUpdate(11, "/use thread-2"));
    await bot.handleUpdate(textUpdate(12, "/replay all"));
    expect(sent.join("\n")).toContain("CODEX_HIDDEN_INTERIM");
    expect(sent.join("\n")).toContain("CODEX_HIDDEN_PLAN");
    expect(sent.filter((text) => text.includes("FINAL hold A"))).toHaveLength(1);
  });

  it("uses the current native title for a completion after switching providers", async () => {
    const manager = new AgentSessionManager();
    const saved = manager.createSession("123", "codex", {
      workspace: workspaceDir, providerSessionId: "thread-1", displayName: "Continue the DJ pro work",
    });
    mkdirSync(path.join(workspaceDir, ".telecode"), { recursive: true });
    writeFileSync(path.join(workspaceDir, ".telecode", "agent-sessions.json"), JSON.stringify(manager.serialize()));
    codexThreads.set("thread-1", threadRecord("thread-1", "TeleCode parallel sessions"));
    const { bot, sent, registry } = createHarness();
    await bot.handleUpdate(textUpdate(1, "hold A"));
    await waitFor(() => holds.has("hold A"));
    // A native rename may happen while the answer is still being generated.
    codexThreads.set("thread-1", threadRecord("thread-1", "TeleCode routing fix"));
    registry.setActiveProvider("123", "claude");
    holds.get("hold A")!();
    await waitFor(() => sent.some((text) => text.includes("finished in background")));
    const answer = sent.find((text) => text.includes("finished in background"))!;
    expect(answer).toContain("TeleCode routing fix");
    expect(answer).not.toContain("DJ pro");
    expect(answer).toContain("FINAL hold A");
    const state = JSON.parse(readFileSync(path.join(workspaceDir, ".telecode", "agent-sessions.json"), "utf8"));
    expect(state.sessions.find((session: { id: string }) => session.id === saved.id)?.displayName)
      .toBe("TeleCode routing fix");
  });

  it("keeps the title shown by /sessions when the native database becomes unavailable", async () => {
    const manager = new AgentSessionManager();
    manager.createSession("123", "codex", {
      workspace: workspaceDir, providerSessionId: "thread-2", displayName: "Continue the DJ pro work",
    });
    mkdirSync(path.join(workspaceDir, ".telecode"), { recursive: true });
    writeFileSync(path.join(workspaceDir, ".telecode", "agent-sessions.json"), JSON.stringify(manager.serialize()));
    const { bot, sent } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);
    codexThreads.set("thread-2", threadRecord("thread-2", "TeleCode background routing"));
    await bot.handleUpdate(textUpdate(9, "/sessions"));
    expect(sent.at(-1)).toContain("TeleCode background routing");
    await bot.handleUpdate(textUpdate(10, "/use previous"));
    codexThreads.clear();
    holds.get("hold A")!();
    await waitFor(() => sent.some((text) => text.includes("FINAL hold A")));
    expect(sent.find((text) => text.includes("FINAL hold A"))).toContain('"TeleCode background routing"');
  });

  it("picks the running turn back up when switching back to it", async () => {
    const { bot, sent } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);

    await bot.handleUpdate(textUpdate(10, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("keeps running")));
    await bot.handleUpdate(textUpdate(11, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("This session is still working")));
    expect(runtimes[1].dispose).toHaveBeenCalled();

    holds.get("hold A")!();
    await waitFor(() => sent.includes("FINAL hold A"));
    expect(sent.some((text) => text.includes("finished after"))).toBe(false);
    expect(runtimes[0].dispose).not.toHaveBeenCalled();

    // The adopted runtime is the lane's again.
    await bot.handleUpdate(textUpdate(12, "quick three"));
    await waitFor(() => sent.includes("FINAL quick three"));
    expect(runtimes[0].prompts).toContain("quick three");
  });

  it("stops a background turn by its session with /stop", async () => {
    const { bot, sent } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);

    await bot.handleUpdate(textUpdate(10, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("keeps running")));
    await bot.handleUpdate(textUpdate(11, "/stop previous"));
    await waitFor(() => sent.some((text) => text.startsWith("Stop sent to Background Codex")));
    await waitFor(() => sent.some((text) => /^Background Codex.*, stopped after /.test(text)));
    expect(runtimes[0].aborted).toBe(true);
    expect(runtimes[1].aborted).toBe(false);
    await waitFor(() => runtimes[0].dispose.mock.calls.length === 1);
  });

  it("keeps the running turn going when /new starts a fresh session", async () => {
    const { bot, sent } = createHarness();
    await bot.handleUpdate(textUpdate(1, "hold A"));
    await waitFor(() => holds.has("hold A"));

    await bot.handleUpdate(textUpdate(2, "/new"));
    await waitFor(() => sent.some((text) => text.includes("New Codex session ready")));
    const reply = sent.find((text) => text.includes("New Codex session ready"))!;
    expect(reply).toMatch(/^Background Codex, session \d+ .* keeps running/);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1].threadId).toBeNull();

    await bot.handleUpdate(textUpdate(3, "quick two"));
    await waitFor(() => sent.includes("FINAL quick two"));
    expect(runtimes[1].prompts).toEqual(["quick two"]);
    expect(runtimes[1].threadId).not.toBe(runtimes[0].threadId);

    holds.get("hold A")!();
    await waitFor(() => sent.some((text) => /^Background Codex.*, finished after [\s\S]*FINAL hold A/.test(text)));
  });

  it("isolates parallel efforts and inherits the selected runtime rather than the last background completion", async () => {
    const { bot, sent, registry } = createHarness();
    await bot.handleUpdate(textUpdate(1, "/effort max"));
    await bot.handleUpdate(textUpdate(2, "hold A"));
    await waitFor(() => holds.has("hold A"));
    await bot.handleUpdate(textUpdate(3, "/new"));
    expect(runtimes[1].reasoningEffort).toBe("max");
    await bot.handleUpdate(textUpdate(4, "/effort medium"));
    await bot.handleUpdate(textUpdate(5, "hold B"));
    await waitFor(() => holds.has("hold B"));
    expect(runtimes[0].promptEfforts).toEqual(["max"]);
    expect(runtimes[1].promptEfforts).toEqual(["medium"]);

    await bot.handleUpdate(textUpdate(6, "/effort high"));
    expect(sent.at(-1)).toContain("Cannot change effort while a prompt is running");
    expect(runtimes[1].reasoningEffort).toBe("medium");
    await bot.handleUpdate(textUpdate(7, "/use thread-1"));
    expect(registry.get("123")).toBe(runtimes[0]);
    await bot.handleUpdate(textUpdate(8, "/new"));
    expect(runtimes[2].reasoningEffort).toBe("max");
    await bot.handleUpdate(textUpdate(9, "/effort high"));
    expect(runtimes.map((runtime) => runtime.reasoningEffort)).toEqual(["max", "medium", "high"]);

    holds.get("hold B")!();
    await waitFor(() => sent.some((text) => text.includes("FINAL hold B")));
    holds.get("hold A")!();
    await waitFor(() => sent.some((text) => text.includes("FINAL hold A")));
    await waitFor(() => runtimes[0].dispose.mock.calls.length === 1 && runtimes[1].dispose.mock.calls.length === 1);
    expect(registry.listContexts()[0].reasoningEffort).toBe("high");
    await bot.handleUpdate(textUpdate(10, "/new"));
    expect(registry.get("123")?.getInfo().reasoningEffort).toBe("high");
  });

  it("moves a running goal to the background and reports it when the goal completes", async () => {
    const { bot, sent } = createHarness();
    await startHeldGoalInSecondSession(bot, sent);

    await bot.handleUpdate(textUpdate(10, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("keeps running")));
    expect(runtimes).toHaveLength(2);

    holds.get("hold G")!();
    await waitFor(() => sent.some((text) => text.includes("FINAL goal hold G")));
    const finished = sent.find((text) => text.includes("FINAL goal hold G"))!;
    expect(finished).toMatch(/^Background Codex, session \d+ .*, finished after /);
    await waitFor(() => runtimes[0].dispose.mock.calls.length === 1);
  });

  it("brings a background goal back with /use, where /goal status sees it running", async () => {
    const { bot, sent } = createHarness();
    await startHeldGoalInSecondSession(bot, sent);

    await bot.handleUpdate(textUpdate(10, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("keeps running")));
    await bot.handleUpdate(textUpdate(11, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("This session is still working")));

    const before = sent.length;
    await bot.handleUpdate(textUpdate(12, "/goal"));
    await waitFor(() => sent.length > before);
    expect(sent.at(-1)).not.toContain("not currently attached");
    expect(sent.at(-1)).toContain("hold G");

    holds.get("hold G")!();
    await waitFor(() => sent.some((text) => text.includes("FINAL goal hold G")));
    expect(sent.some((text) => text.includes("finished after"))).toBe(false);
  });

  it("pauses a background goal with /stop and reports it stopped", async () => {
    const { bot, sent } = createHarness();
    await startHeldGoalInSecondSession(bot, sent);

    await bot.handleUpdate(textUpdate(10, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("keeps running")));
    await bot.handleUpdate(textUpdate(11, "/stop previous"));
    await waitFor(() => sent.some((text) => text.startsWith("Stop sent to Background Codex")));
    await waitFor(() => sent.some((text) => /^Background Codex.*, stopped after /.test(text)));
    expect(runtimes[0].pauseActiveGoal).toHaveBeenCalled();
    expect(runtimes[0].aborted).toBe(false);
    expect(runtimes[0].goal?.status).toBe("paused");
    await waitFor(() => runtimes[0].dispose.mock.calls.length === 1);
  });
});

function threadRecord(id: string, title: string, createdAt = 1000, updatedAt = 2000): CodexThreadRecord {
  return {
    id, title, cwd: workspaceDir, model: "gpt-5.5",
    createdAt: new Date(createdAt), updatedAt: new Date(updatedAt), firstUserMessage: "Continue the DJ pro work",
  };
}

function searchHit(sessionId: string, title: string): SessionSearchHit {
  return {
    provider: "codex", sessionId, title, workspace: workspaceDir,
    filePath: path.join(workspaceDir, `${sessionId}.jsonl`),
    updatedAt: Date.now(), snippet: "kwitantie, receipt document",
  };
}

async function createThreeIdleSessions(bot: ReturnType<typeof createBot>, sent: string[]): Promise<void> {
  for (const [index, word] of ["one", "two", "three"].entries()) {
    if (index > 0) {
      await bot.handleUpdate(textUpdate(index * 2, "/new"));
    }
    await bot.handleUpdate(textUpdate(index * 2 + 1, `quick ${word}`));
    await waitFor(() => sent.includes(`FINAL quick ${word}`));
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Like startHeldTurnInSecondSession, but session 2 runs a goal that holds. */
async function startHeldGoalInSecondSession(bot: ReturnType<typeof createBot>, sent: string[]): Promise<void> {
  await bot.handleUpdate(textUpdate(1, "quick one"));
  await waitFor(() => sent.includes("FINAL quick one"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const beforeNew = sent.length;
  await bot.handleUpdate(textUpdate(2, "/new"));
  await waitFor(() => sent.length > beforeNew);
  await bot.handleUpdate(textUpdate(3, "/goal hold G"));
  await waitFor(() => holds.has("hold G"));
}

/**
 * Session 1 ("thread-1") runs a quick turn, /new opens session 2, and session 2
 * starts a turn that holds until released. /use previous then targets session 1.
 */
async function startHeldTurnInSecondSession(bot: ReturnType<typeof createBot>, sent: string[]): Promise<void> {
  await bot.handleUpdate(textUpdate(1, "quick one"));
  await waitFor(() => sent.includes("FINAL quick one"));
  // Let the finished turn release the lane before /new.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const beforeNew = sent.length;
  await bot.handleUpdate(textUpdate(2, "/new"));
  await waitFor(() => sent.length > beforeNew);
  await bot.handleUpdate(textUpdate(3, "hold A"));
  await waitFor(() => holds.has("hold A"));
}

function createHarness(overrides: Partial<TeleCodeConfig> = {}) {
  const config = { ...createConfig(workspaceDir), ...overrides };
  const registry = new SessionRegistry(config);
  const bot = createBot(config, registry);
  const sent: string[] = [];
  debugSent = sent;
  let messageId = 1;
  bot.api.config.use(async (_prev, method, payload: { text?: string }) => {
    if (method === "sendMessage") {
      sent.push(payload.text ?? "");
      return { ok: true, result: textMessage(messageId++, payload.text ?? "") };
    }
    if (
      method === "sendChatAction" ||
      method === "setMessageReaction" ||
      method === "editMessageText" ||
      method === "editMessageReplyMarkup"
    ) {
      return { ok: true, result: true };
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
    enableClaudeProvider: false,
    claudeBin: "claude.exe",
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for condition. Sent: ${JSON.stringify(debugSent)}`);
}
