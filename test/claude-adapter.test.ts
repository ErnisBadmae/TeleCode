import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TeleCodeConfig } from "../src/config.js";
import { ClaudeProviderAdapter } from "../src/providers/claude-adapter.js";
import {
  ClaudeSdkInputController,
  ParkedQuery,
  runClaudeSdkTurn,
  type SdkMessageLike,
} from "../src/providers/claude-sdk-engine.js";
import type { AgentProviderEvent } from "../src/providers/types.js";

vi.mock("../src/providers/claude-sdk-engine.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/providers/claude-sdk-engine.js")>(),
  runClaudeSdkTurn: vi.fn(),
}));

async function consume(events: AsyncIterable<AgentProviderEvent>): Promise<void> {
  for await (const _event of events) { /* Drive the provider through turn cleanup. */ }
}

describe("Claude runtime adoption", () => {
  let workspace: string;
  let adapter: ClaudeProviderAdapter;
  let config: TeleCodeConfig;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "telecode-claude-adapter-"));
    config = {
      workspace,
      enableClaudeProvider: true,
      claudeWorkspace: workspace,
      claudeBackend: "sdk",
      claudeDefaultModel: "sonnet",
      claudePermissionMode: "bypassPermissions",
      claudeTurnIdleTimeoutSeconds: 180,
      claudeAutoCompactWindow: 200000,
      claudeBin: "C:\\native\\claude.exe",
    } as TeleCodeConfig;
    adapter = new ClaudeProviderAdapter(config);
    vi.mocked(runClaudeSdkTurn).mockReset();
  });

  afterEach(async () => {
    await adapter.dispose();
    rmSync(workspace, { recursive: true, force: true });
  });

  it.each([undefined, "C:\\pinned\\claude.exe"])("keeps the SDK executable separate from the native CLI, override=%s", async (override) => {
    config.claudeSdkBin = override;
    vi.mocked(runClaudeSdkTurn).mockImplementation(async function* (options) {
      yield { type: "assistant_message_complete", sessionId: options.sessionId, jobId: options.jobId, text: "ANSWER" };
    });
    const created = await adapter.createSession({ workspace });
    await consume(adapter.sendPrompt({ sessionId: created.id, jobId: "sdk-bin", input: { text: "hello" } }));
    expect(vi.mocked(runClaudeSdkTurn).mock.calls[0]?.[0].claudeBin).toBe(override);
  });

  it.each([false, true])("reuses the original parked runtime after the CLI changes its session id, active=%s", async (active) => {
    const realSessionId = "real-provider-session-123";
    const stream: AsyncIterable<SdkMessageLike> = {
      async *[Symbol.asyncIterator]() {},
    };
    const parked = new ParkedQuery(stream, new ClaudeSdkInputController());
    vi.mocked(runClaudeSdkTurn).mockImplementation(async function* (options) {
      options.onProviderSessionId?.(realSessionId);
      yield { type: "assistant_message_complete", sessionId: options.sessionId, jobId: options.jobId, text: "ANSWER" };
      options.onParkStateChanged?.(true, parked);
    });
    const created = await adapter.createSession({ workspace });
    await consume(adapter.sendPrompt({ sessionId: created.id, jobId: "first", input: { text: "hello" } }));
    parked.setActive(active);
    const descriptor = await adapter.getSessionInfo(created.id);
    const resumed = await adapter.resumeSession({
      ...descriptor,
      id: `claude-${realSessionId.slice(0, 12)}`,
      displayName: "Selected again",
    });

    expect(resumed.id).toBe(created.id);
    expect(resumed.displayName).toBe("Selected again");
    expect(adapter.isParked(resumed.id)).toBe(true);
    await consume(adapter.sendPrompt({ sessionId: resumed.id, jobId: "next", input: { text: "follow-up" } }));
    expect(vi.mocked(runClaudeSdkTurn).mock.calls[1]?.[0].adoptedQuery).toBe(parked);
  });
});
