export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'decomposed'] as const
export const MESSAGE_KINDS = ['task', 'handoff', 'decision', 'fyi', 'ack'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]
export type MessageKind = (typeof MESSAGE_KINDS)[number]
export type MemberStatus =
  | 'running'
  | 'idle'
  | 'shutdown_requested'
  | 'stopped'
  | 'failed'

export type MemberTerminationReason = 'completed' | 'shutdown_requested' | 'error' | 'unknown'

export interface TeamMember {
  name: string
  role: 'leader' | 'teammate'
  agentName?: string
  model?: string
  prompt?: string
  joinedAt: string
  status: MemberStatus
  pid?: number
  tmuxWindow?: string
  tmuxPaneId?: string
  exitCode?: number | null
  logPath?: string
  /** Pool interactive-session ID, used by `pool --resume` after a worker restart. */
  sessionId?: string
  terminationReason?: MemberTerminationReason
  lastError?: string
  restartCount?: number
  lastActivityAt?: string
}
export interface TeamTask {
  id: string
  subject: string
  description: string
  status: TaskStatus
  owner?: string
  blocks: string[]
  blockedBy: string[]
  createdAt: string
  updatedAt: string
  /** Last timestamp at which the owner recorded a material task update. */
  lastProgressAt?: string
  /** Optional concise evidence supplied with the last material task update. */
  lastProgressNote?: string
  /** Consecutive leader watchdog checks with no recorded progress. */
  stalledCheckCount?: number
  /** Timestamp of the most recent no-progress watchdog check. */
  lastStallCheckedAt?: string
  /** Set once the watchdog has asked the owner to decompose the task. */
  decompositionRequestedAt?: string
  /** Child tasks created after this task was interrupted for lack of progress. */
  decomposedInto?: string[]
  /** Parent task when this is a focused recovery subtask. */
  parentTaskId?: string
  /** Higher values are delivered before ordinary pending work for the same owner. */
  priority?: number
}

export interface TeamFinalReport {
  status: 'completed' | 'blocked'
  finalizedAt: string
  summary: string
  evidence: string
  blockers?: string
}

export interface TeamMessage {
  id: string
  from: string
  to: string
  body: string
  createdAt: string
  readAt?: string
  kind: 'message' | 'system'
  /** Semantic purpose of a user-sent message. System messages omit this. */
  messageKind?: MessageKind
  /** Whether the recipient should be prompted to take action and report back. */
  requiresResponse?: boolean
}

/** FYI and acknowledgement messages are recorded without interrupting a teammate. */
export function defaultRequiresResponse(messageKind: MessageKind): boolean {
  return messageKind !== 'fyi' && messageKind !== 'ack'
}

export interface TeamState {
  version: 2
  team: {
    name: string
    description?: string
    createdAt: string
    lead: string
    maxMembers: number
    tmuxSession: string
    leaderPid?: number
    heartbeatAt?: string
    watchdogPid?: number
    /** How often the leader watchdog reviews in-progress teammate tasks. */
    progressCheckIntervalMinutes?: number
    /** Consecutive unchanged reviews before a task must be decomposed. */
    maxStalledChecks?: number
    /** Written by team-lead when the team has a final outcome for the main CLI. */
    finalReport?: TeamFinalReport
    /** Last automatic reminder to submit a missing final report. */
    finalizationReminderAt?: string
    /** An executable initial teammate task must be assigned before this deadline. */
    initialAssignmentDeadlineAt?: string
    /** Last time the leader was interrupted for failing to start executable initial work. */
    initialAssignmentEscalatedAt?: string
  }
  nextTaskNumber: number
  nextMessageNumber: number
  members: TeamMember[]
  tasks: TeamTask[]
  messages: TeamMessage[]
}

export interface PublicTeamStatus {
  team: TeamState['team']
  members: Array<TeamMember & { alive?: boolean }>
  taskSummary: Record<TaskStatus, number>
  pendingMessages: number
}
