export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]
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
}

export interface TeamMessage {
  id: string
  from: string
  to: string
  body: string
  createdAt: string
  readAt?: string
  kind: 'message' | 'system'
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
