import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ThreadFixture = {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  created_at: number;
  updated_at: number;
  first_user_message: string;
  archived?: number;
  thread_source?: string;
};

type SpawnEdgeFixture = {
  parentThreadId: string;
  childThreadId: string;
  status: string;
};

type LoadOptions = {
  home?: string;
  files?: string[];
  stats?: Record<string, number>;
  threads?: ThreadFixture[];
  spawnEdges?: SpawnEdgeFixture[];
  modelsJson?: string;
  betterSqliteAvailable?: boolean;
  openThrows?: boolean;
  spawnTableMissing?: boolean;
  peerReviewIds?: string[];
};

const originalHome = process.env.HOME;

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.doUnmock("better-sqlite3");
  vi.doUnmock("../src/peer-review-sessions.js");
  vi.resetModules();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

async function loadCodexState(options: LoadOptions = {}) {
  const home = options.home ?? "/Users/tester";
  const codexDir = path.join(home, ".codex");
  const modelsPath = path.join(codexDir, "models_cache.json");
  const files = options.files ?? [];
  const stats = options.stats ?? {};
  const threads = options.threads ?? [];
  const spawnEdges = options.spawnEdges ?? [];
  process.env.HOME = home;

  vi.resetModules();
  vi.doMock("../src/peer-review-sessions.js", () => ({
    getPeerReviewSessionIds: () => new Set(options.peerReviewIds ?? []),
  }));

  vi.doMock("node:fs", () => ({
    existsSync: vi.fn((targetPath: string) => {
      if (targetPath === codexDir) {
        return true;
      }
      if (targetPath === modelsPath) {
        return options.modelsJson !== undefined;
      }
      return files.includes(path.basename(targetPath));
    }),
    readdirSync: vi.fn((targetPath: string) => {
      if (targetPath !== codexDir) {
        throw new Error(`Unexpected readdirSync path: ${targetPath}`);
      }
      return files;
    }),
    statSync: vi.fn((targetPath: string) => ({
      mtimeMs: stats[targetPath] ?? 0,
    })),
    readFileSync: vi.fn((targetPath: string) => {
      if (targetPath !== modelsPath || options.modelsJson === undefined) {
        throw new Error(`ENOENT: ${targetPath}`);
      }
      return options.modelsJson;
    }),
  }));

  if (options.betterSqliteAvailable === false) {
    vi.doMock("better-sqlite3", () => {
      throw Object.assign(new Error("Cannot find package 'better-sqlite3'"), { code: "ERR_MODULE_NOT_FOUND" });
    });
  } else {
    vi.doMock("better-sqlite3", () => ({
      default: class MockDatabase {
        constructor(_databasePath: string) {
          if (options.openThrows) {
            throw new Error("open failed");
          }
        }

        prepare(sql: string) {
          if (options.spawnTableMissing && sql.includes("thread_spawn_edges")) {
            throw new Error("no such table: thread_spawn_edges");
          }
          return {
            all: (...args: unknown[]) => runAllQuery(sql, threads, spawnEdges, args),
            get: (...args: unknown[]) => runGetQuery(sql, threads, spawnEdges, args),
          };
        }

        close(): void {}
      },
    }));
  }

  return await import("../src/codex-state.js");
}

it("keeps peer reviews out of latest/previous browsing without starving its limit", async () => {
  const state = await loadCodexState({
    files: ["state_1.sqlite"], peerReviewIds: ["peer-newest", "peer-second"],
    threads: ["ordinary", "peer-second", "peer-newest"].map((id, index) => ({
      id, title: id, cwd: "/workspace", model: "gpt-6.1-sol", created_at: index + 1, updated_at: index + 1, first_user_message: id,
    })),
  });
  expect(state.listThreads(1).map((thread) => thread.id)).toEqual(["ordinary"]);
});

it("hides a Codex reviewer from native source metadata before its ID marker arrives", async () => {
  const state = await loadCodexState({
    files: ["state_1.sqlite"],
    threads: ["ordinary", "unmarked-review"].map((id, index) => ({
      id, title: id, cwd: "/workspace", model: "gpt-6.1-sol", created_at: index + 1, updated_at: index + 1, first_user_message: id,
      ...(index === 1 ? { thread_source: "telecode-peer-review" } : {}),
    })),
  });
  expect(state.listThreads(1).map((thread) => thread.id)).toEqual(["ordinary"]);
});

function runAllQuery(
  sql: string,
  threads: ThreadFixture[],
  spawnEdges: SpawnEdgeFixture[],
  args: unknown[],
) {
  if (sql.includes("SELECT DISTINCT cwd")) {
    return [...new Set(threads.filter((thread) => thread.archived !== 1).map((thread) => thread.cwd).filter(Boolean))]
      .sort()
      .map((cwd) => ({ cwd }));
  }

  if (sql.includes("SELECT DISTINCT child_thread_id")) {
    return [...new Set(spawnEdges.map((edge) => edge.childThreadId))]
      .map((child_thread_id) => ({ child_thread_id }));
  }

  if (sql.includes("FROM thread_spawn_edges e") && sql.includes("JOIN threads t")) {
    const parentThreadId = String(args[0] ?? "");
    return spawnEdges
      .filter((edge) => edge.parentThreadId === parentThreadId)
      .map((edge) => {
        const child = threads.find((thread) => thread.archived !== 1 && thread.id === edge.childThreadId);
        return child
          ? {
              ...child,
              parent_thread_id: edge.parentThreadId,
              spawn_status: edge.status,
            }
          : null;
      })
      .filter((row): row is ThreadFixture & { parent_thread_id: string; spawn_status: string } => Boolean(row))
      .sort((left, right) => right.created_at - left.created_at);
  }

  if (sql.includes("FROM threads")) {
    if (sql.includes("WHERE thread_source = ?")) return threads.filter((thread) => thread.thread_source === args[0]);
    if (sql.includes("id LIKE ?")) {
      const prefix = String(args[0] ?? "").replace(/%$/, "");
      return threads
        .filter((thread) => thread.archived !== 1 && thread.id.startsWith(prefix))
        .sort((left, right) => right.updated_at - left.updated_at)
        .slice(0, 2);
    }

    const limit = typeof args[0] === "number" ? args[0] : 20;
    return threads
      .filter((thread) => thread.archived !== 1)
      .sort((left, right) => right.updated_at - left.updated_at)
      .slice(0, limit);
  }

  return [];
}

function runGetQuery(
  sql: string,
  threads: ThreadFixture[],
  spawnEdges: SpawnEdgeFixture[],
  args: unknown[],
) {
  if (sql.includes("FROM thread_spawn_edges")) {
    const childThreadId = String(args[0] ?? "");
    const edge = spawnEdges.find((candidate) => candidate.childThreadId === childThreadId);
    if (!edge) {
      return undefined;
    }
    const parent = threads.find((thread) => thread.archived !== 1 && thread.id === edge.parentThreadId);
    return parent
      ? {
          ...parent,
          child_thread_id: edge.childThreadId,
          spawn_status: edge.status,
        }
      : undefined;
  }

  if (sql.includes("WHERE archived = 0 AND id = ?")) {
    const id = String(args[0] ?? "");
    return threads.find((thread) => thread.archived !== 1 && thread.id === id);
  }

  return undefined;
}

describe("codex-state", () => {
  it("findLatestDatabase returns null when no sqlite files exist", async () => {
    const state = await loadCodexState({ files: [] });

    expect(state.findLatestDatabase()).toBeNull();
  });

  it("findLatestDatabase returns the newest matching sqlite file", async () => {
    const home = "/Users/tester";
    const codexDir = path.join(home, ".codex");
    const older = path.join(codexDir, "state_old.sqlite");
    const newer = path.join(codexDir, "state_new.sqlite");
    const state = await loadCodexState({
      home,
      files: ["notes.txt", "state_old.sqlite", "state_new.sqlite"],
      stats: {
        [older]: 100,
        [newer]: 200,
      },
    });

    expect(state.findLatestDatabase()).toBe(newer);
  });

  it("listThreads returns an empty array when better-sqlite3 is unavailable", async () => {
    const state = await loadCodexState({ betterSqliteAvailable: false, files: ["state_main.sqlite"] });

    expect(state.listThreads()).toEqual([]);
  });

  it("parses a Codex JSONL session when the SQLite index is unavailable", async () => {
    const state = await loadCodexState({ betterSqliteAvailable: false });
    const record = state.parseSessionFileThread(
      "/Users/tester/.codex/sessions/2026/07/rollout-2026-07-29T01-02-03-019fab0f-358c-78e2-b02d-4625104e7831.jsonl",
      [
        JSON.stringify({
          timestamp: "2026-07-29T01:02:03.000Z",
          type: "session_meta",
          payload: {
            id: "019fab0f-358c-78e2-b02d-4625104e7831",
            cwd: "/workspace/old",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-29T01:02:04.000Z",
          type: "turn_context",
          payload: {
            cwd: "/workspace/current",
            model: "gpt-5.6-terra",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-29T01:02:05.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Restore every previous session",
          },
        }),
      ].join("\n"),
      Date.parse("2026-07-29T01:02:06.000Z"),
    );

    expect(record).toEqual({
      id: "019fab0f-358c-78e2-b02d-4625104e7831",
      title: "",
      cwd: "/workspace/current",
      model: "gpt-5.6-terra",
      createdAt: new Date("2026-07-29T01:02:03.000Z"),
      updatedAt: new Date("2026-07-29T01:02:06.000Z"),
      firstUserMessage: "Restore every previous session",
    });
  });

  it("parses a session record from a truncated head, ignoring the severed tail", async () => {
    const state = await loadCodexState({ files: [] });
    const head = [
      JSON.stringify({
        timestamp: "2026-07-29T01:02:03.000Z",
        type: "session_meta",
        payload: { id: "019fab0f-358c-78e2-b02d-4625104e7831", cwd: "/workspace/current" },
      }),
      JSON.stringify({
        timestamp: "2026-07-29T01:02:04.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-terra" },
      }),
      JSON.stringify({
        timestamp: "2026-07-29T01:02:05.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Restore every previous session" },
      }),
      // Transcripts run to hundreds of megabytes, so only their head is read and
      // the final line arrives cut in half.
      '{"timestamp":"2026-07-29T01:02:06.000Z","type":"event_msg","payl',
    ].join("\n");

    const record = state.parseSessionFileThread(
      "/Users/tester/.codex/sessions/rollout-019fab0f-358c-78e2-b02d-4625104e7831.jsonl",
      head,
      Date.parse("2026-07-29T09:00:00.000Z"),
    );

    expect(record?.id).toBe("019fab0f-358c-78e2-b02d-4625104e7831");
    expect(record?.cwd).toBe("/workspace/current");
    expect(record?.model).toBe("gpt-5.6-terra");
    expect(record?.firstUserMessage).toBe("Restore every previous session");
    expect(record?.createdAt).toEqual(new Date("2026-07-29T01:02:03.000Z"));
    // The tail is unread, so the file's own mtime is the only honest last-write time.
    expect(record?.updatedAt).toEqual(new Date("2026-07-29T09:00:00.000Z"));
  });

  it("listThreads returns mapped active thread records", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "Newest",
          cwd: "/workspace/b",
          model: "gpt-5.4",
          created_at: 1_700_000_000,
          updated_at: 1_700_000_200,
          first_user_message: "hello",
        },
        {
          id: "thread-2",
          title: "Archived",
          cwd: "/workspace/c",
          model: "o3",
          created_at: 1_700_000_000,
          updated_at: 1_700_000_300,
          first_user_message: "hidden",
          archived: 1,
        },
        {
          id: "thread-3",
          title: "Older",
          cwd: "/workspace/a",
          model: null,
          created_at: 1_700_000_000,
          updated_at: 1_700_000_100,
          first_user_message: "older",
        },
      ],
    });

    expect(state.listThreads(10)).toEqual([
      {
        id: "thread-1",
        title: "Newest",
        cwd: "/workspace/b",
        model: "gpt-5.4",
        createdAt: new Date(1_700_000_000 * 1000),
        updatedAt: new Date(1_700_000_200 * 1000),
        firstUserMessage: "hello",
      },
      {
        id: "thread-3",
        title: "Older",
        cwd: "/workspace/a",
        model: null,
        createdAt: new Date(1_700_000_000 * 1000),
        updatedAt: new Date(1_700_000_100 * 1000),
        firstUserMessage: "older",
      },
    ]);
  });

  it("listWorkspaces returns unique sorted active workspaces", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "One",
          cwd: "/workspace/z",
          model: "o3",
          created_at: 1,
          updated_at: 2,
          first_user_message: "one",
        },
        {
          id: "thread-2",
          title: "Two",
          cwd: "/workspace/a",
          model: "o3",
          created_at: 1,
          updated_at: 3,
          first_user_message: "two",
        },
        {
          id: "thread-3",
          title: "Three",
          cwd: "/workspace/z",
          model: "o3",
          created_at: 1,
          updated_at: 4,
          first_user_message: "three",
        },
        {
          id: "thread-4",
          title: "Archived",
          cwd: "/workspace/b",
          model: "o3",
          created_at: 1,
          updated_at: 5,
          first_user_message: "archived",
          archived: 1,
        },
      ],
    });

    expect(state.listWorkspaces()).toEqual(["/workspace/a", "/workspace/z"]);
  });

  it("listModels parses models_cache.json and filters hidden models", async () => {
    const state = await loadCodexState({
      modelsJson: JSON.stringify({
        models: [
          {
            slug: "gpt-5.4",
            display_name: "GPT-5.4",
            supported_reasoning_levels: [
              { effort: "high" },
              { effort: "max" },
              { effort: "not-a-real-level" },
            ],
          },
          { slug: "secret", display_name: "Secret", visibility: "hidden" },
          { slug: "o3", display_name: "o3", visibility: "public" },
        ],
      }),
    });

    expect(state.listModels()).toEqual([
      { slug: "gpt-5.4", displayName: "GPT-5.4", supportedReasoningEfforts: ["high", "max"] },
      { slug: "o3", displayName: "o3", supportedReasoningEfforts: [] },
    ]);
  });

  it("listModels falls back when models_cache.json is absent or invalid", async () => {
    const noFileState = await loadCodexState();
    expect(noFileState.listModels()).toEqual(noFileState.FALLBACK_MODELS);

    const invalidState = await loadCodexState({ modelsJson: "{not-json" });
    expect(invalidState.listModels()).toEqual(invalidState.FALLBACK_MODELS);
  });

  it("getThread returns null when not found", async () => {
    const state = await loadCodexState({ files: ["state_main.sqlite"], threads: [] });

    expect(state.getThread("missing")).toBeNull();
  });

  it("listThreads omits spawned child threads from the top-level session list", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "parent-thread",
          title: "Main task",
          cwd: "/workspace",
          model: "gpt-5.6-sol",
          created_at: 10,
          updated_at: 20,
          first_user_message: "main",
        },
        {
          id: "child-thread",
          title: "Ultra worker",
          cwd: "/workspace",
          model: "gpt-5.6-sol",
          created_at: 11,
          updated_at: 30,
          first_user_message: "worker",
        },
      ],
      spawnEdges: [{ parentThreadId: "parent-thread", childThreadId: "child-thread", status: "completed" }],
    });

    expect(state.listThreads().map((thread) => thread.id)).toEqual(["parent-thread"]);
    expect(state.listSpawnedThreadIds()).toEqual(["child-thread"]);
  });

  it("listThreads still works with an older database that has no spawn-edge table", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      spawnTableMissing: true,
      threads: [{
        id: "legacy-thread",
        title: "Legacy",
        cwd: "/workspace",
        model: "gpt-5.4",
        created_at: 10,
        updated_at: 20,
        first_user_message: "legacy",
      }],
    });

    expect(state.listThreads().map((thread) => thread.id)).toEqual(["legacy-thread"]);
    expect(state.listSpawnedThreadIds()).toEqual([]);
  });

  it("lists child threads for a parent thread", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "parent-thread",
          title: "Parent",
          cwd: "/workspace",
          model: "gpt-5.4",
          created_at: 10,
          updated_at: 20,
          first_user_message: "parent",
        },
        {
          id: "child-old",
          title: "Old child",
          cwd: "/workspace",
          model: "gpt-5.4",
          created_at: 11,
          updated_at: 21,
          first_user_message: "old",
        },
        {
          id: "child-new",
          title: "New child",
          cwd: "/workspace",
          model: "gpt-5.4",
          created_at: 12,
          updated_at: 22,
          first_user_message: "new",
        },
      ],
      spawnEdges: [
        { parentThreadId: "parent-thread", childThreadId: "child-old", status: "completed" },
        { parentThreadId: "parent-thread", childThreadId: "child-new", status: "running" },
      ],
    });

    expect(state.listChildThreads("parent-thread").map((thread) => thread.id)).toEqual(["child-new", "child-old"]);
    expect(state.listChildThreads("parent-thread")[0]).toMatchObject({
      id: "child-new",
      parentThreadId: "parent-thread",
      spawnStatus: "running",
    });
  });

  it("gets a parent thread for a child thread", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "parent-thread",
          title: "Parent",
          cwd: "/workspace",
          model: "gpt-5.4",
          created_at: 10,
          updated_at: 20,
          first_user_message: "parent",
        },
        {
          id: "child-thread",
          title: "Child",
          cwd: "/workspace",
          model: "gpt-5.4",
          created_at: 11,
          updated_at: 21,
          first_user_message: "child",
        },
      ],
      spawnEdges: [{ parentThreadId: "parent-thread", childThreadId: "child-thread", status: "completed" }],
    });

    expect(state.getParentThread("child-thread")).toMatchObject({
      id: "parent-thread",
      childThreadId: "child-thread",
      spawnStatus: "completed",
    });
  });

  it("returns empty results gracefully when opening the database fails", async () => {
    const state = await loadCodexState({ files: ["state_main.sqlite"], openThrows: true });

    expect(state.listThreads()).toEqual([]);
    expect(state.listWorkspaces()).toEqual([]);
    expect(state.getThread("thread-1")).toBeNull();
    expect(state.listChildThreads("thread-1")).toEqual([]);
    expect(state.getParentThread("thread-1")).toBeNull();
  });
});
