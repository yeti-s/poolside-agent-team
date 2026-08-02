export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const
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
