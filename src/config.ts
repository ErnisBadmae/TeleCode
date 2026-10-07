import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  createBuiltinLaunchProfiles,
  createDefaultLaunchProfile,
  findLaunchProfile,
  isCodexApprovalPolicy,
  isCodexSandboxMode,
  parseLaunchProfilesJson,
  type CodexApprovalPolicy,
  type CodexLaunchProfile,
  type CodexSandboxMode,
} from "./codex-launch.js";

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";
export type ProgressDelivery = "none" | "messages" | "edit";
export type CodexBackend = "sdk" | "app-server";
export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type ClaudeLargeSessionResumePolicy = "summary" | "full" | "manual";

export interface TeleCodeConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  workspace: string;
  maxFileSize: number;
  codexApiKey?: string;
  codexModel?: string;
  codexBackend: CodexBackend;
  codexAppServerPath?: string;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  launchProfiles: CodexLaunchProfile[];
  defaultLaunchProfileId: string;
  enableUnsafeLaunchProfiles: boolean;
  toolVerbosity: ToolVerbosity;
  streamAssistantText: boolean;
  progressDelivery: ProgressDelivery;
  showTurnTokenUsage: boolean;
  enableTelegramLogin: boolean;
  enableTelegramReactions: boolean;
  enableClaudeProvider: boolean;
  claudeBin: string;
  /** SDK-only override; omitted uses the executable bundled with the pinned SDK. */
  claudeSdkBin?: string;
  claudeConfigDir: string;
  claudeStrictMcpConfig: boolean;
  claudeDefaultModel: string;
  claudeWorkspace: string;
  claudePermissionMode: ClaudePermissionMode;
  claudeLargeSessionResume: ClaudeLargeSessionResumePolicy;
  claudeTurnIdleTimeoutSeconds: number;
  claudeContextWindow: number;
  /** Effective Claude Code window used to trigger automatic compaction. */
  claudeAutoCompactWindow: number;
  /**
   * How long an answered SDK query stays alive after its turn ("parked"), so late
   * narration and background task notifications reach Telegram instead of dying
   * with the process. 0 disables parking (legacy teardown-at-answer behavior).
   */
  claudeParkIdleMs: number;
  /** Default Claude engine for contexts that never ran /backend: pty or sdk. */
  claudeBackend: "pty" | "sdk";
  /**
   * Most Claude turns allowed to run at once. Switching away from a running
   * session leaves it running in the background, so this caps how many pile up.
   */
  claudeMaxParallelTurns?: number;
  /** The same cap for Codex turns; each background Codex turn keeps its own app server. */
  codexMaxParallelTurns?: number;
}

export function loadConfig(): TeleCodeConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramAllowedUserIds = parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS"));
  const workspace = resolveWorkspace();
  const maxFileSize = parseMaxFileSize(optionalString(process.env.MAX_FILE_SIZE));
  const codexApiKey = optionalString(process.env.CODEX_API_KEY);
  const codexModel = optionalString(process.env.CODEX_MODEL);
  const codexBackend = parseCodexBackend(optionalString(process.env.CODEX_BACKEND));
  const codexAppServerPath = optionalString(process.env.CODEX_APP_SERVER_PATH);
  const codexSandboxMode = parseSandboxMode(optionalString(process.env.CODEX_SANDBOX_MODE));
  const codexApprovalPolicy = parseApprovalPolicy(optionalString(process.env.CODEX_APPROVAL_POLICY));
  const enableUnsafeLaunchProfiles = parseBooleanEnv(
    optionalString(process.env.ENABLE_UNSAFE_LAUNCH_PROFILES),
    false,
  );
  const launchProfiles = parseLaunchProfiles(
    optionalString(process.env.CODEX_LAUNCH_PROFILES_JSON),
    codexSandboxMode,
    codexApprovalPolicy,
    enableUnsafeLaunchProfiles,
  );
  const defaultLaunchProfileId = parseDefaultLaunchProfileId(
    optionalString(process.env.CODEX_DEFAULT_LAUNCH_PROFILE),
    launchProfiles,
  );
  const toolVerbosity = parseToolVerbosity(optionalString(process.env.TOOL_VERBOSITY));
  const streamAssistantText = parseBooleanEnv(optionalString(process.env.STREAM_ASSISTANT_TEXT), false);
  const progressDelivery = parseProgressDelivery(optionalString(process.env.PROGRESS_DELIVERY));
  const showTurnTokenUsage = parseBooleanEnv(optionalString(process.env.SHOW_TURN_TOKEN_USAGE), false);
  const enableTelegramLogin = parseBooleanEnv(optionalString(process.env.ENABLE_TELEGRAM_LOGIN), true);
  const enableTelegramReactions = parseBooleanEnv(
    optionalString(process.env.ENABLE_TELEGRAM_REACTIONS),
    false,
  );
  const enableClaudeProvider = parseBooleanEnv(optionalString(process.env.ENABLE_CLAUDE_PROVIDER), false);
  const claudeBin = optionalString(process.env.CLAUDE_BIN) ?? defaultClaudeBin();
  const claudeSdkBin = optionalString(process.env.CLAUDE_SDK_BIN);
  // Isolated config dir for TeleCode-spawned claude.exe. Pointing CLAUDE_CONFIG_DIR
  // at a folder that does NOT contain the user-scoped telegram plugin keeps the child
  // from starting a competing getUpdates poller and 409ing the live Telegram bridge.
  const claudeConfigDir = path.resolve(
    optionalString(process.env.CLAUDE_CONFIG_DIR_OVERRIDE) ?? path.join(homedir(), ".telecode", "claude-config"),
  );
  // When true the child launches against the real ~/.claude with --strict-mcp-config,
  // which keeps the user-scoped telegram plugin from starting a competing getUpdates
  // poller (that poller 409s the live bridge). The trade-off is it disables ALL of the
  // user's mcp servers, so it is a stopgap: production wants the real mcp servers running
  // with only the telegram poller neutralized. When false, falls back to the isolated
  // CLAUDE_CONFIG_DIR approach (where interactive turns currently do not execute).
  const claudeStrictMcpConfig = parseBooleanEnv(optionalString(process.env.CLAUDE_STRICT_MCP_CONFIG), true);
  const claudeDefaultModel = optionalString(process.env.CLAUDE_DEFAULT_MODEL) ?? "sonnet";
  const claudeWorkspace = path.resolve(optionalString(process.env.CLAUDE_WORKSPACE) ?? workspace);
  const claudePermissionMode = parseClaudePermissionMode(optionalString(process.env.CLAUDE_PERMISSION_MODE));
  if (claudePermissionMode === "bypassPermissions" && !enableUnsafeLaunchProfiles) {
    throw new Error("CLAUDE_PERMISSION_MODE=bypassPermissions requires ENABLE_UNSAFE_LAUNCH_PROFILES=true");
  }
  const claudeLargeSessionResume = parseClaudeLargeSessionResumePolicy(
    optionalString(process.env.CLAUDE_LARGE_SESSION_RESUME),
  );
  const claudeTurnIdleTimeoutSeconds = parsePositiveIntegerEnv(
    optionalString(process.env.CLAUDE_TURN_IDLE_TIMEOUT),
    180,
    "CLAUDE_TURN_IDLE_TIMEOUT",
  );
  const claudeContextWindow = parsePositiveIntegerEnv(
    optionalString(process.env.CLAUDE_CONTEXT_WINDOW),
    200000,
    "CLAUDE_CONTEXT_WINDOW",
  );
  const claudeAutoCompactWindow = parsePositiveIntegerEnv(
    optionalString(process.env.CLAUDE_AUTO_COMPACT_WINDOW),
    200000,
    "CLAUDE_AUTO_COMPACT_WINDOW",
  );
  const claudeMaxParallelTurns = parsePositiveIntegerEnv(
    optionalString(process.env.CLAUDE_MAX_PARALLEL_TURNS),
    3,
    "CLAUDE_MAX_PARALLEL_TURNS",
  );
  const codexMaxParallelTurns = parsePositiveIntegerEnv(
    optionalString(process.env.CODEX_MAX_PARALLEL_TURNS),
    3,
    "CODEX_MAX_PARALLEL_TURNS",
  );
  const rawClaudeParkIdleMs = optionalString(process.env.CLAUDE_PARK_IDLE_MS);
  let claudeParkIdleMs = 180_000;
  if (rawClaudeParkIdleMs !== undefined) {
    const parsed = Number(rawClaudeParkIdleMs);
    if (!Number.isInteger(parsed) || parsed < 0) {
      console.warn(`Invalid CLAUDE_PARK_IDLE_MS value: "${rawClaudeParkIdleMs}". Falling back to ${claudeParkIdleMs}.`);
    } else {
      claudeParkIdleMs = parsed;
    }
  }
  const rawClaudeBackend = optionalString(process.env.CLAUDE_BACKEND) ?? "pty";
  if (rawClaudeBackend !== "pty" && rawClaudeBackend !== "sdk") {
    throw new Error(`CLAUDE_BACKEND must be "pty" or "sdk", got: ${rawClaudeBackend}`);
  }

  return {
    telegramBotToken,
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    workspace,
    maxFileSize,
    codexApiKey,
    codexModel,
    codexBackend,
    codexAppServerPath,
    codexSandboxMode,
    codexApprovalPolicy,
    launchProfiles,
    defaultLaunchProfileId,
    enableUnsafeLaunchProfiles,
    toolVerbosity,
    streamAssistantText,
    progressDelivery,
    showTurnTokenUsage,
    enableTelegramLogin,
    enableTelegramReactions,
    enableClaudeProvider,
    claudeBin,
    claudeSdkBin,
    claudeConfigDir,
    claudeStrictMcpConfig,
    claudeDefaultModel,
    claudeWorkspace,
    claudePermissionMode,
    claudeLargeSessionResume,
    claudeTurnIdleTimeoutSeconds,
    claudeContextWindow,
    claudeAutoCompactWindow,
    claudeParkIdleMs,
    claudeBackend: rawClaudeBackend,
    claudeMaxParallelTurns,
    codexMaxParallelTurns,
  };
}

/**
 * Workspace is derived automatically:
 * - CODEX_WORKSPACE when set
 * - In Docker: /workspace (the mount point)
 * - Outside Docker: process.cwd()
 */
function resolveWorkspace(): string {
  const configuredWorkspace = optionalString(process.env.CODEX_WORKSPACE);
  if (configuredWorkspace) {
    return path.resolve(configuredWorkspace);
  }

  if (isRunningInDocker()) {
    return "/workspace";
  }
  return process.cwd();
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

function defaultClaudeBin(): string {
  // Claude Code's native installer places the binary under ~/.local/bin.
  // Prefer that location when it exists; otherwise rely on PATH resolution.
  const native = path.join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  if (existsSync(native)) {
    return native;
  }
  return process.platform === "win32" ? "claude.exe" : "claude";
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseAllowedUserIds(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: ${value}`);
      }
      return parsed;
    });

  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  }

  return ids;
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }

  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no") {
    return false;
  }

  console.warn(`Invalid boolean env value: "${raw}". Falling back to ${defaultValue}.`);
  return defaultValue;
}

function parseMaxFileSize(raw: string | undefined): number {
  if (!raw) {
    return 20 * 1024 * 1024;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`Invalid MAX_FILE_SIZE value: "${raw}". Falling back to 20 MB.`);
    return 20 * 1024 * 1024;
  }

  return parsed;
}

function parseSandboxMode(raw: string | undefined): CodexSandboxMode {
  if (!raw) {
    return "workspace-write";
  }

  if (!isCodexSandboxMode(raw)) {
    console.warn(
      `Invalid CODEX_SANDBOX_MODE value: "${raw}". Expected one of: read-only, workspace-write, danger-full-access. Falling back to "workspace-write".`,
    );
    return "workspace-write";
  }

  return raw;
}

function parseApprovalPolicy(raw: string | undefined): CodexApprovalPolicy {
  if (!raw) {
    return "never";
  }

  if (!isCodexApprovalPolicy(raw)) {
    console.warn(
      `Invalid CODEX_APPROVAL_POLICY value: "${raw}". Expected one of: never, on-request, on-failure, untrusted. Falling back to "never".`,
    );
    return "never";
  }

  return raw;
}

function parseToolVerbosity(raw: string | undefined): ToolVerbosity {
  if (!raw) {
    return "summary";
  }

  switch (raw) {
    case "all":
    case "summary":
    case "errors-only":
    case "none":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_VERBOSITY value: "${raw}". Expected one of: all, summary, errors-only, none. Falling back to "summary".`,
      );
      return "summary";
  }
}

function parsePositiveIntegerEnv(raw: string | undefined, defaultValue: number, name: string): number {
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`Invalid ${name} value: "${raw}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }
  return parsed;
}

function parseProgressDelivery(raw: string | undefined): ProgressDelivery {
  if (!raw) {
    return "messages";
  }

  switch (raw.toLowerCase()) {
    case "none":
    case "off":
      return "none";
    case "message":
    case "messages":
      return "messages";
    case "edit":
    case "edited":
      return "edit";
    default:
      console.warn(
        `Invalid PROGRESS_DELIVERY value: "${raw}". Expected one of: none, messages, edit. Falling back to "messages".`,
      );
      return "messages";
  }
}

function parseCodexBackend(raw: string | undefined): CodexBackend {
  if (!raw) {
    return "app-server";
  }

  switch (raw) {
    case "sdk":
    case "app-server":
      return raw;
    default:
      console.warn(
        `Invalid CODEX_BACKEND value: "${raw}". Expected one of: sdk, app-server. Falling back to "app-server".`,
      );
      return "app-server";
  }
}

function parseClaudePermissionMode(raw: string | undefined): ClaudePermissionMode {
  if (!raw) {
    return "acceptEdits";
  }

  switch (raw) {
    case "default":
    case "acceptEdits":
    case "plan":
    case "bypassPermissions":
      return raw;
    default:
      console.warn(
        `Invalid CLAUDE_PERMISSION_MODE value: "${raw}". Expected one of: default, acceptEdits, plan, bypassPermissions. Falling back to "acceptEdits".`,
      );
      return "acceptEdits";
  }
}

function parseClaudeLargeSessionResumePolicy(raw: string | undefined): ClaudeLargeSessionResumePolicy {
  if (!raw) {
    return "summary";
  }

  switch (raw.toLowerCase()) {
    case "summary":
    case "summarize":
    case "recommended":
      return "summary";
    case "full":
    case "asis":
    case "as-is":
      return "full";
    case "manual":
    case "ask":
    case "stop":
      return "manual";
    default:
      console.warn(
        `Invalid CLAUDE_LARGE_SESSION_RESUME value: "${raw}". Expected one of: summary, full, manual. Falling back to "summary".`,
      );
      return "summary";
  }
}

function parseLaunchProfiles(
  raw: string | undefined,
  codexSandboxMode: CodexSandboxMode,
  codexApprovalPolicy: CodexApprovalPolicy,
  enableUnsafeLaunchProfiles: boolean,
): CodexLaunchProfile[] {
  const defaultProfile = createDefaultLaunchProfile(codexSandboxMode, codexApprovalPolicy);
  const profiles = createBuiltinLaunchProfiles(defaultProfile, {
    includeFullAccess: enableUnsafeLaunchProfiles,
  });

  if (!raw) {
    return profiles;
  }

  const parsedProfiles = parseLaunchProfilesJson(raw);
  const profileIndexes = new Map(profiles.map((profile, index) => [profile.id, index]));
  const explicitIds = new Set<string>();

  for (const profile of parsedProfiles) {
    if (profile.id === defaultProfile.id || explicitIds.has(profile.id)) {
      throw new Error(`Duplicate launch profile id: ${profile.id}`);
    }
    if (profile.unsafe && !enableUnsafeLaunchProfiles) {
      throw new Error(
        `Unsafe launch profile "${profile.id}" requires ENABLE_UNSAFE_LAUNCH_PROFILES=true`,
      );
    }

    const existingIndex = profileIndexes.get(profile.id);
    if (existingIndex === undefined) {
      profiles.push(profile);
      profileIndexes.set(profile.id, profiles.length - 1);
    } else {
      profiles[existingIndex] = profile;
    }

    explicitIds.add(profile.id);
  }

  return profiles;
}

function parseDefaultLaunchProfileId(
  raw: string | undefined,
  launchProfiles: CodexLaunchProfile[],
): string {
  if (!raw) {
    return launchProfiles[0]!.id;
  }

  const profile = findLaunchProfile(launchProfiles, raw);
  if (!profile) {
    throw new Error(`Unknown CODEX_DEFAULT_LAUNCH_PROFILE: ${raw}`);
  }

  return profile.id;
}
