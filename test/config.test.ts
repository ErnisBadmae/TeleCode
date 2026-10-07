import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { existsSync } from "node:fs";

import { loadConfig } from "../src/config.js";

function defaultClaudeBinForTest(): string {
  const native = path.join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  if (existsSync(native)) {
    return native;
  }
  return process.platform === "win32" ? "claude.exe" : "claude";
}

describe("loadConfig", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecode-config-"));
    process.chdir(tempDir);
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_BACKEND;
    delete process.env.CODEX_APP_SERVER_PATH;
    delete process.env.CODEX_WORKSPACE;
    delete process.env.CODEX_SANDBOX_MODE;
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_LAUNCH_PROFILES_JSON;
    delete process.env.CODEX_DEFAULT_LAUNCH_PROFILE;
    delete process.env.ENABLE_UNSAFE_LAUNCH_PROFILES;
    delete process.env.TOOL_VERBOSITY;
    delete process.env.STREAM_ASSISTANT_TEXT;
    delete process.env.PROGRESS_DELIVERY;
    delete process.env.SHOW_TURN_TOKEN_USAGE;
    delete process.env.MAX_FILE_SIZE;
    delete process.env.ENABLE_TELEGRAM_LOGIN;
    delete process.env.ENABLE_TELEGRAM_REACTIONS;
    delete process.env.ENABLE_CLAUDE_PROVIDER;
    delete process.env.CLAUDE_BIN;
    delete process.env.CLAUDE_SDK_BIN;
    delete process.env.CLAUDE_DEFAULT_MODEL;
    delete process.env.CLAUDE_BACKEND;
    delete process.env.CLAUDE_WORKSPACE;
    delete process.env.CLAUDE_PERMISSION_MODE;
    delete process.env.CLAUDE_LARGE_SESSION_RESUME;
    delete process.env.CLAUDE_TURN_IDLE_TIMEOUT;
    delete process.env.CLAUDE_CONTEXT_WINDOW;
    delete process.env.CLAUDE_AUTO_COMPACT_WINDOW;
    delete process.env.CLAUDE_PARK_IDLE_MS;
    delete process.env.container;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    expect(() => loadConfig()).toThrow("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  });

  it("throws when TELEGRAM_ALLOWED_USER_IDS is missing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";

    expect(() => loadConfig()).toThrow(
      "Missing required environment variable: TELEGRAM_ALLOWED_USER_IDS",
    );
  });

  it("parses a valid config correctly", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";
    process.env.CODEX_API_KEY = "secret-key";
    process.env.CODEX_MODEL = "o3";
    process.env.CODEX_SANDBOX_MODE = "danger-full-access";
    process.env.CODEX_APPROVAL_POLICY = "on-request";
    process.env.TOOL_VERBOSITY = "all";

    const config = loadConfig();

    expect(config).toEqual({
      telegramBotToken: "bot-token",
      telegramAllowedUserIds: [123, 456],
      telegramAllowedUserIdSet: new Set([123, 456]),
      workspace: process.cwd(),
      maxFileSize: 20 * 1024 * 1024,
      codexApiKey: "secret-key",
      codexModel: "o3",
      codexBackend: "app-server",
      codexAppServerPath: undefined,
      codexSandboxMode: "danger-full-access",
      codexApprovalPolicy: "on-request",
      launchProfiles: [
        {
          id: "default",
          label: "Default",
          sandboxMode: "danger-full-access",
          approvalPolicy: "on-request",
          unsafe: true,
        },
        {
          id: "readonly",
          label: "Read Only",
          sandboxMode: "read-only",
          approvalPolicy: "never",
          unsafe: false,
        },
        {
          id: "review",
          label: "Review",
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request",
          unsafe: false,
        },
      ],
      defaultLaunchProfileId: "default",
      enableUnsafeLaunchProfiles: false,
      toolVerbosity: "all",
      streamAssistantText: false,
      progressDelivery: "messages",
      showTurnTokenUsage: false,
      enableTelegramLogin: true,
      enableTelegramReactions: false,
      enableClaudeProvider: false,
      claudeBin: defaultClaudeBinForTest(),
      claudeSdkBin: undefined,
      claudeConfigDir: path.join(homedir(), ".telecode", "claude-config"),
      claudeStrictMcpConfig: true,
      claudeDefaultModel: "sonnet",
      claudeWorkspace: process.cwd(),
      claudePermissionMode: "acceptEdits",
      claudeLargeSessionResume: "summary",
      claudeTurnIdleTimeoutSeconds: 180,
      claudeContextWindow: 200000,
      claudeAutoCompactWindow: 200000,
      claudeParkIdleMs: 180000,
      claudeBackend: "pty",
      claudeMaxParallelTurns: 3,
      codexMaxParallelTurns: 3,
    });
  });

  it("applies default values for optional fields", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const config = loadConfig();

    expect(config.codexApiKey).toBeUndefined();
    expect(config.codexModel).toBeUndefined();
    expect(config.codexBackend).toBe("app-server");
    expect(config.codexAppServerPath).toBeUndefined();
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(config.codexSandboxMode).toBe("workspace-write");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
    ]);
    expect(config.defaultLaunchProfileId).toBe("default");
    expect(config.enableUnsafeLaunchProfiles).toBe(false);
    expect(config.toolVerbosity).toBe("summary");
    expect(config.progressDelivery).toBe("messages");
    expect(config.showTurnTokenUsage).toBe(false);
    expect(config.enableTelegramLogin).toBe(true);
    expect(config.enableTelegramReactions).toBe(false);
    expect(config.enableClaudeProvider).toBe(false);
    expect(config.claudeDefaultModel).toBe("sonnet");
    expect(config.claudeWorkspace).toBe(process.cwd());
    expect(config.claudePermissionMode).toBe("acceptEdits");
    expect(config.claudeLargeSessionResume).toBe("summary");
    expect(config.claudeTurnIdleTimeoutSeconds).toBe(180);
    expect(config.claudeContextWindow).toBe(200000);
    expect(config.claudeAutoCompactWindow).toBe(200000);
    expect(config.workspace).toBe(process.cwd());
  });

  it("throws when a user id is invalid", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,nope";

    expect(() => loadConfig()).toThrow(
      "Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: nope",
    );
  });

  it("rejects an allowed-user list that becomes empty after parsing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = " , , ";

    expect(() => loadConfig()).toThrow("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  });

  it("loads values from .env without overwriting existing environment variables", () => {
    writeFileSync(
      path.join(tempDir, ".env"),
      [
        "# comment",
        "export TELEGRAM_BOT_TOKEN=from-file",
        "TELEGRAM_ALLOWED_USER_IDS=123,456",
        "CODEX_API_KEY='from-dotenv'",
        'CODEX_MODEL="gpt-4.1"',
        "CODEX_SANDBOX_MODE=read-only",
        "CODEX_APPROVAL_POLICY=on-failure",
        'EXTRA_MULTILINE="hello\\nworld"',
      ].join("\n"),
    );
    process.env.TELEGRAM_BOT_TOKEN = "from-process";

    const config = loadConfig();

    expect(config.telegramBotToken).toBe("from-process");
    expect(config.telegramAllowedUserIds).toEqual([123, 456]);
    expect(config.codexApiKey).toBe("from-dotenv");
    expect(config.codexModel).toBe("gpt-4.1");
    expect(config.codexSandboxMode).toBe("read-only");
    expect(config.codexApprovalPolicy).toBe("on-failure");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "read-only",
        approvalPolicy: "on-failure",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
    ]);
    expect(process.env.EXTRA_MULTILINE).toBe("hello\nworld");
  });

  it("resolves workspace to /workspace when running in Docker", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.container = "docker";

    const config = loadConfig();

    expect(config.workspace).toBe("/workspace");
  });

  it("uses CODEX_WORKSPACE when configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_WORKSPACE = path.join(tempDir, "workspace");
    process.env.container = "docker";

    const config = loadConfig();

    expect(config.workspace).toBe(path.join(tempDir, "workspace"));
  });

  it("parses MAX_FILE_SIZE when configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.MAX_FILE_SIZE = String(5 * 1024 * 1024);

    const config = loadConfig();

    expect(config.maxFileSize).toBe(5 * 1024 * 1024);
  });

  it("parses ENABLE_TELEGRAM_LOGIN boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.ENABLE_TELEGRAM_LOGIN = value;
      const config = loadConfig();
      expect(config.enableTelegramLogin).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.ENABLE_TELEGRAM_LOGIN = value;
      const config = loadConfig();
      expect(config.enableTelegramLogin).toBe(false);
    }

    delete process.env.ENABLE_TELEGRAM_LOGIN;
    const config = loadConfig();
    expect(config.enableTelegramLogin).toBe(true);
  });

  it("parses ENABLE_TELEGRAM_REACTIONS boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.ENABLE_TELEGRAM_REACTIONS = value;
      const config = loadConfig();
      expect(config.enableTelegramReactions).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.ENABLE_TELEGRAM_REACTIONS = value;
      const config = loadConfig();
      expect(config.enableTelegramReactions).toBe(false);
    }

    delete process.env.ENABLE_TELEGRAM_REACTIONS;
    const config = loadConfig();
    expect(config.enableTelegramReactions).toBe(false);
  });

  it("parses SHOW_TURN_TOKEN_USAGE boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.SHOW_TURN_TOKEN_USAGE = value;
      const config = loadConfig();
      expect(config.showTurnTokenUsage).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.SHOW_TURN_TOKEN_USAGE = value;
      const config = loadConfig();
      expect(config.showTurnTokenUsage).toBe(false);
    }

    delete process.env.SHOW_TURN_TOKEN_USAGE;
    const config = loadConfig();
    expect(config.showTurnTokenUsage).toBe(false);
  });

  it("parses Claude provider settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.ENABLE_CLAUDE_PROVIDER = "true";
    process.env.CLAUDE_BIN = path.join(tempDir, "claude.exe");
    process.env.CLAUDE_SDK_BIN = path.join(tempDir, "sdk-claude.exe");
    process.env.CLAUDE_CONFIG_DIR_OVERRIDE = path.join(tempDir, "claude-config");
    process.env.CLAUDE_DEFAULT_MODEL = "opus";
    process.env.CLAUDE_WORKSPACE = path.join(tempDir, "claude-workspace");
    process.env.CLAUDE_PERMISSION_MODE = "plan";
    process.env.CLAUDE_LARGE_SESSION_RESUME = "full";
    process.env.CLAUDE_STRICT_MCP_CONFIG = "false";
    process.env.CLAUDE_TURN_IDLE_TIMEOUT = "60";
    process.env.CLAUDE_CONTEXT_WINDOW = "123456";
    process.env.CLAUDE_AUTO_COMPACT_WINDOW = "234567";
    process.env.CLAUDE_PARK_IDLE_MS = "120000";

    const config = loadConfig();

    expect(config.enableClaudeProvider).toBe(true);
    expect(config.claudeBin).toBe(path.join(tempDir, "claude.exe"));
    expect(config.claudeSdkBin).toBe(path.join(tempDir, "sdk-claude.exe"));
    expect(config.claudeConfigDir).toBe(path.join(tempDir, "claude-config"));
    expect(config.claudeStrictMcpConfig).toBe(false);
    expect(config.claudeDefaultModel).toBe("opus");
    expect(config.claudeWorkspace).toBe(path.join(tempDir, "claude-workspace"));
    expect(config.claudePermissionMode).toBe("plan");
    expect(config.claudeLargeSessionResume).toBe("full");
    expect(config.claudeTurnIdleTimeoutSeconds).toBe(60);
    expect(config.claudeContextWindow).toBe(123456);
    expect(config.claudeAutoCompactWindow).toBe(234567);
    expect(config.claudeParkIdleMs).toBe(120000);
  });

  it("requires unsafe launch profiles for Claude bypass permissions", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CLAUDE_PERMISSION_MODE = "bypassPermissions";

    expect(() => loadConfig()).toThrow(
      "CLAUDE_PERMISSION_MODE=bypassPermissions requires ENABLE_UNSAFE_LAUNCH_PROFILES=true",
    );
  });

  it("parses STREAM_ASSISTANT_TEXT boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.STREAM_ASSISTANT_TEXT = value;
      const config = loadConfig();
      expect(config.streamAssistantText).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.STREAM_ASSISTANT_TEXT = value;
      const config = loadConfig();
      expect(config.streamAssistantText).toBe(false);
    }

    delete process.env.STREAM_ASSISTANT_TEXT;
    const config = loadConfig();
    expect(config.streamAssistantText).toBe(false);
  });

  it("parses PROGRESS_DELIVERY values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";

    process.env.PROGRESS_DELIVERY = "none";
    expect(loadConfig().progressDelivery).toBe("none");

    process.env.PROGRESS_DELIVERY = "message";
    expect(loadConfig().progressDelivery).toBe("messages");

    process.env.PROGRESS_DELIVERY = "messages";
    expect(loadConfig().progressDelivery).toBe("messages");

    process.env.PROGRESS_DELIVERY = "edit";
    expect(loadConfig().progressDelivery).toBe("edit");

    process.env.PROGRESS_DELIVERY = "edited";
    expect(loadConfig().progressDelivery).toBe("edit");
  });

  it("parses CODEX_BACKEND and CODEX_APP_SERVER_PATH", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_BACKEND = "app-server";
    process.env.CODEX_APP_SERVER_PATH = path.join(tempDir, "codex.exe");

    const config = loadConfig();

    expect(config.codexBackend).toBe("app-server");
    expect(config.codexAppServerPath).toBe(path.join(tempDir, "codex.exe"));
  });

  it("falls back to defaults for invalid optional enum values", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_BACKEND = "native";
    process.env.CODEX_SANDBOX_MODE = "unsafe";
    process.env.CODEX_APPROVAL_POLICY = "sometimes";
    process.env.TOOL_VERBOSITY = "loud";
    process.env.PROGRESS_DELIVERY = "loud";
    process.env.CLAUDE_PERMISSION_MODE = "loud";
    process.env.CLAUDE_TURN_IDLE_TIMEOUT = "soon";
    process.env.CLAUDE_CONTEXT_WINDOW = "huge";
    process.env.CLAUDE_AUTO_COMPACT_WINDOW = "eventually";
    process.env.CLAUDE_PARK_IDLE_MS = "whenever";
    process.env.MAX_FILE_SIZE = "nope";

    const config = loadConfig();

    expect(config.codexBackend).toBe("app-server");
    expect(config.codexSandboxMode).toBe("workspace-write");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.toolVerbosity).toBe("summary");
    expect(config.progressDelivery).toBe("messages");
    expect(config.claudePermissionMode).toBe("acceptEdits");
    expect(config.claudeTurnIdleTimeoutSeconds).toBe(180);
    expect(config.claudeContextWindow).toBe(200000);
    expect(config.claudeAutoCompactWindow).toBe(200000);
    expect(config.claudeParkIdleMs).toBe(180000);
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(warnSpy).toHaveBeenCalledTimes(11);
  });

  it("treats CLAUDE_PARK_IDLE_MS=0 as parking disabled", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CLAUDE_PARK_IDLE_MS = "0";

    const config = loadConfig();

    expect(config.claudeParkIdleMs).toBe(0);
  });

  it("parses explicit launch profiles and default selection", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.ENABLE_UNSAFE_LAUNCH_PROFILES = "true";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Workspace Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      },
    ]);
    process.env.CODEX_DEFAULT_LAUNCH_PROFILE = "readonly";

    const config = loadConfig();

    expect(config.enableUnsafeLaunchProfiles).toBe(true);
    expect(config.defaultLaunchProfileId).toBe("readonly");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Workspace Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
      {
        id: "full-access",
        label: "Full Access",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        unsafe: true,
      },
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        unsafe: true,
      },
    ]);
  });

  it("throws when CODEX_DEFAULT_LAUNCH_PROFILE is unknown", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
    ]);
    process.env.CODEX_DEFAULT_LAUNCH_PROFILE = "missing";

    expect(() => loadConfig()).toThrow("Unknown CODEX_DEFAULT_LAUNCH_PROFILE: missing");
  });

  it("throws when unsafe extra launch profiles are configured without enabling them", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      },
    ]);

    expect(() => loadConfig()).toThrow(
      'Unsafe launch profile "danger-full" requires ENABLE_UNSAFE_LAUNCH_PROFILES=true',
    );
  });

  it("throws on duplicate launch profile ids", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
      {
        id: "readonly",
        label: "Read Only 2",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
      },
    ]);

    expect(() => loadConfig()).toThrow("Duplicate launch profile id: readonly");
  });
});
