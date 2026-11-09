import { createHash, randomUUID } from "node:crypto";

import type { TelegramContextKey } from "./context-key.js";
import type { ContextMetadata } from "./session-registry.js";
import type { AgentJobStatus, AgentProviderKind, AgentSessionStatus } from "./providers/types.js";

export type AgentLaneDeliveryMode = "foreground" | "buffer-background";

export interface AgentLaneRecord {
  laneKey: TelegramContextKey;
  selectedSessionId?: string;
  defaultProvider: AgentProviderKind;
  sessionIds: string[];
  deliveryMode: AgentLaneDeliveryMode;
  notifyOnBackgroundCompletion: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSessionRecord {
  id: string;
  laneKey: TelegramContextKey;
  provider: AgentProviderKind;
  workspace: string;
  displayName?: string;
  providerSessionId?: string;
  status: AgentSessionStatus;
  currentJobId?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface AgentJobRecord {
  id: string;
  laneKey: TelegramContextKey;
  sessionId: string;
  provider: AgentProviderKind;
  status: AgentJobStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
}

export interface PersistedAgentSessionState {
  version: 1;
  lanes: AgentLaneRecord[];
  sessions: AgentSessionRecord[];
  jobs: AgentJobRecord[];
}

type Clock = () => number;
type IdGenerator = (prefix: string) => string;

export class AgentSessionManager {
  private readonly lanes = new Map<TelegramContextKey, AgentLaneRecord>();
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly jobs = new Map<string, AgentJobRecord>();
  private readonly now: Clock;
  private readonly idGenerator: IdGenerator;

  constructor(options: { state?: PersistedAgentSessionState; now?: Clock; idGenerator?: IdGenerator } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.idGenerator = options.idGenerator ?? ((prefix) => `${prefix}-${randomUUID().slice(0, 12)}`);

    if (options.state) {
      this.loadState(options.state);
    }
  }

  ensureLane(
    laneKey: TelegramContextKey,
    options: { defaultProvider?: AgentProviderKind } = {},
  ): AgentLaneRecord {
    const existing = this.lanes.get(laneKey);
    if (existing) {
      return cloneLane(existing);
    }

    const timestamp = this.now();
    const lane: AgentLaneRecord = {
      laneKey,
      defaultProvider: options.defaultProvider ?? "codex",
      sessionIds: [],
      deliveryMode: "buffer-background",
      notifyOnBackgroundCompletion: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.lanes.set(laneKey, lane);
    return cloneLane(lane);
  }

  setDefaultProvider(laneKey: TelegramContextKey, provider: AgentProviderKind): AgentLaneRecord {
    const lane = this.requireLane(laneKey);
    lane.defaultProvider = provider;
    lane.updatedAt = this.now();
    return cloneLane(lane);
  }

  createSession(
    laneKey: TelegramContextKey,
    provider: AgentProviderKind,
    options: {
      id?: string;
      workspace: string;
      displayName?: string;
      providerSessionId?: string;
      select?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): AgentSessionRecord {
    if (!this.lanes.has(laneKey)) {
      this.ensureLane(laneKey, { defaultProvider: provider });
    }
    const lane = this.requireLane(laneKey);
    const sessionId = options.id ?? this.idGenerator(`${provider}-session`);
    if (this.sessions.has(sessionId)) {
      throw new Error(`Agent session already exists: ${sessionId}`);
    }

    const timestamp = this.now();
    const session: AgentSessionRecord = {
      id: sessionId,
      laneKey,
      provider,
      workspace: options.workspace,
      displayName: options.displayName,
      providerSessionId: options.providerSessionId,
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: options.metadata,
    };

    this.sessions.set(sessionId, session);
    lane.sessionIds.push(sessionId);
    if (options.select !== false) {
      lane.selectedSessionId = sessionId;
    }
    lane.updatedAt = timestamp;
    return cloneSession(session);
  }

  /**
   * Reconcile the provider session id of an existing record. Claude reveals its real
   * session id only on the first turn (it ignores the id we launch with), so the record
   * created up front holds a placeholder that must be corrected once the turn runs.
   */
  updateProviderSessionId(sessionId: string, providerSessionId: string): AgentSessionRecord {
    const session = this.requireSession(sessionId);
    session.providerSessionId = providerSessionId;
    session.updatedAt = this.now();
    return cloneSession(session);
  }

  updateDisplayName(sessionId: string, displayName: string): AgentSessionRecord {
    const session = this.requireSession(sessionId);
    session.displayName = displayName;
    session.updatedAt = this.now();
    this.touchLane(session.laneKey, session.updatedAt);
    return cloneSession(session);
  }

  updateMetadata(sessionId: string, metadata: Record<string, unknown> | undefined): AgentSessionRecord {
    const session = this.requireSession(sessionId);
    session.metadata = metadata ? { ...metadata } : undefined;
    session.updatedAt = this.now();
    this.touchLane(session.laneKey, session.updatedAt);
    return cloneSession(session);
  }

  selectSession(laneKey: TelegramContextKey, sessionId: string): AgentSessionRecord {
    const lane = this.requireLane(laneKey);
    const session = this.requireSession(sessionId);
    if (session.laneKey !== laneKey) {
      throw new Error(`Agent session ${sessionId} does not belong to lane ${laneKey}`);
    }

    lane.selectedSessionId = sessionId;
    lane.updatedAt = this.now();
    return cloneSession(session);
  }

  getLane(laneKey: TelegramContextKey): AgentLaneRecord | undefined {
    const lane = this.lanes.get(laneKey);
    return lane ? cloneLane(lane) : undefined;
  }

  listLanes(): AgentLaneRecord[] {
    return [...this.lanes.values()].map(cloneLane).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getSession(sessionId: string): AgentSessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : undefined;
  }

  getSelectedSession(laneKey: TelegramContextKey): AgentSessionRecord | undefined {
    const lane = this.lanes.get(laneKey);
    if (!lane?.selectedSessionId) {
      return undefined;
    }
    return this.getSession(lane.selectedSessionId);
  }

  listLaneSessions(laneKey: TelegramContextKey): AgentSessionRecord[] {
    const lane = this.lanes.get(laneKey);
    if (!lane) {
      return [];
    }
    return lane.sessionIds
      .map((sessionId) => this.sessions.get(sessionId))
      .filter((session): session is AgentSessionRecord => Boolean(session))
      .map(cloneSession);
  }

  startJob(sessionId: string, options: { id?: string } = {}): AgentJobRecord {
    const session = this.requireSession(sessionId);
    if (session.currentJobId) {
      throw new Error(`Agent session ${sessionId} already has a running job`);
    }

    const timestamp = this.now();
    const job: AgentJobRecord = {
      id: options.id ?? this.idGenerator("job"),
      laneKey: session.laneKey,
      sessionId,
      provider: session.provider,
      status: "running",
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    this.jobs.set(job.id, job);
    session.currentJobId = job.id;
    session.status = "running";
    session.updatedAt = timestamp;
    this.touchLane(session.laneKey, timestamp);
    return cloneJob(job);
  }

  completeJob(jobId: string): AgentJobRecord {
    return this.finishJob(jobId, "completed");
  }

  failJob(jobId: string, error: string): AgentJobRecord {
    return this.finishJob(jobId, "failed", error);
  }

  abortJob(jobId: string): AgentJobRecord {
    return this.finishJob(jobId, "aborted");
  }

  listJobs(laneKey?: TelegramContextKey): AgentJobRecord[] {
    return [...this.jobs.values()]
      .filter((job) => !laneKey || job.laneKey === laneKey)
      .map(cloneJob)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /** Jobs cannot survive a bridge process restart. Mark persisted in-flight jobs aborted. */
  abortPersistedJobs(): AgentJobRecord[] {
    const aborted: AgentJobRecord[] = [];
    for (const job of [...this.jobs.values()]) {
      if (job.status === "running" || job.status === "waiting") {
        aborted.push(this.abortJob(job.id));
      }
    }
    return aborted;
  }

  importLegacyContexts(
    contexts: ContextMetadata[],
    options: { defaultProvider?: AgentProviderKind; selectImported?: boolean } = {},
  ): AgentSessionRecord[] {
    const imported: AgentSessionRecord[] = [];
    for (const context of contexts) {
      this.lanes.get(context.contextKey) ?? this.ensureLane(context.contextKey, {
        defaultProvider: options.defaultProvider ?? "codex",
      });
      const sessionId = `legacy-codex-${shortHash(context.contextKey)}`;
      const existing = this.sessions.get(sessionId);
      if (existing) {
        existing.providerSessionId = context.threadId ?? undefined;
        existing.workspace = context.workspace;
        existing.metadata = {
          backend: context.backend,
          launchProfileId: context.launchProfileId,
          model: context.model,
          progressDelivery: context.progressDelivery,
          reasoningEffort: context.reasoningEffort,
          legacyContextKey: context.contextKey,
        };
        existing.updatedAt = this.now();
        if (options.selectImported ?? true) {
          this.selectSession(context.contextKey, sessionId);
        }
        imported.push(cloneSession(existing));
        continue;
      }

      const session = this.createSession(context.contextKey, "codex", {
        id: sessionId,
        workspace: context.workspace,
        providerSessionId: context.threadId ?? undefined,
        select: options.selectImported ?? true,
        metadata: {
          backend: context.backend,
          launchProfileId: context.launchProfileId,
          model: context.model,
          progressDelivery: context.progressDelivery,
          reasoningEffort: context.reasoningEffort,
          legacyContextKey: context.contextKey,
        },
      });
      imported.push(session);
    }
    return imported;
  }

  serialize(): PersistedAgentSessionState {
    this.pruneFinishedJobs();
    return {
      version: 1,
      lanes: [...this.lanes.values()].map(cloneLane),
      sessions: [...this.sessions.values()].map(cloneSession),
      jobs: [...this.jobs.values()].map(cloneJob),
    };
  }

  /**
   * The job list is persisted, so without pruning it grows without bound across
   * restarts. Keep every active job plus a bounded tail of recently finished ones.
   */
  private pruneFinishedJobs(keep = 200): void {
    const finished = [...this.jobs.values()]
      .filter((job) => job.status !== "running" && job.status !== "waiting")
      .sort((left, right) => right.updatedAt - left.updatedAt);
    for (const job of finished.slice(keep)) {
      this.jobs.delete(job.id);
    }
  }

  private finishJob(jobId: string, status: Exclude<AgentJobStatus, "running" | "waiting">, error?: string): AgentJobRecord {
    const job = this.requireJob(jobId);
    const session = this.requireSession(job.sessionId);
    const timestamp = this.now();

    job.status = status;
    job.updatedAt = timestamp;
    job.completedAt = timestamp;
    job.error = error;

    if (session.currentJobId === jobId) {
      session.currentJobId = undefined;
      session.status = status;
      session.updatedAt = timestamp;
    }
    this.touchLane(session.laneKey, timestamp);
    return cloneJob(job);
  }

  private loadState(state: PersistedAgentSessionState): void {
    if (state.version !== 1) {
      throw new Error(`Unsupported agent session state version: ${state.version}`);
    }
    for (const lane of state.lanes) {
      this.lanes.set(lane.laneKey, cloneLane(lane));
    }
    for (const session of state.sessions) {
      this.sessions.set(session.id, cloneSession(session));
    }
    for (const job of state.jobs) {
      this.jobs.set(job.id, cloneJob(job));
    }
  }

  private requireLane(laneKey: TelegramContextKey): AgentLaneRecord {
    const lane = this.lanes.get(laneKey);
    if (!lane) {
      throw new Error(`Unknown Telegram lane: ${laneKey}`);
    }
    return lane;
  }

  private requireSession(sessionId: string): AgentSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown agent session: ${sessionId}`);
    }
    return session;
  }

  private requireJob(jobId: string): AgentJobRecord {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown agent job: ${jobId}`);
    }
    return job;
  }

  private touchLane(laneKey: TelegramContextKey, timestamp = this.now()): void {
    const lane = this.lanes.get(laneKey);
    if (lane) {
      lane.updatedAt = timestamp;
    }
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function cloneLane(lane: AgentLaneRecord): AgentLaneRecord {
  return {
    ...lane,
    sessionIds: [...lane.sessionIds],
  };
}

function cloneSession(session: AgentSessionRecord): AgentSessionRecord {
  return {
    ...session,
    metadata: session.metadata ? { ...session.metadata } : undefined,
  };
}

function cloneJob(job: AgentJobRecord): AgentJobRecord {
  return { ...job };
}
