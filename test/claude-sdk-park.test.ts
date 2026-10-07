import {
  ClaudeSdkInputController,
  ParkedQuery,
  runClaudeSdkTurn,
  type SdkMessageLike,
} from "../src/providers/claude-sdk-engine.js";
import type { AgentProviderEvent } from "../src/providers/types.js";
import { vi } from "vitest";

/**
 * Parked drain: a finished query stays alive briefly and forwards whatever the
 * CLI still emits, instead of being torn down at the turn boundary. The CLI
 * buffers background <task-notification>s and resume rescues in its own pending
 * queue; killing the process at the answer turned each queued item into a dead
 * turn and a lost answer.
 */

async function collect(iterable: AsyncIterable<AgentProviderEvent>): Promise<AgentProviderEvent[]> {
  const events: AgentProviderEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function controlledQuery() {
  const resolvers: Array<(result: IteratorResult<SdkMessageLike>) => void> = [];
  const queued: SdkMessageLike[] = [];
  let ended = false;
  let closed = false;

  const next = (): Promise<IteratorResult<SdkMessageLike>> =>
    new Promise((resolve) => {
      if (queued.length > 0) {
        resolve({ value: queued.shift()!, done: false });
        return;
      }
      if (ended) {
        resolve({ value: undefined, done: true });
        return;
      }
      resolvers.push(resolve);
    });

  const releaseAll = (): void => {
    for (const resolve of resolvers.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  };

  const stream: AsyncIterable<SdkMessageLike> & { close?: () => void } = {
    [Symbol.asyncIterator]() {
      return { next };
    },
    close: () => {
      closed = true;
      ended = true;
      releaseAll();
    },
  };

  const seen: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  // The real SDK consumes the prompt iterable, which is what moves the input
  // controller's deliveredCount and therefore drives the engine's steer
  // accounting. A fake that ignores the iterable leaves deliveredCount at 0 and
  // silently skips the very logic an adopted (steered) turn depends on.
  const deliveredPrompts: unknown[] = [];
  const queryFn = (input: { prompt: unknown; options: Record<string, unknown> }) => {
    seen.push(input);
    const prompt = input.prompt;
    if (prompt && typeof prompt === "object" && Symbol.asyncIterator in prompt) {
      void (async () => {
        try {
          for await (const message of prompt as AsyncIterable<unknown>) {
            deliveredPrompts.push(message);
          }
        } catch {
          // The controller closing mid-read is normal teardown.
        }
      })();
    }
    return stream;
  };

  return {
    queryFn,
    seen,
    deliveredPrompts,
    isClosed: () => closed,
    /** Messages pushed but not yet taken by a reader. */
    queuedCount: () => queued.length,
    /** Readers currently blocked in next(); 1 means the drain is idle-waiting. */
    waitingReaders: () => resolvers.length,
    push: (message: SdkMessageLike): void => {
      const resolve = resolvers.shift();
      if (resolve) {
        resolve({ value: message, done: false });
      } else {
        queued.push(message);
      }
    },
    end: (): void => {
      ended = true;
      releaseAll();
    },
  };
}

const baseOptions = {
  sessionId: "claude-provider-park",
  jobId: "park-job",
  promptText: "do the thing",
  cwd: "C:\\workspace",
  claudeBin: "C:\\claude.exe",
  model: "claude-sonnet-5",
  permissionMode: "bypassPermissions" as const,
};

const initMessage: SdkMessageLike = { type: "system", subtype: "init", session_id: "park-session" };

function textMessage(text: string): SdkMessageLike {
  return { type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "text", text }] } };
}

function successResult(result: string): SdkMessageLike {
  return {
    type: "result",
    subtype: "success",
    result,
    usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 },
  };
}

describe("parked sdk queries", () => {
  const parkOptions = {
    ...baseOptions,
    parkIdleMs: 300,
    parkHardCapMs: 5_000,
  };

  it("keeps the query alive after the answer and delivers late text via onParkedEvent", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkedEvents: AgentProviderEvent[] = [];
    const parkStates: boolean[] = [];
    const events = await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    // The turn itself completes normally...
    expect(events.some((event) => event.type === "assistant_message_complete" && event.text === "ANSWER")).toBe(true);
    expect(parkStates).toEqual([true]);

    // ...and the query is still open afterwards.
    expect(controlled.isClosed()).toBe(false);

    controlled.push(textMessage("LATE"));
    controlled.push(successResult(""));
    await waitUntil(() =>
      parkedEvents.some((event) => event.type === "assistant_message_complete" && event.text === "LATE"),
    );

    // The park then idles out and releases the query.
    await waitUntil(() => parkStates.includes(false));
    await waitUntil(() => controlled.isClosed());
  });

  it("does not park when parkIdleMs is 0 (legacy teardown at the answer)", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkStates: boolean[] = [];
    const events = await collect(
      runClaudeSdkTurn({
        ...baseOptions,
        parkIdleMs: 0,
        queryFn: controlled.queryFn,
        onParkedEvent: () => {},
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    expect(events.some((event) => event.type === "assistant_message_complete")).toBe(true);
    expect(parkStates).toEqual([]);
    expect(controlled.isClosed()).toBe(true);
  });

  it("does not park when no onParkedEvent handler is installed", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const events = await collect(
      runClaudeSdkTurn({
        ...baseOptions,
        parkIdleMs: 300,
        queryFn: controlled.queryFn,
      }),
    );

    expect(events.some((event) => event.type === "assistant_message_complete")).toBe(true);
    expect(controlled.isClosed()).toBe(true);
  });

  it("ignores an injected turn's silent result during the park and still delivers later text", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("FIRST"));
    controlled.push(successResult("FIRST"));

    const parkedEvents: AgentProviderEvent[] = [];
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: () => {},
      }),
    );

    controlled.push(successResult(""));
    controlled.push(textMessage("SECOND"));
    controlled.push(successResult(""));

    await waitUntil(() =>
      parkedEvents.some((event) => event.type === "assistant_message_complete" && event.text === "SECOND"),
    );
    const completions = parkedEvents.filter((event) => event.type === "assistant_message_complete");
    expect(completions).toHaveLength(1);
  });

  it("delivers a parked result's text once, without repeating the assistant blocks", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkedEvents: AgentProviderEvent[] = [];
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: () => {},
      }),
    );

    controlled.push(textMessage("TAIL"));
    controlled.push(successResult("TAIL"));

    await waitUntil(() => parkedEvents.length > 0);
    await waitUntil(() => controlled.isClosed());
    const completions = parkedEvents.filter((event) => event.type === "assistant_message_complete");
    expect(completions).toHaveLength(1);
    expect((completions[0] as { text: string }).text).toBe("TAIL");
  });

  it("flushes buffered text blocks when the park idles out without a result", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkedEvents: AgentProviderEvent[] = [];
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: () => {},
      }),
    );

    controlled.push(textMessage("NO RESULT FOLLOWS"));
    controlled.push({ type: "system", subtype: "session_state_changed", state: "idle" });
    await waitUntil(() =>
      parkedEvents.some((event) => event.type === "assistant_text_delta" && event.text === "NO RESULT FOLLOWS"),
    );
  });

  it("keeps the drain failure contained when onParkedEvent throws", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkStates: boolean[] = [];
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: () => {
          throw new Error("consumer exploded");
        },
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    controlled.push(textMessage("BOOM"));
    controlled.push(successResult(""));

    await waitUntil(() => parkStates.includes(false));
    await waitUntil(() => controlled.isClosed());
  });

  it("ends the park promptly when the query stream finishes", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkStates: boolean[] = [];
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        parkIdleMs: 60_000,
        queryFn: controlled.queryFn,
        onParkedEvent: () => {},
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    expect(parkStates).toEqual([true]);
    controlled.end();

    await waitUntil(() => parkStates.includes(false));
    await waitUntil(() => controlled.isClosed());
  });

  it("maps an error result to no park at all", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push({ type: "result", subtype: "error_during_execution", errors: ["boom"] });

    const parkStates: boolean[] = [];
    const events = await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: () => {},
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(parkStates).toEqual([]);
    expect(controlled.isClosed()).toBe(true);
  });
});

/**
 * Adoption: the next prompt is steered into the still-running parked query rather
 * than opening a second CLI process. This is the part that actually stops the
 * "Continue from where you left off." injection, because the work the CLI queued
 * behind the last answer is never truncated by a kill at the turn boundary.
 */
describe("adopting a parked sdk query", () => {
  const parkOptions = {
    ...baseOptions,
    parkIdleMs: 300,
    parkHardCapMs: 5_000,
  };

  /** Exactly what the adapter does before it starts the next turn. */
  async function adopt(handle: ParkedQuery | undefined): Promise<ParkedQuery | undefined> {
    if (!handle) {
      return undefined;
    }
    if (await handle.takeOver()) {
      return handle;
    }
    handle.close();
    return undefined;
  }

  async function runParkedFirstTurn(
    controlled: ReturnType<typeof controlledQuery>,
    parkIdleMs = parkOptions.parkIdleMs,
  ): Promise<{ inputController: ClaudeSdkInputController; handle: ParkedQuery | undefined }> {
    const inputController = new ClaudeSdkInputController();
    let handle: ParkedQuery | undefined;
    controlled.push(initMessage);
    controlled.push(textMessage("FIRST"));
    controlled.push(successResult("FIRST"));
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        parkIdleMs,
        queryFn: controlled.queryFn,
        inputController,
        onParkedEvent: () => {},
        onParkStateChanged: (parked, query) => {
          if (parked) {
            handle = query;
          }
        },
      }),
    );
    return { inputController, handle };
  }

  it("never drops a message handed between the drain and the adopting turn", async () => {
    const resolvers: Array<(result: IteratorResult<SdkMessageLike>) => void> = [];
    const handle = new ParkedQuery(
      {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<SdkMessageLike>>((resolve) => {
              resolvers.push(resolve);
            }),
        }),
      },
      undefined,
      "park-session",
    );

    // A reader asks for the next message and walks away before it arrives.
    const abandoned = handle.next();
    resolvers.shift()!({ value: textMessage("IN FLIGHT"), done: false });

    // The next reader must receive that message, not skip past it.
    const received = await handle.next();
    expect(received.done).toBe(false);
    expect(
      (received.value as { message: { content: Array<{ text: string }> } }).message.content[0].text,
    ).toBe("IN FLIGHT");
    await expect(abandoned).resolves.toMatchObject({ done: false });
  });

  it("steers the next prompt into the parked query instead of opening a second one", async () => {
    const controlled = controlledQuery();
    const { inputController, handle } = await runParkedFirstTurn(controlled);
    expect(controlled.seen).toHaveLength(1);
    expect(controlled.deliveredPrompts).toHaveLength(1);

    const adopted = await adopt(handle);
    expect(adopted).toBeDefined();

    const events: AgentProviderEvent[] = [];
    const turn = (async () => {
      for await (const event of runClaudeSdkTurn({
        ...parkOptions,
        promptText: "the follow-up question",
        queryFn: controlled.queryFn,
        inputController,
        adoptedQuery: adopted,
        onParkedEvent: () => {},
        onParkStateChanged: () => {},
      })) {
        events.push(event);
      }
    })();

    // The prompt reaches the SAME query as a live steer; no second query opens.
    await waitUntil(() => controlled.deliveredPrompts.length === 2);
    expect(controlled.seen).toHaveLength(1);

    // The CLI reports the work the steer interrupted as an empty success. That
    // must not end the turn.
    controlled.push(successResult(""));
    controlled.push(textMessage("SECOND"));
    controlled.push(successResult("SECOND"));
    await turn;

    expect(
      events.some((event) => event.type === "assistant_message_complete" && event.text === "SECOND"),
    ).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(controlled.seen).toHaveLength(1);
  });

  it("flushes text the drain was holding before handing the query over", async () => {
    const controlled = controlledQuery();
    const parkedEvents: AgentProviderEvent[] = [];
    const inputController = new ClaudeSdkInputController();
    let handle: ParkedQuery | undefined;
    controlled.push(initMessage);
    controlled.push(textMessage("FIRST"));
    controlled.push(successResult("FIRST"));
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        parkIdleMs: 60_000,
        queryFn: controlled.queryFn,
        inputController,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: (parked, query) => {
          if (parked) {
            handle = query;
          }
        },
      }),
    );

    // Late narration with no closing result yet, so the drain is holding it.
    controlled.push(textMessage("HELD BY THE DRAIN"));
    await waitUntil(() => controlled.queuedCount() === 0 && controlled.waitingReaders() === 1);

    const adopted = await adopt(handle);
    expect(adopted).toBeDefined();

    // The handover must not swallow it.
    expect(
      parkedEvents.some(
        (event) => event.type === "assistant_text_delta" && event.text === "HELD BY THE DRAIN",
      ),
    ).toBe(true);
  });

  it("opens a fresh query when the park is already gone", async () => {
    const controlled = controlledQuery();
    const { handle } = await runParkedFirstTurn(controlled);
    expect(handle).toBeDefined();

    // The CLI exits: the drain sees the stream finish and closes the handle.
    controlled.end();
    await waitUntil(() => controlled.isClosed());

    expect(await adopt(handle)).toBeUndefined();
    expect(handle!.isClosed).toBe(true);
  });

  it("falls back to a fresh query with the original prompt when the adopted one is dead", async () => {
    const controlled = controlledQuery();
    const { inputController, handle } = await runParkedFirstTurn(controlled, 60_000);
    const adopted = await adopt(handle);
    expect(adopted).toBeDefined();

    // Adoption succeeded, but the CLI dies before answering the steer.
    controlled.end();

    const events = await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        promptText: "the follow-up question",
        queryFn: controlled.queryFn,
        inputController,
        adoptedQuery: adopted,
        onParkedEvent: () => {},
        onParkStateChanged: () => {},
      }),
    );

    // A second query was opened rather than reporting a crash for a prompt that
    // never actually ran.
    expect(controlled.seen).toHaveLength(2);
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("re-parks after an adopted turn so the prompt after it can steer in too", async () => {
    const controlled = controlledQuery();
    const { inputController, handle } = await runParkedFirstTurn(controlled);
    const adopted = await adopt(handle);
    expect(adopted).toBeDefined();

    let reparked: ParkedQuery | undefined;
    const turn = collect(
      runClaudeSdkTurn({
        ...parkOptions,
        promptText: "the follow-up question",
        queryFn: controlled.queryFn,
        inputController,
        adoptedQuery: adopted,
        onParkedEvent: () => {},
        onParkStateChanged: (parked, query) => {
          if (parked) {
            reparked = query;
          }
        },
      }),
    );

    await waitUntil(() => controlled.deliveredPrompts.length === 2);
    controlled.push(textMessage("SECOND"));
    controlled.push(successResult("SECOND"));
    await turn;

    expect(reparked).toBe(adopted);
    expect(controlled.isClosed()).toBe(false);
    expect(await reparked!.takeOver()).toBe(true);
  });
});

/**
 * A park is not just a mailbox for late text. When the CLI picks up queued work
 * it is genuinely running a turn, and both facts have to reach the bridge while
 * it happens: the text as it is produced, and the fact that Claude is busy.
 * Holding either until the injected turn's result left the user staring at a
 * silent chat for minutes and let his next message steer work he never saw.
 */
describe("parked drain liveness", () => {
  const liveParkOptions = {
    ...baseOptions,
    parkIdleMs: 3_000,
    parkHardCapMs: 10_000,
    parkFlushDebounceMs: 40,
  };

  it("sends parked text as it is produced instead of holding it until the result", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkedEvents: AgentProviderEvent[] = [];
    const parkStates: boolean[] = [];
    await collect(
      runClaudeSdkTurn({
        ...liveParkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    // The injected turn starts talking but has not finished: no result yet.
    controlled.push(textMessage("WORKING ON IT"));

    await waitUntil(() =>
      parkedEvents.some((event) => event.type === "assistant_text_delta" && event.text === "WORKING ON IT"),
    );
    // Delivered while the park is still open, not as part of its teardown.
    expect(parkStates).toEqual([true]);
    expect(controlled.isClosed()).toBe(false);
  });

  it("reports the parked cli busy while it works and idle again at the result", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const activity: boolean[] = [];
    let parkedQuery: ParkedQuery | undefined;
    await collect(
      runClaudeSdkTurn({
        ...liveParkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: () => {},
        onParkActivityChanged: (active) => activity.push(active),
        onParkStateChanged: (parked, query) => {
          if (parked) {
            parkedQuery = query;
          }
        },
      }),
    );

    expect(activity).toEqual([]);
    expect(parkedQuery?.isActive).toBe(false);

    controlled.push(textMessage("PICKED UP QUEUED WORK"));
    await waitUntil(() => activity.length === 1);
    expect(activity).toEqual([true]);
    expect(parkedQuery?.isActive).toBe(true);

    controlled.push(successResult("PICKED UP QUEUED WORK"));
    await waitUntil(() => activity.length === 2);
    expect(activity).toEqual([true, false]);
    expect(parkedQuery?.isActive).toBe(false);
  });

  it("does not make a finished session busy on idle metadata or task progress", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));
    const activity: boolean[] = [];
    await collect(runClaudeSdkTurn({
      ...liveParkOptions,
      queryFn: controlled.queryFn,
      onParkedEvent: () => {},
      onParkActivityChanged: (active) => activity.push(active),
    }));

    controlled.push({ type: "system", subtype: "session_state_changed", state: "idle" } as SdkMessageLike);
    controlled.push({ type: "system", subtype: "status", status: null } as SdkMessageLike);
    controlled.push({ type: "system", subtype: "task_progress" });
    controlled.push({ type: "system", subtype: "init", session_id: "park-session" });
    await waitUntil(() => controlled.queuedCount() === 0 && controlled.waitingReaders() === 1);
    expect(activity).toEqual([]);
    controlled.end();
  });

  it("honors the SDK session idle signal after an injected turn", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));
    const activity: boolean[] = [];
    await collect(runClaudeSdkTurn({
      ...liveParkOptions,
      queryFn: controlled.queryFn,
      onParkedEvent: () => {},
      onParkActivityChanged: (active) => activity.push(active),
    }));

    controlled.push({ type: "system", subtype: "session_state_changed", state: "running" } as SdkMessageLike);
    await waitUntil(() => activity.length === 1);
    controlled.push({ type: "system", subtype: "session_state_changed", state: "idle" } as SdkMessageLike);
    await waitUntil(() => controlled.queuedCount() === 0 && controlled.waitingReaders() === 1);
    expect(activity).toEqual([true, false]);
    controlled.end();
  });

  it("distinguishes parked narration from the final result even after a timer flush", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));
    const events: AgentProviderEvent[] = [];
    await collect(runClaudeSdkTurn({
      ...liveParkOptions,
      queryFn: controlled.queryFn,
      onParkedEvent: (event) => events.push(event),
    }));

    controlled.push(textMessage("INTERIM"));
    await waitUntil(() => events.length > 0);
    expect(events[0]).toMatchObject({ type: "assistant_text_delta", text: "INTERIM" });
    controlled.push(textMessage("FINAL"));
    await waitUntil(() => events.length > 1);
    controlled.push(successResult("FINAL"));
    await waitUntil(() => events.some((event) => event.type === "assistant_message_complete"));
    expect(events.filter((event) => event.type === "assistant_message_complete")).toEqual([
      expect.objectContaining({ text: "FINAL" }),
    ]);
    controlled.end();
  });

  it("accepts a steer pushed into an active park and answers it through the drain", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const inputController = new ClaudeSdkInputController();
    const parkedEvents: AgentProviderEvent[] = [];
    let parkedQuery: ParkedQuery | undefined;
    await collect(
      runClaudeSdkTurn({
        ...liveParkOptions,
        queryFn: controlled.queryFn,
        inputController,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: (parked, query) => {
          if (parked) {
            parkedQuery = query;
          }
        },
      }),
    );

    // The park owns the input stream now, and it is still open: this is the path
    // an explicit steer takes when the CLI is mid-turn with no bridge turn running.
    expect(parkedQuery?.inputController).toBe(inputController);
    expect(inputController.isClosed).toBe(false);

    const deliveredBefore = controlled.deliveredPrompts.length;
    inputController.push("stop and check the log", "now");
    await waitUntil(() => controlled.deliveredPrompts.length > deliveredBefore);

    controlled.push(textMessage("CHECKED THE LOG"));
    await waitUntil(() =>
      parkedEvents.some((event) => event.type === "assistant_text_delta" && event.text === "CHECKED THE LOG"),
    );
  });

  it("does not repeat the closing paragraph when a result closes several blocks", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkedEvents: AgentProviderEvent[] = [];
    await collect(
      runClaudeSdkTurn({
        ...baseOptions,
        parkIdleMs: 3_000,
        parkHardCapMs: 10_000,
        // No debounce flush in between: the blocks reach the result together,
        // which is the shape that used to duplicate the final one.
        parkFlushDebounceMs: 5_000,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
      }),
    );

    controlled.push(textMessage("FIRST PART"));
    controlled.push(textMessage("SECOND PART"));
    controlled.push(successResult("SECOND PART"));

    await waitUntil(() => parkedEvents.some((event) => event.type === "assistant_message_complete"));
    const delivered = parkedEvents.filter((event) => event.type === "assistant_message_complete" || event.type === "assistant_text_delta");
    expect(delivered.map((event) => ({ type: event.type, text: event.text }))).toEqual([
      { type: "assistant_text_delta", text: "FIRST PART" },
      { type: "assistant_message_complete", text: "SECOND PART" },
    ]);
  });
});

function backgroundLaunch(id: string): SdkMessageLike {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          content: `Command running in background with ID: ${id}. Output is being written to: /tmp/out.log`,
        },
      ],
    },
  } as SdkMessageLike;
}

function taskNotification(id: string): SdkMessageLike {
  return {
    type: "user",
    message: { content: `<task-notification><task-id>${id}</task-id></task-notification>` },
  } as unknown as SdkMessageLike;
}

describe("parked drain background tasks", () => {
  const taskParkOptions = {
    ...baseOptions,
    parkIdleMs: 150,
    parkHardCapMs: 10_000,
    parkFlushDebounceMs: 20,
  };

  it("preserves a long task's extended deadline when completion clears its live snapshot", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "long-task" }] });
    controlled.push(textMessage("STARTED"));
    controlled.push(successResult("STARTED"));
    const events: AgentProviderEvent[] = [];
    const realNow = Date.now.bind(Date);
    let elapsed = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
    try {
      await collect(runClaudeSdkTurn({
        ...taskParkOptions, parkHardCapMs: 1000, queryFn: controlled.queryFn,
        onParkedEvent: (event) => events.push(event),
      }));
      elapsed = 1500;
      controlled.push({ type: "system", subtype: "task_notification", task_id: "long-task", status: "completed" });
      controlled.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      controlled.push(initMessage);
      controlled.push(textMessage("LONG TASK FINAL"));
      controlled.push(successResult("LONG TASK FINAL"));
      await waitUntil(() => controlled.isClosed() || events.some((event) => event.type === "assistant_message_complete"));
      expect(events).toContainEqual(expect.objectContaining({ type: "assistant_message_complete", text: "LONG TASK FINAL" }));
    } finally {
      controlled.end();
      clock.mockRestore();
    }
  });

  it("allows a delayed legacy text task notification to hand off to a model turn", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(backgroundLaunch("legacy-task"));
    controlled.push(textMessage("STARTED"));
    controlled.push(successResult("STARTED"));
    const events: AgentProviderEvent[] = [];
    try {
      await collect(runClaudeSdkTurn({
        ...taskParkOptions, queryFn: controlled.queryFn,
        onParkedEvent: (event) => events.push(event),
      }));
      controlled.push(taskNotification("legacy-task"));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(controlled.isClosed()).toBe(false);
      controlled.push(initMessage);
      controlled.push(textMessage("LEGACY TASK FINAL"));
      controlled.push(successResult("LEGACY TASK FINAL"));
      await waitUntil(() => events.some((event) => event.type === "assistant_message_complete"));
    } finally {
      controlled.end();
    }
  });

  it("hands off when an older CLI removes a task snapshot before its completion notification", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "older-order" }] });
    controlled.push(textMessage("STARTED"));
    controlled.push(successResult("STARTED"));
    const events: AgentProviderEvent[] = [];
    try {
      await collect(runClaudeSdkTurn({
        ...taskParkOptions, queryFn: controlled.queryFn,
        onParkedEvent: (event) => events.push(event),
      }));
      controlled.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      controlled.push({ type: "system", subtype: "task_notification", task_id: "older-order", status: "completed" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(controlled.isClosed()).toBe(false);
      controlled.push(initMessage);
      controlled.push(textMessage("OLDER ORDER FINAL"));
      controlled.push(successResult("OLDER ORDER FINAL"));
      await waitUntil(() => events.some((event) => event.type === "assistant_message_complete"));
    } finally {
      controlled.end();
    }
  });

  it("does not arm another continuation for duplicate notifications after either snapshot order", () => {
    for (const notificationFirst of [true, false]) {
      const handle = new ParkedQuery(controlledQuery().queryFn({ prompt: "", options: {} }), undefined, "test");
      const notification: SdkMessageLike = { type: "system", subtype: "task_notification", task_id: "duplicate", run_id: "run-1", status: "completed" };
      const emptySnapshot: SdkMessageLike = { type: "system", subtype: "background_tasks_changed", tasks: [] };
      handle.trackMessage({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "duplicate", run_id: "run-1" }] });
      if (!notificationFirst) handle.trackMessage(emptySnapshot);
      expect(handle.trackMessage(notification)).toBe(true);
      if (notificationFirst) handle.trackMessage(emptySnapshot);
      expect(handle.trackMessage(notification)).toBe(false);
      handle.close();
    }
  });

  it("does not mark an unrelated init busy after the task handoff deadline expires", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "quiet-task" }] });
    controlled.push(textMessage("STARTED"));
    controlled.push(successResult("STARTED"));
    const activity: boolean[] = [];
    const realNow = Date.now.bind(Date);
    let elapsed = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
    try {
      await collect(runClaudeSdkTurn({
        ...taskParkOptions, parkIdleMs: 60_000, parkHardCapMs: 120_000,
        queryFn: controlled.queryFn, onParkedEvent: () => {},
        onParkActivityChanged: (active) => activity.push(active),
      }));
      controlled.push({ type: "system", subtype: "task_notification", task_id: "quiet-task", status: "completed" });
      controlled.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      await waitUntil(() => controlled.queuedCount() === 0 && controlled.waitingReaders() === 1);
      elapsed = 35_000;
      controlled.push(initMessage);
      await waitUntil(() => controlled.queuedCount() === 0 && controlled.waitingReaders() === 1);
      expect(activity).toEqual([]);
    } finally {
      controlled.end();
      clock.mockRestore();
    }
  });

  it("ignores prior run completions on the task-bookend fallback path", () => {
    const handle = new ParkedQuery(controlledQuery().queryFn({ prompt: "", options: {} }), undefined, "test");
    handle.trackMessage({ type: "system", subtype: "task_started", task_id: "resumed", run_id: "run-2", is_backgrounded: true });
    handle.trackMessage({ type: "system", subtype: "task_started", task_id: "resumed", run_id: "run-1", is_backgrounded: true });
    handle.trackMessage({ type: "system", subtype: "task_notification", task_id: "resumed", run_id: "run-1", status: "completed" });
    expect(handle.pendingTaskCount).toBe(1);
    handle.trackMessage({ type: "system", subtype: "task_notification", task_id: "resumed", run_id: "run-2", status: "completed" });
    expect(handle.pendingTaskCount).toBe(0);
    handle.trackMessage({ type: "system", subtype: "task_started", task_id: "resumed", run_id: "run-1", is_backgrounded: true });
    handle.trackMessage({ type: "system", subtype: "task_started", task_id: "resumed", run_id: "run-2", is_backgrounded: true });
    expect(handle.pendingTaskCount).toBe(0);
    handle.trackMessage({ type: "system", subtype: "task_started", task_id: "resumed", run_id: "run-3", is_backgrounded: true });
    expect(handle.pendingTaskCount).toBe(1);
    handle.close();
  });

  it("outlives the idle timeout while a background task has not reported back", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    // The CLI launches a background task, answers, and ends the turn. Claude Code
    // re-enters itself when that task finishes, long after the idle timer would fire.
    controlled.push(backgroundLaunch("becuy8exs"));
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkedEvents: AgentProviderEvent[] = [];
    await collect(
      runClaudeSdkTurn({
        ...taskParkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(controlled.isClosed()).toBe(false);

    controlled.push(taskNotification("becuy8exs"));
    controlled.push(textMessage("THE SUITE FINISHED"));
    await waitUntil(() =>
      parkedEvents.some(
        (event) => event.type === "assistant_text_delta" && event.text === "THE SUITE FINISHED",
      ),
    );
  });

  it("keeps structured SDK background tasks alive and clears them on completion", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push({ type: "system", subtype: "task_started", task_id: "sdk-task", is_backgrounded: true });
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));
    let handle: ParkedQuery | undefined;
    const activity: boolean[] = [];
    await collect(runClaudeSdkTurn({
      ...taskParkOptions,
      queryFn: controlled.queryFn,
      onParkedEvent: () => {},
      onParkStateChanged: (parked, query) => { if (parked) handle = query; },
      onParkActivityChanged: (active) => activity.push(active),
    }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(controlled.isClosed()).toBe(false);
    expect(handle?.pendingTaskCount).toBe(1);
    controlled.push({ type: "system", subtype: "task_notification", task_id: "sdk-task", status: "completed" });
    await waitUntil(() => handle?.pendingTaskCount === 0);
    expect(activity).toEqual([]);
    controlled.push({ type: "system", subtype: "session_state_changed", state: "idle" });
    await waitUntil(() => controlled.isClosed());
  });

  it("keeps steered tools alive from snapshots and ignores independently ordered task bookends", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push({
      type: "system", subtype: "background_tasks_changed",
      tasks: [{ task_id: "steered-tool", run_id: "run-2" }, { task_id: "watcher", ambient: true }],
    });
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));
    let handle: ParkedQuery | undefined;
    const activity: boolean[] = [];
    await collect(runClaudeSdkTurn({
      ...taskParkOptions,
      queryFn: controlled.queryFn,
      onParkedEvent: () => {},
      onParkStateChanged: (parked, query) => { if (parked) handle = query; },
      onParkActivityChanged: (active) => activity.push(active),
    }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(controlled.isClosed()).toBe(false);
    expect(handle?.pendingTaskCount).toBe(1);
    // A prior run's late completion must not clear the live replacement run.
    controlled.push({ type: "system", subtype: "task_notification", task_id: "steered-tool", run_id: "run-1", status: "completed" });
    await waitUntil(() => controlled.waitingReaders() > 0);
    expect(handle?.pendingTaskCount).toBe(1);
    controlled.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    // A late edge cannot resurrect a task the level signal already removed.
    controlled.push({ type: "system", subtype: "task_started", task_id: "steered-tool", is_backgrounded: true });
    await waitUntil(() => handle?.pendingTaskCount === 0);
    expect(activity).toEqual([]);
    await waitUntil(() => controlled.isClosed());
  });

  it("keeps the task-to-model handoff alive after the snapshot empties, including a quiet running turn", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg" }] });
    controlled.push(textMessage("STARTED"));
    controlled.push(successResult("STARTED"));
    const events: AgentProviderEvent[] = [];
    const activity: boolean[] = [];
    await collect(runClaudeSdkTurn({
      ...taskParkOptions, queryFn: controlled.queryFn,
      onParkedEvent: (event) => events.push(event),
      onParkActivityChanged: (active) => activity.push(active),
    }));
    controlled.push({ type: "system", subtype: "task_notification", task_id: "bg", status: "completed" });
    controlled.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(controlled.isClosed()).toBe(false);
    expect(activity).toEqual([]);
    controlled.push(initMessage);
    await waitUntil(() => activity.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(controlled.isClosed()).toBe(false);
    controlled.push(textMessage("BACKGROUND FINAL"));
    controlled.push(successResult("BACKGROUND FINAL"));
    await waitUntil(() => events.some((e) => e.type === "assistant_message_complete" && e.text === "BACKGROUND FINAL"));
    expect(activity).toEqual([true, false]);
    await waitUntil(() => controlled.isClosed());
  });

  async function adoptParkedTurn(
    controlled: ReturnType<typeof controlledQuery>,
    launchTaskId: string | undefined,
  ): Promise<AgentProviderEvent[]> {
    const inputController = new ClaudeSdkInputController();
    let handle: ParkedQuery | undefined;
    controlled.push(initMessage);
    if (launchTaskId) {
      controlled.push(backgroundLaunch(launchTaskId));
    }
    controlled.push(textMessage("FIRST"));
    controlled.push(successResult("FIRST"));
    await collect(
      runClaudeSdkTurn({
        ...taskParkOptions,
        queryFn: controlled.queryFn,
        inputController,
        onParkedEvent: () => {},
        onParkStateChanged: (parked, query) => {
          if (parked) {
            handle = query;
          }
        },
      }),
    );
    if (!handle || !(await handle.takeOver())) {
      throw new Error("first turn did not leave an adoptable park");
    }
    const events: AgentProviderEvent[] = [];
    const turn = (async () => {
      for await (const event of runClaudeSdkTurn({
        ...taskParkOptions,
        promptText: "the follow-up question",
        queryFn: controlled.queryFn,
        inputController,
        adoptedQuery: handle,
        onParkedEvent: () => {},
        onParkStateChanged: () => {},
      })) {
        events.push(event);
      }
    })();
    await waitUntil(() => controlled.deliveredPrompts.length === 2);
    controlled.push(successResult(""));
    controlled.push(textMessage("SECOND"));
    controlled.push(successResult("SECOND"));
    await turn;
    return events;
  }

  it("tells the user when their prompt was steered into a park still waiting on a task", async () => {
    const controlled = controlledQuery();
    const events = await adoptParkedTurn(controlled, "task7pend1");

    const notice = events.find((event) => event.type === "status_message");
    expect(notice).toBeDefined();
    expect(notice?.type === "status_message" && notice.priority).toBe(true);
    expect(notice?.type === "status_message" && notice.text).toContain("still waiting on a background task");
    expect(events.some((event) => event.type === "assistant_message_complete" && event.text === "SECOND")).toBe(true);
  });

  it("stays quiet when the adopted park owes nothing", async () => {
    const controlled = controlledQuery();
    const events = await adoptParkedTurn(controlled, undefined);

    expect(events.some((event) => event.type === "status_message")).toBe(false);
    expect(events.some((event) => event.type === "assistant_message_complete" && event.text === "SECOND")).toBe(true);
  });

  it("closes on the idle timer again once the task's follow-up has reported back", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(backgroundLaunch("btz538txp"));
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkStates: boolean[] = [];
    await collect(
      runClaudeSdkTurn({
        ...taskParkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: () => {},
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    controlled.push(taskNotification("btz538txp"));
    controlled.push(successResult("DONE"));
    // Nothing is owed any more, so the ordinary idle timeout applies and the park ends.
    await waitUntil(() => parkStates.includes(false));
    expect(controlled.isClosed()).toBe(true);
  });

  it("flushes held text at the hard ceiling while new blocks keep resetting the debounce", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkedEvents: AgentProviderEvent[] = [];
    await collect(
      runClaudeSdkTurn({
        ...baseOptions,
        parkIdleMs: 3_000,
        parkHardCapMs: 10_000,
        parkFlushDebounceMs: 5_000,
        parkFlushMaxHoldMs: 100,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
      }),
    );

    controlled.push(textMessage("PART ONE"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Resets the 5s debounce. Without the ceiling this text would sit for five seconds.
    controlled.push(textMessage("PART TWO"));

    await waitUntil(() =>
      parkedEvents.some(
        (event) =>
          event.type === "assistant_text_delta" && (event.text ?? "").includes("PART TWO"),
      ),
    );
  });
});

/**
 * /stop and /model against the query that is actually live. A turn that adopts a
 * park keeps the earlier turn's AbortController, so the SDK never sees the new
 * turn's abort; the engine must close the live query itself. A model switch while
 * a park is alive must reach that park, or the next adopted turn keeps the old
 * model and then writes it back over the user's choice.
 */
describe("stop and model switch against a live or adopted query", () => {
  const parkOptions = {
    ...baseOptions,
    parkIdleMs: 60_000,
    parkHardCapMs: 120_000,
  };

  async function parkFirstTurn(
    controlled: ReturnType<typeof controlledQuery>,
    options: { adopt: boolean; parkIdleMs?: number },
  ): Promise<{ inputController: ClaudeSdkInputController; handle: ParkedQuery; parkedEvents: AgentProviderEvent[] }> {
    const inputController = new ClaudeSdkInputController();
    const parkedEvents: AgentProviderEvent[] = [];
    let handle: ParkedQuery | undefined;
    controlled.push(initMessage);
    controlled.push(textMessage("FIRST"));
    controlled.push(successResult("FIRST"));
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        parkIdleMs: options.parkIdleMs ?? parkOptions.parkIdleMs,
        parkFlushDebounceMs: 20,
        queryFn: controlled.queryFn,
        inputController,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: (parked, query) => {
          if (parked) {
            handle = query;
          }
        },
      }),
    );
    if (!handle) {
      throw new Error("first turn did not park");
    }
    if (options.adopt && !(await handle.takeOver())) {
      throw new Error("park was not adoptable");
    }
    return { inputController, handle, parkedEvents };
  }

  it("aborting a turn that adopted a park closes that query and does not retry", async () => {
    const controlled = controlledQuery();
    const { inputController, handle } = await parkFirstTurn(controlled, { adopt: true });
    const abortController = new AbortController();
    const events: AgentProviderEvent[] = [];
    const turn = (async () => {
      for await (const event of runClaudeSdkTurn({
        ...parkOptions,
        promptText: "the follow-up question",
        queryFn: controlled.queryFn,
        inputController,
        adoptedQuery: handle,
        abortController,
        onParkedEvent: () => {},
        onParkStateChanged: () => {},
      })) {
        events.push(event);
      }
    })();

    await waitUntil(() => controlled.deliveredPrompts.length === 2);
    expect(controlled.isClosed()).toBe(false);

    abortController.abort();
    await turn;

    // The CLI behind the adopted park is gone, no fresh query was opened in its
    // place, and nothing was passed off as a finished answer.
    expect(controlled.isClosed()).toBe(true);
    expect(controlled.seen).toHaveLength(1);
    expect(events.some((event) => event.type === "assistant_message_complete")).toBe(false);
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("aborting a fresh query closes it and does not retry", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    const abortController = new AbortController();
    const events: AgentProviderEvent[] = [];
    const turn = (async () => {
      for await (const event of runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        abortController,
        onParkedEvent: () => {},
        onParkStateChanged: () => {},
      })) {
        events.push(event);
      }
    })();

    await waitUntil(() => controlled.waitingReaders() === 1);
    abortController.abort();
    await turn;

    expect(controlled.isClosed()).toBe(true);
    expect(controlled.seen).toHaveLength(1);
    expect(events.some((event) => event.type === "assistant_message_complete")).toBe(false);
  });

  it("ParkedQuery.setModel reaches the query's control request and reports when unsupported", async () => {
    const calls: Array<string | undefined> = [];
    const empty = { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true as const }) }) };
    const capable = new ParkedQuery(
      { ...empty, setModel: async (model?: string) => { calls.push(model); } },
      undefined,
      "s1",
    );
    await expect(capable.setModel("claude-fable-5-1")).resolves.toBe(true);
    expect(calls).toEqual(["claude-fable-5-1"]);

    const plain = new ParkedQuery(empty, undefined, "s2");
    await expect(plain.setModel("claude-fable-5-1")).resolves.toBe(false);

    capable.close();
    await expect(capable.setModel("claude-opus-5")).resolves.toBe(false);
    expect(calls).toEqual(["claude-fable-5-1"]);
  });

  it("delivers the CLI's synthetic notice during a park but not the rescue boilerplate", async () => {
    const controlled = controlledQuery();
    const { parkedEvents } = await parkFirstTurn(controlled, { adopt: false, parkIdleMs: 300 });

    controlled.push({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
    });
    controlled.push(successResult(""));
    controlled.push({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your monthly spend limit" }] },
    });
    controlled.push(successResult(""));

    await waitUntil(() =>
      parkedEvents.some(
        (event) => event.type === "assistant_message_complete" && (event.text ?? "").includes("monthly spend limit"),
      ),
    );
    expect(
      parkedEvents.some(
        (event) => event.type === "assistant_message_complete" && (event.text ?? "").includes("No response requested."),
      ),
    ).toBe(false);
  });

  it("reports a parked turn that ends in an error instead of only logging it", async () => {
    const controlled = controlledQuery();
    const { parkedEvents } = await parkFirstTurn(controlled, { adopt: false, parkIdleMs: 300 });

    controlled.push(textMessage("PARTIAL"));
    controlled.push({ type: "result", subtype: "error_during_execution", result: "boom", errors: [] });

    await waitUntil(() =>
      parkedEvents.some(
        (event) =>
          event.type === "error" && event.message.includes("boom"),
      ),
    );
    expect(parkedEvents).toContainEqual(expect.objectContaining({ type: "assistant_text_delta", text: "PARTIAL" }));
  });
});
