import { escapeHTML } from "./format.js";

export interface DualText {
  html: string;
  plain: string;
}

/**
 * Grouped command reference for /help.
 */
export function renderHelpMessage(): DualText {
  const sections = [
    {
      title: "🔀 Providers",
      commands: [
        ["/provider", "Show active provider for this context"],
        ["/provider codex|claude", "Set the default provider"],
        ["/claude", "Switch this context to Claude Code"],
        ["/claude <prompt>", "Run one Claude prompt (and switch)"],
        ["/codex", "Switch this context back to Codex"],
        ["/jobs", "List running provider jobs in this context"],
        ["/alljobs", "List running jobs across all contexts"],
      ],
    },
    {
      title: "💬 Session",
      commands: [
        ["/new", "Start in current workspace"],
        ["/new default", "Start in configured workspace"],
        ["/new <workspace>", "Start in another workspace"],
        ["/workspaces", "Choose workspace for new thread"],
        ["/fork", "Start in current workspace"],
        ["/newsummary", "New thread from summary"],
        ["/newsummary default", "Summarize into configured workspace"],
        ["/forkthread [n]", "Fork app-server thread, optionally roll back fork"],
        ["/renamethread <name>", "Rename active app-server thread"],
        ["/rollbackthread <n>", "Roll back app-server thread history"],
        ["/session", "Current thread details"],
        ["/status", "Alias for /session"],
        ["/usage", "Codex limits & reset times"],
        ["/mcp", "Show Codex MCP tools state"],
        ["/mcp on|off", "Toggle browser/computer-use tools"],
        ["/backend", "Show or switch backend"],
        ["/backend appserver", "Switch to app-server backend"],
        ["/backend sdk", "Switch back to SDK backend"],
        ["/verbosity <mode>", "Set progress delivery"],
        ["/appserver", "Probe Codex app-server"],
        ["/appserverturn <prompt>", "Run isolated app-server turn"],
        ["/appserversteer a || b", "Steer isolated app-server turn"],
        ["/appbackendtest", "Smoke-test app-server backend"],
        ["/artifacttest", "Send a generated test file"],
        ["/sessions", "Browse & switch threads"],
        ["/find <words>", "Search all sessions by content (/search alias)"],
        ["/replay [n|all]", "Release buffered background commentary"],
        ["/use <number>", "Switch after /sessions"],
        ["/use previous", "Switch to previous thread"],
        ["/use latest", "Switch to latest thread"],
        ["/switch <id>", "Switch directly to a thread by ID"],
        ["/history", "Show recent local thread history"],
        ["/children", "List child sessions"],
        ["/follow latest", "Switch to newest child session"],
        ["/follow <id>", "Switch to child session"],
        ["/parent", "Return from child session"],
        ["/attach", "Bind a Codex thread to this topic"],
        ["/handback", "Hand thread back to Codex CLI"],
        ["/abort", "Cancel current operation"],
        ["/stop", "Alias for /abort"],
        ["/steer <text>", "Steer active app-server turn"],
        ["/retry", "Resend the last prompt"],
        ["/goal", "Show native goal status"],
        ["/goal <task>", "Start native goal mode"],
        ["/goal pause", "Pause running goal"],
        ["/goal resume", "Resume paused goal"],
        ["/goal clear", "Clear thread goal"],
        ["/goal no-agents <task>", "Goal mode without child sessions"],
        ["/clear", "Forget this Telegram context"],
        ["/last", "Repeat latest completed reply (/copy and /repeat aliases)"],
      ],
    },
    {
      title: "🤖 Model",
      commands: [
        ["/launch_profiles", "Select launch profile"],
        ["/launch_profiles <id>", "Set launch profile"],
        ["/model", "View & change model"],
        ["/model <slug>", "Set model, e.g. 5.5"],
        ["/effort", "Set reasoning effort"],
        ["/effort <level>", "Set effort"],
      ],
    },
    {
      title: "🔐 Auth",
      commands: [
        ["/auth", "Check auth status"],
        ["/login", "Start authentication"],
        ["/claude_login", "Start Claude Code login"],
        ["/logout", "Sign out"],
      ],
    },
    {
      title: "ℹ️ Utility",
      commands: [
        ["/start", "Welcome & status"],
        ["/help", "This reference"],
        ["/health", "Bridge health & delivery diagnostics"],
        ["/voice", "Voice transcription status"],
        ["/video", "Summarize a video by link"],
      ],
    },
    {
      title: "Codex CLI",
      commands: [
        ["/compact", "Compact the active Codex or Claude session"],
        ["/agents", "Forward to Codex"],
        ["/diff", "Forward to Codex"],
        ["/doctor", "Forward to Codex"],
        ["/prompts", "Forward to Codex"],
        ["/memory", "Forward to Codex"],
        ["/mentions", "Forward to Codex"],
        ["/init", "Forward to Codex"],
        ["/bug", "Forward to Codex"],
        ["/config", "Forward to Codex"],
        ["/limits", "Forward to Codex"],
      ],
    },
  ];

  const htmlLines: string[] = [];
  const plainLines: string[] = [];

  for (const section of sections) {
    htmlLines.push(`<b>${escapeHTML(section.title)}</b>`);
    plainLines.push(section.title);
    for (const [cmd, desc] of section.commands) {
      htmlLines.push(`  ${cmd} — ${escapeHTML(desc)}`);
      plainLines.push(`  ${cmd} — ${desc}`);
    }
    htmlLines.push("");
    plainLines.push("");
  }

  while (htmlLines.at(-1) === "") {
    htmlLines.pop();
  }
  while (plainLines.at(-1) === "") {
    plainLines.pop();
  }

  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
  };
}

/**
 * Short /start message for first-time users (no prior interaction in this context).
 */
export function renderWelcomeFirstTime(authWarning?: string): DualText {
  const htmlLines = [
    "<b>👋 TeleCode is ready.</b>",
    "",
    "Send a message to start chatting with Codex.",
    "You can also send voice notes, photos, or documents.",
    "",
    "Type /help for all commands.",
  ];
  const plainLines = [
    "👋 TeleCode is ready.",
    "",
    "Send a message to start chatting with Codex.",
    "You can also send voice notes, photos, or documents.",
    "",
    "Type /help for all commands.",
  ];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Concise /start message for returning users with session info.
 */
export function renderWelcomeReturning(
  sessionHtml: string,
  sessionPlain: string,
  isTopicSession: boolean,
  authWarning?: string,
): DualText {
  const label = isTopicSession ? "TeleCode (topic session)" : "TeleCode";

  const htmlLines = [`<b>👋 ${escapeHTML(label)}</b>`, "", sessionHtml];
  const plainLines = [`👋 ${label}`, "", sessionPlain];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Format a session button label for /sessions list.
 * Wider workspace name (12 chars), model tag, short thread snippet.
 */
export function formatSessionLabel(
  options: {
    id?: string;
    workspace: string;
    title: string;
    relativeTime: string;
    model?: string;
    isActive: boolean;
  },
): string {
  const prefix = options.isActive ? "✅" : "📁";
  const workspaceName = trimLabel(getWorkspaceShortName(options.workspace), 12) || "(unknown)";
  const title = trimLabel(deriveSessionTitle(options.title) || "(untitled)", 20) || "(untitled)";
  const time = options.relativeTime;

  let label = `${prefix} ${workspaceName} · ${title} · ${time}`;

  if (options.model) {
    const shortModel = trimLabel(options.model, 10);
    label += ` · ${shortModel}`;
  }

  if (options.id) {
    label += ` #${options.id.slice(0, 8)}`;
  }

  return label;
}

export function cleanSessionTitle(title: string): string {
  let normalized = title.replace(/\s+/g, " ").trim();
  const outputFilesPrefix =
    /^Output files:\s*write any files the user should receive to\s+.*?[\\/]out\b\s*/i;
  normalized = normalized.replace(outputFilesPrefix, "").trim();

  const summarySeedPrefix =
    /^You are continuing from a previous Codex session\.\s*Treat the following handoff summary as the starting context for this new thread\.\s*Do not redo work unless asked\.\s*Reply only:\s*Summary loaded\.\s*/i;
  normalized = normalized.replace(summarySeedPrefix, "").trim();
  normalized = normalized.replace(/^Current goal:\s*/i, "").trim();

  return normalized;
}

/**
 * Turn a raw first prompt into a short, screen-reader-friendly topic label.
 * Explicit short names are left alone; conversational request wrappers and
 * long prompt details are removed without making another model request.
 */
export function deriveSessionTitle(title: string, maxLength = 72): string {
  let normalized = cleanSessionTitle(title)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  const original = normalized;

  normalized = normalized
    .replace(/^(?:hello|hi|hey)(?: there)?[,.!:\s-]*/i, "")
    .replace(/^(?:please\s+|can you(?: please)?\s+|could you(?: please)?\s+|would you(?: please)?\s+)/i, "")
    .replace(/^i(?:['’]d| would) like (?:you )?to\s+/i, "")
    .replace(/^i (?:want|need) (?:you )?to\s+/i, "")
    .replace(
      /^there(?:['’]s| is) (?:another |a |an )?(?:problem|issue) (?:with|in) [^,]{1,100},\s*(?:which is that\s+)?(?:the\s+)?/i,
      "",
    )
    .trim();

  const workMatch = normalized.match(
    /\b(?:i(?:['’]m| am)|we(?:['’]re| are)) (?:currently )?(?:working|busy) (?:on|with) (?:the )?([^.!?]{8,180})/i,
  );
  if (workMatch?.[1] && (workMatch.index ?? 0) < 100) {
    normalized = workMatch[1].trim();
  }

  normalized = normalized
    .replace(/\bthat gives me detailed observations from the area that i(?:['’]m| am) in(?: in the world)?/i, "with detailed local observations")
    .replace(/\s+(?:and|but)\s+(?:also\s+)?(?:i|we)\s+(?:want|need|was|were|am|are)\b[\s\S]*$/i, "")
    .replace(/\s+(?:and|but)\s+it\s+(?:also\s+)?(?:includes?|keeps?|shows?|lists?|says?|does|is|has|was)\b[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[,:;\s-]+$/g, "")
    .trim();

  const firstSentence = normalized.match(/^(.{12,}?)(?:[.!?](?:\s|$)|$)/u)?.[1]?.trim();
  if (firstSentence) {
    normalized = firstSentence;
  }

  const shortened = trimAtWordBoundary(normalized, maxLength);
  if (!shortened) {
    return "";
  }
  return normalized !== original
    ? `${shortened[0]?.toUpperCase() ?? ""}${shortened.slice(1)}`
    : shortened;
}

function trimLabel(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function trimAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const slice = text.slice(0, Math.max(1, maxLength + 1));
  const lastSpace = slice.lastIndexOf(" ");
  const boundary = lastSpace >= Math.floor(maxLength * 0.6) ? lastSpace : maxLength;
  return text.slice(0, boundary).replace(/[,:;\s-]+$/g, "").trim();
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}
