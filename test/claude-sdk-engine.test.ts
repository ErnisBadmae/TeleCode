import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaudeSdkInputController,
  recoverSdkContextFromTranscript,
  runClaudeSdkCompact,
  runClaudeSdkTurn,
  type SdkMessageLike,
  type SdkUserMessageLike,
} from "../src/providers/claude-sdk-engine.js";
import type { AgentProviderEvent } from "../src/providers/types.js";

function fakeQuery(messages: SdkMessageLike[]) {
  const seen: Array<{
    prompt: string | AsyncIterable<SdkUserMessageLike>;
    options: Record<string, unknown>;
  }> = [];
  const queryFn = (input: {
    prompt: string | AsyncIterable<SdkUserMessageLike>;
    options: Record<string, unknown>;
  }) => {
    seen.push(input);
    return (async function* () {
      for (const message of messages) {
        yield message;
      }
    })();
  };
  return { queryFn, seen };
}

async function collect(iterable: AsyncIterable<AgentProviderEvent>): Promise<AgentProviderEvent[]> {
  const events: AgentProviderEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

const baseOptions = {
  sessionId: "claude-provider-1",
  jobId: "job-1",
  promptText: "do the thing",
  cwd: "C:\\workspace",
  claudeBin: "C:\\claude.exe",
  model: "claude-sonnet-5",
  permissionMode: "bypassPermissions" as const,
};

describe("claude sdk engine", () => {
  it("maps every assistant text block to its own delta, in order (D3 fix)", async () => {
    const { queryFn } = fakeQuery([
      { type: "system", subtype: "init", session_id: "real-session-id" },
      { type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "text", text: "ALPHA" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo ok" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "BETA" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "GAMMA" }] } },
      {
        type: "result",
        subtype: "success",
        result: "GAMMA",
        usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 },
      },
    ]);

    const providerSessionIds: string[] = [];
    const events = await collect(runClaudeSdkTurn({
      ...baseOptions,
      queryFn,
      onProviderSessionId: (id) => providerSessionIds.push(id),
    }));

    expect(providerSessionIds).toEqual(["real-session-id"]);
    expect(events).toMatchObject([
      { type: "model_updated", model: "claude-sonnet-5" },
      { type: "assistant_text_delta", text: "ALPHA" },
      { type: "tool_started", toolName: "Bash" },
      { type: "tool_completed", toolName: "tool" },
      { type: "assistant_text_delta", text: "BETA" },
      { type: "assistant_text_delta", text: "GAMMA" },
      { type: "usage_updated", inputTokens: 10, cachedInputTokens: 105, outputTokens: 7 },
      { type: "assistant_message_complete", text: "GAMMA" },
    ]);
  });

  it("passes resume, strict mcp, parity options, and a scrubbed env to the SDK", async () => {
    const { queryFn, seen } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "success", result: "ok", usage: {} },
    ]);
    const previousAutoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const previousExperimentalFlag = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    process.env.TELEGRAM_BOT_TOKEN = "999:should-not-leak";
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "999999";
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    try {
      await collect(runClaudeSdkTurn({
        ...baseOptions,
        resume: "prior-session",
        autoCompactWindow: 200000,
        queryFn,
      }));
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
      if (previousAutoCompactWindow === undefined) {
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      } else {
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = previousAutoCompactWindow;
      }
      if (previousExperimentalFlag === undefined) {
        delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
      } else {
        process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = previousExperimentalFlag;
      }
    }

    const options = seen[0]!.options;
    expect(options.resume).toBe("prior-session");
    expect(options.forkSession).toBeUndefined();
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual(["user", "project"]);
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(options.pathToClaudeCodeExecutable).toBe("C:\\claude.exe");
    expect((options.env as Record<string, unknown>).TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect((options.env as Record<string, unknown>).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");
    expect((options.env as Record<string, unknown>).CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
    expect((options.env as Record<string, unknown>).DISABLE_AUTOUPDATER).toBe("1");
  });

  it("uses the SDK's bundled CLI when no SDK executable override is configured", async () => {
    const { queryFn, seen } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "success", result: "ok", usage: {} },
    ]);
    await collect(runClaudeSdkTurn({ ...baseOptions, claudeBin: undefined, queryFn }));
    expect(seen[0]!.options).not.toHaveProperty("pathToClaudeCodeExecutable");
    expect(seen[0]!.options.permissionMode).toBe("bypassPermissions");
    expect(seen[0]!.options.strictMcpConfig).toBe(true);
  });

  it("maps SDK compact boundaries during ordinary turns", async () => {
    const { queryFn } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "s",
        compact_metadata: {
          trigger: "auto",
          pre_tokens: 210000,
          post_tokens: 8500,
        },
      },
      { type: "result", subtype: "success", result: "continued", usage: {} },
    ]);

    const events = await collect(runClaudeSdkTurn({ ...baseOptions, queryFn }));

    expect(events).toContainEqual({
      type: "compact_boundary",
      sessionId: baseOptions.sessionId,
      summary: "Compacted: 210,000 -> 8,500 tokens",
      postTokens: 8500,
    });
  });

  it("surfaces SDK model fallbacks as immediate detailed status events", async () => {
    const { queryFn } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "system",
        subtype: "model_refusal_fallback",
        session_id: "s",
        original_model: "claude-fable-5-1",
        fallback_model: "claude-opus-4-8",
        api_refusal_category: "cyber",
        scope: "session",
        content: "Fable safeguards flagged this message.",
      },
      { type: "result", subtype: "success", result: "continued safely", usage: {} },
    ]);

    const events = await collect(runClaudeSdkTurn({ ...baseOptions, queryFn }));

    expect(events).toContainEqual({
      type: "status_message",
      sessionId: baseOptions.sessionId,
      jobId: baseOptions.jobId,
      text: "Claude model fallback: Fable 5.1 switched to Opus 4.8. Reason: cyber safeguards. This session will continue on Opus 4.8.",
      priority: true,
    });
  });

  it("runs native SDK compact in place and accepts its empty successful result", async () => {
    const { queryFn, seen } = fakeQuery([
      { type: "system", subtype: "init", session_id: "existing-session" },
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "existing-session",
        compact_metadata: {
          trigger: "manual",
          pre_tokens: 301000,
          post_tokens: 8200,
        },
      },
      { type: "result", subtype: "success", result: "", usage: {} },
    ]);

    const result = await runClaudeSdkCompact({
      cwd: baseOptions.cwd,
      claudeBin: baseOptions.claudeBin,
      model: baseOptions.model,
      permissionMode: baseOptions.permissionMode,
      resume: "existing-session",
      instructions: "preserve decisions and pending tests",
      autoCompactWindow: 200000,
      queryFn,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe("/compact preserve decisions and pending tests");
    expect(seen[0]?.options.resume).toBe("existing-session");
    expect(
      (seen[0]?.options.env as Record<string, unknown>).CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    ).toBe("200000");
    expect(result).toEqual({
      providerSessionId: "existing-session",
      preTokens: 301000,
      postTokens: 8200,
      trigger: "manual",
    });
  });

  it("rejects an SDK compact success that has no compact boundary", async () => {
    const { queryFn, seen } = fakeQuery([
      { type: "system", subtype: "init", session_id: "existing-session" },
      { type: "result", subtype: "success", result: "", usage: {} },
    ]);

    await expect(runClaudeSdkCompact({
      cwd: baseOptions.cwd,
      claudeBin: baseOptions.claudeBin,
      model: baseOptions.model,
      permissionMode: baseOptions.permissionMode,
      resume: "existing-session",
      queryFn,
    })).rejects.toThrow("without a compact boundary");
    expect(seen).toHaveLength(1);
  });

  it("passes forkSession alongside resume when forking", async () => {
    const { queryFn, seen } = fakeQuery([
      { type: "system", subtype: "init", session_id: "new-fork-id" },
      { type: "result", subtype: "success", result: "ok", usage: {} },
    ]);
    await collect(runClaudeSdkTurn({ ...baseOptions, resume: "source-session", forkSession: true, queryFn }));

    expect(seen[0]!.options.resume).toBe("source-session");
    expect(seen[0]!.options.forkSession).toBe(true);
  });

  it("uses one primary multi-turn input stream for the initial prompt and live steering", async () => {
    const inputController = new ClaudeSdkInputController();
    const streamedPrompts: SdkUserMessageLike[] = [];
    const seenPrompts: Array<string | AsyncIterable<SdkUserMessageLike>> = [];
    const queryFn = (input: {
      prompt: string | AsyncIterable<SdkUserMessageLike>;
      options: Record<string, unknown>;
    }) => {
      seenPrompts.push(input.prompt);
      let gotSteerResolve: (() => void) | undefined;
      const gotSteer = new Promise<void>((resolve) => {
        gotSteerResolve = resolve;
      });
      const consumeInput = (async () => {
        if (typeof input.prompt === "string") {
          return;
        }
        for await (const message of input.prompt) {
          streamedPrompts.push(message);
          if (streamedPrompts.length >= 2) {
            gotSteerResolve?.();
            return;
          }
        }
      })();
      // Keep the emulated SDK input consumer alive and make close harmless.
      const query = (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" } satisfies SdkMessageLike;
        await gotSteer;
        yield { type: "result", subtype: "success", result: "ok", usage: {} } satisfies SdkMessageLike;
        await consumeInput;
      })() as AsyncGenerator<SdkMessageLike> & { close: () => void };
      query.close = () => {};
      return query;
    };

    const eventsPromise = collect(runClaudeSdkTurn({ ...baseOptions, inputController, queryFn }));
    await waitUntil(() => seenPrompts.length === 1);
    inputController.push("steer this turn", "now");
    const events = await eventsPromise;

    expect(seenPrompts).toHaveLength(1);
    expect(typeof seenPrompts[0]).not.toBe("string");
    expect(streamedPrompts.map((message) => message.message.content[0]?.text)).toEqual([
      baseOptions.promptText,
      "steer this turn",
    ]);
    expect(streamedPrompts[0]?.priority).toBeUndefined();
    expect(streamedPrompts[1]?.priority).toBe("now");
    expect(events.some((event) => event.type === "assistant_message_complete")).toBe(true);
  });

  it("keeps the SDK query open for the continuation after a priority-now steer interrupts the first result", async () => {
    const inputController = new ClaudeSdkInputController();
    let releaseAfterSteer: (() => void) | undefined;
    let waitingForSteer = false;
    const afterSteer = new Promise<void>((resolve) => {
      releaseAfterSteer = resolve;
    });
    let queryCalls = 0;
    const queryFn = (input: {
      prompt: string | AsyncIterable<SdkUserMessageLike>;
      options: Record<string, unknown>;
    }) => {
      queryCalls += 1;
      void (async () => {
        if (typeof input.prompt === "string") {
          return;
        }
        let messageCount = 0;
        for await (const message of input.prompt) {
          messageCount += 1;
          if (messageCount === 2 && message.message.content[0]?.text === "new direction") {
            releaseAfterSteer?.();
            return;
          }
        }
      })();
      const query = (async function* () {
        yield { type: "system", subtype: "init", session_id: "steered-session" } satisfies SdkMessageLike;
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Progress before steer" }] },
        } satisfies SdkMessageLike;
        waitingForSteer = true;
        await afterSteer;
        // Claude emits this for the response interrupted by priority: now. It is
        // not the end of the SDK query and must not close the streaming input.
        yield { type: "result", subtype: "success", result: "", usage: {} } satisfies SdkMessageLike;
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "STEERED_FINAL" }] },
        } satisfies SdkMessageLike;
        yield { type: "result", subtype: "success", result: "STEERED_FINAL", usage: {} } satisfies SdkMessageLike;
      })();
      return query;
    };

    const eventsPromise = collect(runClaudeSdkTurn({
      ...baseOptions,
      inputController,
      queryFn,
    }));
    await waitUntil(() => queryCalls === 1 && waitingForSteer);
    inputController.push("new direction", "now");
    const events = await eventsPromise;

    expect(queryCalls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant_message_complete",
      text: "STEERED_FINAL",
    }));
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("emits quiet status while an SDK query is still waiting", async () => {
    const queryFn = () => (async function* () {
      yield { type: "system", subtype: "init", session_id: "quiet-session" } satisfies SdkMessageLike;
      await new Promise((resolve) => setTimeout(resolve, 35));
      yield { type: "result", subtype: "success", result: "done", usage: {} } satisfies SdkMessageLike;
    })();

    const events = await collect(runClaudeSdkTurn({
      ...baseOptions,
      quietStatusIntervalMs: 10,
      queryFn,
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "status_message",
      text: expect.stringMatching(/^Claude has been quiet for /u),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant_message_complete",
      text: "done",
    }));
  });

  it("retries an empty successful result once and resumes the real session id", async () => {
    const calls: Array<{
      prompt: string | AsyncIterable<SdkUserMessageLike>;
      options: Record<string, unknown>;
    }> = [];
    const queryFn = (input: {
      prompt: string | AsyncIterable<SdkUserMessageLike>;
      options: Record<string, unknown>;
    }) => {
      calls.push(input);
      const callNumber = calls.length;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "real-resumed-session" } satisfies SdkMessageLike;
        if (callNumber === 1) {
          yield { type: "result", subtype: "success", result: "", usage: {} } satisfies SdkMessageLike;
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Recovered answer" }] },
        } satisfies SdkMessageLike;
        yield { type: "result", subtype: "success", result: "Recovered answer", usage: {} } satisfies SdkMessageLike;
      })();
    };

    const events = await collect(runClaudeSdkTurn({
      ...baseOptions,
      resume: "old-session",
      inputController: new ClaudeSdkInputController(),
      queryFn,
    }));

    expect(calls).toHaveLength(2);
    expect(typeof calls[0]?.prompt).not.toBe("string");
    const firstAttemptPrompts: string[] = [];
    if (typeof calls[0]?.prompt !== "string") {
      for await (const message of calls[0]!.prompt) {
        firstAttemptPrompts.push(message.message.content[0]?.text ?? "");
      }
    }
    expect(firstAttemptPrompts[0]).toBe(baseOptions.promptText);
    expect(calls[1]?.options.resume).toBe("real-resumed-session");
    // The retry is still the same user-visible turn, so it keeps the live-input
    // iterable rather than degrading to a single-shot string prompt.
    expect(typeof calls[1]?.prompt).not.toBe("string");
    const retryPrompts: string[] = [];
    if (typeof calls[1]?.prompt !== "string") {
      for await (const message of calls[1]!.prompt) {
        retryPrompts.push(message.message.content[0]?.text ?? "");
      }
    }
    expect(retryPrompts[0]).toEqual(expect.stringContaining("previous turn ended successfully"));
    expect(events.some((event) => event.type === "status_message")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant_message_complete",
      text: "Recovered answer",
    }));
  });

  it("reads past an injected turn's silent result instead of tearing the query down", async () => {
    // Claude Code drains its own pending queue (background <task-notification>s,
    // the resume rescue prompt) before our prompt runs, and each of those
    // completes as its own successful-but-empty result. Killing the query there
    // cut the user's real turn off mid-flight.
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    const queryFn = (input: { prompt: unknown; options: Record<string, unknown> }) => {
      calls.push(input);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "real-session-id" } satisfies SdkMessageLike;
        yield { type: "result", subtype: "success", result: "", usage: {} } satisfies SdkMessageLike;
        yield { type: "result", subtype: "success", result: "", usage: {} } satisfies SdkMessageLike;
        yield {
          type: "assistant",
          message: { model: "claude-sonnet-5", content: [{ type: "text", text: "Real answer" }] },
        } satisfies SdkMessageLike;
        yield { type: "result", subtype: "success", result: "Real answer", usage: {} } satisfies SdkMessageLike;
      })();
    };

    const events = await collect(runClaudeSdkTurn({
      ...baseOptions,
      inputController: new ClaudeSdkInputController(),
      queryFn,
    }));

    // One attempt only: no bogus retry, so nothing restarts the turn from scratch.
    expect(calls).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant_message_complete",
      text: "Real answer",
    }));
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("gives up on injected results after the cap instead of looping forever", async () => {
    const calls: unknown[] = [];
    const queryFn = (input: unknown) => {
      calls.push(input);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" } satisfies SdkMessageLike;
        for (let index = 0; index < 50; index += 1) {
          yield { type: "result", subtype: "success", result: "", usage: {} } satisfies SdkMessageLike;
        }
      })();
    };

    const events = await collect(runClaudeSdkTurn({ ...baseOptions, queryFn }));

    expect(calls).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "error" }));
  });

  it("keeps accepting live steers on the retry attempt", async () => {
    // The input controller used to be closed in attempt 0's finally, so after a
    // retry every steer threw and silently degraded into a queued follow-up.
    const controller = new ClaudeSdkInputController();
    const calls: Array<{ prompt: string | AsyncIterable<SdkUserMessageLike>; options: Record<string, unknown> }> = [];
    const queryFn = (input: {
      prompt: string | AsyncIterable<SdkUserMessageLike>;
      options: Record<string, unknown>;
    }) => {
      calls.push(input);
      const callNumber = calls.length;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" } satisfies SdkMessageLike;
        if (callNumber === 1) {
          yield { type: "result", subtype: "success", result: "", usage: {} } satisfies SdkMessageLike;
          return;
        }
        await waitUntil(() => attemptTwoStarted);
        yield {
          type: "assistant",
          message: { model: "claude-sonnet-5", content: [{ type: "text", text: "steered answer" }] },
        } satisfies SdkMessageLike;
        yield { type: "result", subtype: "success", result: "steered answer", usage: {} } satisfies SdkMessageLike;
      })();
    };

    let attemptTwoStarted = false;
    const events = collect(runClaudeSdkTurn({ ...baseOptions, inputController: controller, queryFn }));

    await waitUntil(() => calls.length === 2);
    // The steer would throw here if the retry had inherited a closed controller.
    controller.push("actually do this instead", "now");
    attemptTwoStarted = true;

    await events;
    const retryPrompt = calls[1]?.prompt;
    expect(typeof retryPrompt).not.toBe("string");
    const retryTexts: string[] = [];
    if (typeof retryPrompt !== "string" && retryPrompt) {
      for await (const message of retryPrompt) {
        retryTexts.push(message.message.content[0]?.text ?? "");
      }
    }
    expect(retryTexts).toContain("actually do this instead");
  });

  it("reports an error instead of an empty completion when both attempts are empty", async () => {
    const queryFn = () => (async function* () {
      yield { type: "system", subtype: "init", session_id: "s" } satisfies SdkMessageLike;
      yield { type: "result", subtype: "success", result: "", usage: {} } satisfies SdkMessageLike;
    })();

    const events = await collect(runClaudeSdkTurn({ ...baseOptions, queryFn }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("without assistant text twice"),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "assistant_message_complete",
      text: "",
    }));
  });

  it("maps a non-success result to an error event", async () => {
    const { queryFn } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "error_max_budget_usd", result: "budget exceeded", usage: {} },
    ]);

    const events = await collect(runClaudeSdkTurn({ ...baseOptions, queryFn }));
    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({ type: "error", message: expect.stringContaining("budget exceeded") });
    expect(events.some((event) => event.type === "assistant_message_complete")).toBe(false);
  });

  it("reports live context from the last request, not the turn's summed cost", async () => {
    // A turn with three model calls re-sends the same cached prefix three
    // times. Summing them reported millions of tokens as "context" for a
    // conversation that never exceeded ~200k.
    const { queryFn } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: {} }],
          usage: { input_tokens: 4, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 900, output_tokens: 300 },
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: {} }],
          usage: { input_tokens: 2, cache_read_input_tokens: 175_000, cache_creation_input_tokens: 400, output_tokens: 250 },
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 3, cache_read_input_tokens: 199_000, cache_creation_input_tokens: 500, output_tokens: 120 },
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "done",
        usage: {
          input_tokens: 9,
          cache_read_input_tokens: 524_000,
          cache_creation_input_tokens: 1_800,
          output_tokens: 670,
        },
      },
    ]);

    const events = await collect(runClaudeSdkTurn({ ...baseOptions, queryFn }));
    const usage = events.find((event) => event.type === "usage_updated");
    // Turn totals stay available for cost reporting...
    expect(usage).toMatchObject({ inputTokens: 9, cachedInputTokens: 525_800, outputTokens: 670 });
    // ...while contextTokens describes the last request only.
    expect(usage).toMatchObject({ contextTokens: 3 + 199_000 + 500 + 120 });
  });

  it("leaves contextTokens unset when no assistant message carried usage", async () => {
    const { queryFn } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "result", subtype: "success", result: "hi", usage: { input_tokens: 5, output_tokens: 2 } },
    ]);

    const events = await collect(runClaudeSdkTurn({ ...baseOptions, queryFn }));
    const usage = events.find((event) => event.type === "usage_updated");
    expect(usage).toMatchObject({ type: "usage_updated", contextTokens: undefined });
  });

  it("reports a stream that dies without a result", async () => {
    const { queryFn } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } },
    ]);

    const events = await collect(runClaudeSdkTurn({ ...baseOptions, queryFn }));
    expect(events[events.length - 1]).toMatchObject({
      type: "error",
      message: expect.stringContaining("without a result"),
    });
  });
});

describe("recoverSdkContextFromTranscript", () => {
  it("reads the last real per-call usage from the session transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-sdk-ctx-"));
    try {
      const sessionId = "test-session-1";
      const projectDir = join(root, "projects", "demo");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, `${sessionId}.jsonl`),
        [
          JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
          JSON.stringify({
            type: "assistant",
            message: {
              usage: {
                input_tokens: 400,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 0,
                output_tokens: 50,
              },
            },
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              // Z.AI-style zeroed block: must be skipped, not counted.
              usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
            },
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              usage: {
                input_tokens: 500,
                cache_read_input_tokens: 78464,
                cache_creation_input_tokens: 0,
                output_tokens: 300,
              },
            },
          }),
        ].join("\n") + "\n",
      );
      const recovered = await recoverSdkContextFromTranscript(sessionId, [root]);
      expect(recovered).toBe(79264);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when no transcript exists", async () => {
    const missing = await recoverSdkContextFromTranscript("missing-session", [
      join(tmpdir(), "tc-definitely-not-here"),
    ]);
    expect(missing).toBeUndefined();
  });
});
