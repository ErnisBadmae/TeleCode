import {
  CLAUDE_PERMISSION_CALLBACK,
  formatPermissionOutcome,
  formatPermissionPrompt,
  permissionCallbackData,
  PermissionPromptRegistry,
} from "../src/claude-permission-prompt.js";
import { runClaudeSdkTurn, sdkCanUseTool, type SdkMessageLike } from "../src/providers/claude-sdk-engine.js";
import type { AgentPermissionDecision, AgentPermissionRequest } from "../src/providers/types.js";

function permissionRequest(overrides: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  return {
    toolName: "PowerShell",
    input: { command: "python script.py --list-dialogs" },
    canAllowAlways: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("claude permission prompt registry", () => {
  it("resolves with the pressed button and reports the outcome once", async () => {
    const registry = new PermissionPromptRegistry(60_000);
    let shownId = "";
    const settled: Array<[AgentPermissionDecision, string]> = [];
    const decision = registry.request(
      permissionRequest(),
      async (id) => {
        shownId = id;
      },
      async (value, reason) => {
        settled.push([value, reason]);
      },
    );
    await Promise.resolve();
    expect(permissionCallbackData("a", shownId)).toMatch(CLAUDE_PERMISSION_CALLBACK);
    expect(registry.answer(shownId, "a")).toBe("allow");
    await expect(decision).resolves.toBe("allow");
    expect(registry.answer(shownId, "d")).toBeUndefined();
    expect(settled).toEqual([["allow", "answered"]]);
    expect(registry.size).toBe(0);
  });

  it("denies on timeout, on turn abort, and when the prompt cannot be shown", async () => {
    const registry = new PermissionPromptRegistry(20);
    const reasons: string[] = [];
    const settle = async (_: AgentPermissionDecision, reason: string): Promise<void> => {
      reasons.push(reason);
    };

    await expect(registry.request(permissionRequest(), async () => {}, settle)).resolves.toBe("deny");

    const abort = new AbortController();
    const aborted = registry.request(permissionRequest({ signal: abort.signal }), async () => {}, settle);
    abort.abort();
    await expect(aborted).resolves.toBe("deny");

    await expect(registry.request(permissionRequest(), async () => {
      throw new Error("telegram down");
    }, settle)).resolves.toBe("deny");

    expect(reasons).toEqual(["timeout", "aborted", "failed"]);
    expect(registry.size).toBe(0);
  });

  it("ignores unknown ids and codes", () => {
    const registry = new PermissionPromptRegistry(60_000);
    expect(registry.answer("000000000000", "a")).toBeUndefined();
    expect("cperm:x:000000000000").not.toMatch(CLAUDE_PERMISSION_CALLBACK);
  });

  it("formats the command and escapes HTML", () => {
    const prompt = formatPermissionPrompt(permissionRequest({
      title: "Claude wants to run <script>",
      input: { command: "echo a && b" },
      blockedPath: "C:\\Users",
    }));
    expect(prompt.html).toContain("<b>Claude wants to run &lt;script&gt;</b>");
    expect(prompt.html).toContain("<pre>echo a &amp;&amp; b</pre>");
    expect(prompt.plain).toContain("Path: C:\\Users");
    expect(formatPermissionOutcome("deny", "timeout", 15)).toContain("15 min");
    expect(formatPermissionOutcome("allow_always", "answered", 15)).toContain("Always allowed");
  });
});

describe("claude sdk canUseTool bridge", () => {
  const sdkOptions = (suggestions?: unknown[]) => ({
    signal: new AbortController().signal,
    toolUseID: "tool-1",
    ...(suggestions ? { suggestions } : {}),
  });

  it("maps decisions to SDK permission results", async () => {
    const suggestion = { type: "addRules", rules: [{ toolName: "PowerShell" }], behavior: "allow", destination: "localSettings" };
    const always = sdkCanUseTool(async () => "allow_always");
    await expect(always("PowerShell", { command: "x" }, sdkOptions([suggestion]))).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "x" },
      updatedPermissions: [suggestion],
      toolUseID: "tool-1",
    });

    const once = sdkCanUseTool(async () => "allow");
    await expect(once("PowerShell", { command: "x" }, sdkOptions([suggestion]))).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "x" },
      toolUseID: "tool-1",
    });

    const deny = sdkCanUseTool(async () => "deny");
    await expect(deny("PowerShell", {}, sdkOptions())).resolves.toMatchObject({ behavior: "deny" });

    const failing = sdkCanUseTool(async () => {
      throw new Error("boom");
    });
    await expect(failing("PowerShell", {}, sdkOptions())).resolves.toMatchObject({ behavior: "deny" });
  });

  it("passes the question to the handler with the request details", async () => {
    let seen: AgentPermissionRequest | undefined;
    const canUseTool = sdkCanUseTool(async (request) => {
      seen = request;
      return "allow";
    });
    await canUseTool("WebFetch", { url: "https://example.com" }, {
      ...sdkOptions(),
      title: "Claude wants to fetch example.com",
      blockedPath: "G:\\",
    });
    expect(seen).toMatchObject({
      toolName: "WebFetch",
      input: { url: "https://example.com" },
      title: "Claude wants to fetch example.com",
      blockedPath: "G:\\",
      canAllowAlways: false,
    });
  });

  it("sets canUseTool on the SDK query only when a handler is given", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const messages: SdkMessageLike[] = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "success", result: "ok", usage: {} },
    ];
    const queryFn = (input: { options: Record<string, unknown> }) => {
      seen.push(input.options);
      return (async function* () {
        yield* messages;
      })();
    };
    const base = {
      sessionId: "claude-provider-1",
      jobId: "job-1",
      promptText: "do the thing",
      cwd: "C:\\workspace",
      claudeBin: "C:\\claude.exe",
      permissionMode: "acceptEdits" as const,
      queryFn,
    };
    for await (const _ of runClaudeSdkTurn(base)) {
      // drain
    }
    for await (const _ of runClaudeSdkTurn({ ...base, onPermissionRequest: async () => "deny" })) {
      // drain
    }
    expect(seen[0]!.canUseTool).toBeUndefined();
    expect(typeof seen[1]!.canUseTool).toBe("function");
  });
});
