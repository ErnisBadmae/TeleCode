export type AgentProviderKind = "codex" | "claude" | "antigravity" | (string & {});

export type AgentSessionStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "aborted";

export type AgentJobStatus = "running" | "waiting" | "completed" | "failed" | "aborted";

export interface AgentProviderCapabilities {
  streamingText: boolean;
  streamingInput: boolean;
  abort: boolean;
  fork: boolean;
  rename: boolean;
  compact: boolean;
  usage: boolean;
  context: boolean;
  slashCommands: boolean;
  permissions: boolean;
  userQuestions: boolean;
  artifacts: boolean;
}

export const emptyProviderCapabilities: AgentProviderCapabilities = {
  streamingText: false,
  streamingInput: false,
  abort: false,
  fork: false,
  rename: false,
  compact: false,
  usage: false,
  context: false,
  slashCommands: false,
  permissions: false,
  userQuestions: false,
  artifacts: false,
};

export interface AgentSessionDescriptor {
  id: string;
  provider: AgentProviderKind;
  workspace: string;
  displayName?: string;
  providerSessionId?: string;
  status: AgentSessionStatus;
  capabilities: AgentProviderCapabilities;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface AgentPromptInput {
  text?: string;
  imagePaths?: string[];
  filePaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  /** Provider-rendered prompt sentence, e.g. "Claude wants to run ...". */
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  /** True when the provider offered rules that stop this prompt from recurring. */
  canAllowAlways: boolean;
  /** Aborted when the turn ends before the user answers. */
  signal: AbortSignal;
}

export type AgentPermissionDecision = "allow" | "allow_always" | "deny";

export interface AgentSendPromptOptions {
  sessionId: string;
  jobId: string;
  input: AgentPromptInput;
  abortSignal?: AbortSignal;
  /** Asks the user about a tool call outside the allow rules; absent means deny. */
  onPermissionRequest?: (request: AgentPermissionRequest) => Promise<AgentPermissionDecision>;
}

export type AgentProviderEvent =
  | {
      type: "assistant_text_delta";
      sessionId: string;
      jobId: string;
      text: string;
    }
  | {
      type: "assistant_message_complete";
      sessionId: string;
      jobId: string;
      text: string;
    }
  | {
      type: "tool_started" | "tool_completed" | "tool_failed";
      sessionId: string;
      jobId: string;
      toolName: string;
      text?: string;
    }
  | {
      type: "permission_requested";
      sessionId: string;
      jobId: string;
      requestId: string;
      prompt: string;
      choices?: string[];
    }
  | {
      type: "user_question_requested";
      sessionId: string;
      jobId: string;
      requestId: string;
      question: string;
      choices?: string[];
    }
  | {
      type: "artifact_produced";
      sessionId: string;
      jobId: string;
      path: string;
      label?: string;
    }
  | {
      type: "session_status_changed";
      sessionId: string;
      status: AgentSessionStatus;
    }
  | {
      type: "status_message";
      sessionId: string;
      jobId?: string;
      text: string;
    }
  | {
      type: "session_title_changed";
      sessionId: string;
      title: string;
    }
  | {
      type: "model_updated";
      sessionId: string;
      jobId?: string;
      model: string;
    }
  | {
      type: "usage_updated";
      sessionId: string;
      jobId?: string;
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      /**
       * How full the context is right now, as opposed to what the turn cost.
       * The SDK's turn totals sum every API call in the turn, so a long
       * agentic turn re-counts the same cached prefix dozens of times; only
       * the last request's prompt size describes the live context.
       */
      contextTokens?: number;
    }
  | {
      type: "compact_boundary";
      sessionId: string;
      summary?: string;
      /** Context tokens remaining after the compaction, when the transcript reports it. */
      postTokens?: number;
    }
  | {
      type: "error";
      sessionId?: string;
      jobId?: string;
      message: string;
      cause?: unknown;
    };

export interface CreateAgentSessionOptions {
  workspace: string;
  displayName?: string;
  resumeProviderSessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentProviderAdapter {
  readonly id: AgentProviderKind;
  readonly displayName: string;
  readonly capabilities: AgentProviderCapabilities;

  createSession(options: CreateAgentSessionOptions): Promise<AgentSessionDescriptor>;
  resumeSession(session: AgentSessionDescriptor): Promise<AgentSessionDescriptor>;
  listSessions?(): Promise<AgentSessionDescriptor[]>;
  getSessionInfo(sessionId: string): Promise<AgentSessionDescriptor>;
  sendPrompt(options: AgentSendPromptOptions): AsyncIterable<AgentProviderEvent>;
  streamInput?(sessionId: string, input: AgentPromptInput): Promise<void>;
  abort?(sessionId: string, jobId?: string): Promise<void>;
  fork?(sessionId: string): Promise<AgentSessionDescriptor>;
  rename?(sessionId: string, displayName: string): Promise<AgentSessionDescriptor>;
  compact?(sessionId: string, instructions?: string): Promise<void>;
  getUsage?(sessionId: string): Promise<Record<string, unknown>>;
  getContext?(sessionId: string): Promise<Record<string, unknown>>;
  dispose?(sessionId?: string): Promise<void>;
}
