import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  PublicTeamStatus,
  TaskStatus,
  TeamMember,
  TeamFinalReport,
  TeamMessage,
  TeamState,
  TeamTask,
} from './types.js'

const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5_000
export const DEFAULT_MAX_MEMBERS = 4
export const LEADER_HEARTBEAT_TIMEOUT_MS = 8_000
export const DEFAULT_PROGRESS_CHECK_INTERVAL_MINUTES = 5
export const DEFAULT_MAX_STALLED_CHECKS = 2
export const INITIAL_ASSIGNMENT_TIMEOUT_MS = 60_000

export interface TaskProgressCheck {
  task: TeamTask
  status: 'active' | 'remind' | 'decompose' | 'already_escalated'
}

export interface PlannedTeamMember {
  name: string
  prompt: string
  agentName?: string
  model?: string
}

export interface TeamCreationPlan {
  id: string
  teamName: string
  description: string
  leader: PlannedTeamMember
  teammates: PlannedTeamMember[]
  maxMembers: number
  progressCheckIntervalMinutes?: number
  maxStalledChecks?: number
  createdAt: string
}

export class TeamError extends Error {}

export function sanitizeTeamName(name: string): string {
  const value = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  const sanitized = value.replace(/^-+|-+$/g, '')
  if (!sanitized) throw new TeamError('team_name must contain a letter or number')
  return sanitized
}
export function validateMemberName(name: string): string {
  const value = name.trim().toLowerCase()
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(value)) {
    throw new TeamError(
      'member name must start with a letter and contain only lowercase letters, numbers, hyphens, or underscores',
    )
  }
  return value
}

export class TeamStore {
  private resolvedStatePath?: string
  private readonly legacyStatePath: string
  private readonly planPath: string

  constructor(readonly projectRoot: string, statePath?: string) {
    this.resolvedStatePath = statePath
    this.legacyStatePath = join(projectRoot, '.poolside', 'agent-team', 'state.json')
    this.planPath = statePath
      ? join(dirname(statePath), 'plans.json')
      : join(projectRoot, '.poolside', 'agent-team', 'plans.json')
  }

  get statePath(): string {
    return this.resolvedStatePath ?? this.legacyStatePath
  }

  private get lockPath(): string {
    return join(dirname(this.statePath), 'state.lock')
  }

  private async resolveActiveStatePath(): Promise<void> {
    if (this.resolvedStatePath) return
    try {
      await readFile(this.legacyStatePath, 'utf8')
      return
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error
    }
    const root = dirname(this.legacyStatePath)
    try {
      const entries = await readdir(root, { withFileTypes: true })
      const teamDirectories = entries.filter(entry => entry.isDirectory()).map(entry => join(root, entry.name, 'state.json'))
      const existing: string[] = []
      for (const candidate of teamDirectories) {
        try {
          await readFile(candidate, 'utf8')
          existing.push(candidate)
        } catch (error: unknown) {
          if (!isNotFound(error)) throw error
        }
      }
      if (existing.length === 1) this.resolvedStatePath = existing[0]
      if (existing.length > 1) throw new TeamError('multiple active standalone team states were found')
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error
    }
  }

  async createPlan(input: Omit<TeamCreationPlan, 'id' | 'createdAt'>): Promise<TeamCreationPlan> {
    const release = await this.acquireLock()
    try {
      const plans = await this.readPlans()
      const plan: TeamCreationPlan = {
        ...input,
        id: `team-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
      }
      plans.push(plan)
      await mkdir(dirname(this.planPath), { recursive: true })
      await writeFile(this.planPath, `${JSON.stringify(plans, null, 2)}\n`, 'utf8')
      return plan
    } finally {
      await release()
    }
  }

  async getPlan(id: string): Promise<TeamCreationPlan> {
    const plan = (await this.readPlans()).find(item => item.id === id)
    if (!plan) throw new TeamError(`team plan "${id}" was not found`)
    return plan
  }

  async read(): Promise<TeamState | undefined> {
    await this.resolveActiveStatePath()
    try {
      return normalizeState(JSON.parse(await readFile(this.statePath, 'utf8')))
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  async create(input: {
    teamName: string
    description?: string
    maxMembers: number
    tmuxSession: string
    leaderPid: number
    leaderName?: string
    progressCheckIntervalMinutes?: number
    maxStalledChecks?: number
  }): Promise<TeamState> {
    if (!this.resolvedStatePath) {
      this.resolvedStatePath = join(this.projectRoot, '.poolside', 'agent-team', sanitizeTeamName(input.teamName), 'state.json')
    }
    return this.mutate(async current => {
      if (current) throw new TeamError(`team "${current.team.name}" already exists`)
      const now = new Date().toISOString()
      return {
        version: 2,
        team: {
          name: input.teamName,
          description: input.description,
          createdAt: now,
          lead: input.leaderName ?? 'team-lead',
          maxMembers: input.maxMembers,
          tmuxSession: input.tmuxSession,
          leaderPid: input.leaderPid,
          heartbeatAt: now,
          progressCheckIntervalMinutes: input.progressCheckIntervalMinutes ?? DEFAULT_PROGRESS_CHECK_INTERVAL_MINUTES,
          maxStalledChecks: input.maxStalledChecks ?? DEFAULT_MAX_STALLED_CHECKS,
        },
        nextTaskNumber: 1,
        nextMessageNumber: 1,
        members: [
          {
            name: input.leaderName ?? 'team-lead',
            role: 'leader',
            joinedAt: now,
            status: 'idle',
          },
        ],
        tasks: [],
        messages: [],
      }
    })
  }

  async mutate(
    action: (current: TeamState | undefined) => Promise<TeamState> | TeamState,
  ): Promise<TeamState> {
    await this.resolveActiveStatePath()
    const release = await this.acquireLock()
    try {
      const result = await action(await this.read())
      await mkdir(dirname(this.statePath), { recursive: true })
      const temporaryPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.statePath)
      return result
    } finally {
      await release()
    }
  }

  async remove(): Promise<void> {
    await this.resolveActiveStatePath()
    const release = await this.acquireLock()
    try {
      await rm(dirname(this.statePath), { recursive: true, force: true })
    } finally {
      await release()
    }
  }

  /** Start leadership monitoring only after the main CLI has delivered the initial team objective. */
  async beginWork(): Promise<TeamState> {
    return this.updateTeam(team => {
      if (!team.initialAssignmentDeadlineAt) {
        team.initialAssignmentDeadlineAt = new Date(Date.now() + INITIAL_ASSIGNMENT_TIMEOUT_MS).toISOString()
      }
    })
  }

  private async readPlans(): Promise<TeamCreationPlan[]> {
    try {
      return JSON.parse(await readFile(this.planPath, 'utf8')) as TeamCreationPlan[]
    } catch (error: unknown) {
      if (isNotFound(error)) return []
      throw error
    }
  }

  async addMember(member: TeamMember): Promise<TeamState> {
    return this.mutate(current => {
      const state = requireTeam(current)
      const activeMembers = state.members.filter(
        existing => existing.role === 'leader' || !['stopped', 'failed'].includes(existing.status),
      )
      if (activeMembers.length >= state.team.maxMembers) {
        throw new TeamError(
          `active team member limit reached (${state.team.maxMembers}, including team-lead)`,
        )
      }
      if (state.members.some(existing => existing.name === member.name)) {
        throw new TeamError(`member "${member.name}" already exists`)
      }
      state.members.push(member)
      return state
    })
  }

  async updateMember(
    name: string,
    update: (member: TeamMember) => void,
  ): Promise<TeamState> {
    return this.mutate(current => {
      const state = requireTeam(current)
      const member = state.members.find(item => item.name === name)
      if (!member) throw new TeamError(`member "${name}" was not found`)
      update(member)
      return state
    })
  }

  async updateTeam(update: (team: TeamState['team']) => void): Promise<TeamState> {
    return this.mutate(current => {
      const state = requireTeam(current)
      update(state.team)
      return state
    })
  }

  /**
   * A completed-team broadcast is the durable fallback when a lead omits the
   * explicit team_finalize call. It is intentionally accepted only after all
   * tracked work has reached a terminal state.
   */
  async finalizeFromLeadBroadcast(input: { leader: string, summary: string }): Promise<TeamFinalReport | undefined> {
    let report: TeamFinalReport | undefined
    await this.mutate(current => {
      const state = requireTeam(current)
      if (state.team.lead !== input.leader || state.team.finalReport || state.tasks.length === 0 || hasUnresolvedTasks(state)) return state
      const completed = state.tasks
        .map(task => `#${task.id} ${task.subject}: ${(task.lastProgressNote ?? 'completed').slice(0, 500)}`)
        .join('\n')
      report = {
        status: 'completed',
        finalizedAt: new Date().toISOString(),
        summary: input.summary.trim(),
        evidence: `All ${state.tasks.length} tracked tasks reached a terminal state.\n${completed}`.slice(0, 20_000),
      }
      state.team.finalReport = report
      return state
    })
    return report
  }

  async addTask(input: {
    subject: string
    description: string
    owner?: string
    blocks?: string[]
    dependsOn?: string[]
    parentTaskId?: string
    priority?: number
  }): Promise<TeamTask> {
    let created!: TeamTask
    await this.mutate(current => {
      const state = requireTeam(current)
      if (input.owner) assertMember(state, input.owner)
      const blocks = input.blocks ?? []
      const dependsOn = input.dependsOn ?? []
      assertTaskIds(state, blocks)
      assertTaskIds(state, dependsOn)
      const now = new Date().toISOString()
      created = {
        id: String(state.nextTaskNumber++),
        subject: input.subject.trim(),
        description: input.description.trim(),
        status: 'pending',
        owner: input.owner,
        blocks,
        blockedBy: [...new Set(dependsOn)],
        parentTaskId: input.parentTaskId,
        priority: input.priority ?? 0,
        createdAt: now,
        updatedAt: now,
        lastProgressAt: now,
        lastProgressNote: 'Task created',
      }
      state.tasks.push(created)
      clearInitialAssignmentDeadlineWhenExecutable(state)
      for (const blockedTaskId of blocks) {
        const blocked = getTask(state, blockedTaskId)
        if (!blocked.blockedBy.includes(created.id)) blocked.blockedBy.push(created.id)
      }
      return state
    })
    return created
  }

  async decomposeTask(input: {
    taskId: string
    children: Array<{ subject: string, description: string, owner: string, dependsOn?: string[] }>
  }): Promise<{ parent: TeamTask, children: TeamTask[] }> {
    let result!: { parent: TeamTask, children: TeamTask[] }
    await this.mutate(current => {
      const state = requireTeam(current)
      const parent = getTask(state, input.taskId)
      if (parent.status === 'completed' || parent.status === 'decomposed') {
        throw new TeamError(`task "${parent.id}" cannot be decomposed from status "${parent.status}"`)
      }
      if (input.children.length < 2 || input.children.length > 4) {
        throw new TeamError('a decomposition must contain between 2 and 4 child tasks')
      }
      const now = new Date().toISOString()
      const children: TeamTask[] = []
      for (const childInput of input.children) {
        assertMember(state, childInput.owner)
        const dependsOn = [...new Set(childInput.dependsOn ?? [])]
        if (dependsOn.includes(parent.id)) throw new TeamError('a decomposition child cannot depend on its parent')
        assertTaskIds(state, dependsOn)
        const child: TeamTask = {
          id: String(state.nextTaskNumber++),
          subject: childInput.subject.trim(),
          description: childInput.description.trim(),
          status: 'pending',
          owner: childInput.owner,
          blocks: [],
          blockedBy: dependsOn,
          parentTaskId: parent.id,
          priority: 100,
          createdAt: now,
          updatedAt: now,
          lastProgressAt: now,
          lastProgressNote: `Created from stalled task #${parent.id}`,
        }
        state.tasks.push(child)
        children.push(child)
      }
      parent.status = 'decomposed'
      parent.decomposedInto = children.map(child => child.id)
      parent.updatedAt = now
      parent.lastProgressAt = now
      parent.lastProgressNote = `Interrupted and decomposed into tasks: ${parent.decomposedInto.join(', ')}`
      parent.stalledCheckCount = 0
      parent.lastStallCheckedAt = undefined
      result = { parent: structuredClone(parent), children: structuredClone(children) }
      return state
    })
    return result
  }

  async updateTask(
    id: string,
    input: {
      subject?: string
      description?: string
      status?: TaskStatus
      owner?: string | null
      blocks?: string[]
      dependsOn?: string[]
      progressNote?: string
    },
  ): Promise<TeamTask> {
    let updated!: TeamTask
    await this.mutate(current => {
      const state = requireTeam(current)
      const task = getTask(state, id)
      if (input.owner !== undefined && input.owner !== null) assertMember(state, input.owner)
      const previous = structuredClone(task)
      if (input.blocks) {
        if (input.blocks.includes(id)) throw new TeamError('a task cannot block itself')
        assertTaskIds(state, input.blocks)
        for (const oldId of task.blocks) {
          const oldBlocked = getTask(state, oldId)
          oldBlocked.blockedBy = oldBlocked.blockedBy.filter(value => value !== id)
        }
        task.blocks = [...new Set(input.blocks)]
        for (const newId of task.blocks) {
          const newBlocked = getTask(state, newId)
          if (!newBlocked.blockedBy.includes(id)) newBlocked.blockedBy.push(id)
        }
      }
      if (input.dependsOn) {
        if (input.dependsOn.includes(id)) throw new TeamError('a task cannot depend on itself')
        assertTaskIds(state, input.dependsOn)
        task.blockedBy = [...new Set(input.dependsOn)]
      }
      if (input.subject !== undefined) task.subject = input.subject.trim()
      if (input.description !== undefined) task.description = input.description.trim()
      if (input.status !== undefined) task.status = input.status
      if (task.status === 'in_progress') {
        const incompleteBlockers = task.blockedBy.filter(
          blockerId => getTask(state, blockerId).status !== 'completed',
        )
        if (incompleteBlockers.length > 0) {
          throw new TeamError(`task "${id}" is blocked by: ${incompleteBlockers.join(', ')}`)
        }
      }
      if (input.owner !== undefined) task.owner = input.owner ?? undefined
      clearInitialAssignmentDeadlineWhenExecutable(state)
      const now = new Date().toISOString()
      task.updatedAt = now
      const progressNote = input.progressNote?.trim()
      const madeProgress = Boolean(progressNote)
        || task.subject !== previous.subject
        || task.description !== previous.description
        || task.status !== previous.status
        || task.owner !== previous.owner
        || JSON.stringify(task.blocks) !== JSON.stringify(previous.blocks)
        || JSON.stringify(task.blockedBy) !== JSON.stringify(previous.blockedBy)
      if (madeProgress) {
        task.lastProgressAt = now
        task.lastProgressNote = progressNote ?? task.lastProgressNote
        task.stalledCheckCount = 0
        task.lastStallCheckedAt = undefined
        task.decompositionRequestedAt = undefined
      }
      updated = structuredClone(task)
      return state
    })
    return updated
  }

  async addMessage(input: {
    from: string
    to: string
    body: string
    kind?: TeamMessage['kind']
    messageKind?: TeamMessage['messageKind']
    requiresResponse?: boolean
  }): Promise<TeamMessage> {
    let created!: TeamMessage
    await this.mutate(current => {
      const state = requireTeam(current)
      if (input.from !== 'system' && !input.from.startsWith('team:')) assertMember(state, input.from)
      if (input.to !== '*') assertMember(state, input.to)
      created = {
        id: String(state.nextMessageNumber++),
        from: input.from,
        to: input.to,
        body: input.body.trim(),
        createdAt: new Date().toISOString(),
        kind: input.kind ?? 'message',
        messageKind: input.messageKind,
        requiresResponse: input.requiresResponse,
      }
      state.messages.push(created)
      return state
    })
    return created
  }

  /**
   * Record one leader watchdog review. A task is escalated only once per
   * unchanged stretch; a material task update resets its stall counter.
   */
  async checkTaskProgress(input: {
    taskId: string
    intervalMs: number
    maxStalledChecks: number
    now?: number
  }): Promise<TaskProgressCheck> {
    let result!: TaskProgressCheck
    await this.mutate(current => {
      const state = requireTeam(current)
      const task = getTask(state, input.taskId)
      const now = input.now ?? Date.now()
      const progressAt = Date.parse(task.lastProgressAt ?? task.updatedAt)
      if (!Number.isFinite(progressAt) || now - progressAt < input.intervalMs) {
        result = { task: structuredClone(task), status: 'active' }
        return state
      }
      const lastCheckAt = Date.parse(task.lastStallCheckedAt ?? '')
      task.stalledCheckCount = Number.isFinite(lastCheckAt) && lastCheckAt >= progressAt
        ? (task.stalledCheckCount ?? 0) + 1
        : 1
      task.lastStallCheckedAt = new Date(now).toISOString()
      if (task.stalledCheckCount >= input.maxStalledChecks) {
        if (!task.decompositionRequestedAt) {
          task.decompositionRequestedAt = task.lastStallCheckedAt
          result = { task: structuredClone(task), status: 'decompose' }
        } else {
          result = { task: structuredClone(task), status: 'already_escalated' }
        }
      } else {
        result = { task: structuredClone(task), status: 'remind' }
      }
      return state
    })
    return result
  }

  async messagesFor(name: string, markRead: boolean): Promise<TeamMessage[]> {
    let messages: TeamMessage[] = []
    await this.mutate(current => {
      const state = requireTeam(current)
      assertMember(state, name)
      messages = state.messages
        .filter(message => message.to === name || message.to === '*')
        .map(message => structuredClone(message))
      if (markRead) {
        const now = new Date().toISOString()
        for (const message of state.messages) {
          if ((message.to === name || message.to === '*') && !message.readAt) {
            message.readAt = now
          }
        }
      }
      return state
    })
    return messages
  }

  async status(caller: string, isAlive: (pid: number) => boolean): Promise<PublicTeamStatus> {
    const state = requireTeam(await this.read())
    assertMember(state, caller)
    const members = state.members.map(member => ({
      ...member,
      alive: member.pid === undefined ? undefined : isAlive(member.pid),
    }))
    const taskSummary: Record<TaskStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      decomposed: 0,
    }
    for (const task of state.tasks) taskSummary[task.status] += 1
    return {
      team: state.team,
      members,
      taskSummary,
      pendingMessages: state.messages.filter(
        message => (message.to === caller || message.to === '*') && !message.readAt,
      ).length,
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.lockPath), { recursive: true })
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    while (true) {
      try {
        const handle = await open(this.lockPath, 'wx')
        await handle.writeFile(String(process.pid))
        return async () => {
          await handle.close()
          await rm(this.lockPath, { force: true })
        }
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw error
        if (await this.removeStaleLock()) continue
        if (Date.now() >= deadline) {
          throw new TeamError('timed out waiting for the agent-team state lock')
        }
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }
  }

  private async removeStaleLock(): Promise<boolean> {
    try {
      const lockOwner = Number((await readFile(this.lockPath, 'utf8')).trim())
      if (!Number.isInteger(lockOwner) || lockOwner <= 0) return false
      try {
        process.kill(lockOwner, 0)
        return false
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as NodeJS.ErrnoException).code === 'ESRCH'
        ) {
          await rm(this.lockPath, { force: true })
          return true
        }
        return false
      }
    } catch {
      return false
    }
  }
}

export function requireTeam(state: TeamState | undefined): TeamState {
  if (!state) throw new TeamError('no team exists in this project; create an approved plan with team_plan, then call team_approve')
  return state
}

export function isTeamHeartbeatStale(
  state: TeamState,
  now = Date.now(),
): boolean {
  const heartbeat = state.team.heartbeatAt
  if (!heartbeat) return true
  const heartbeatAt = Date.parse(heartbeat)
  return !Number.isFinite(heartbeatAt) || now - heartbeatAt > LEADER_HEARTBEAT_TIMEOUT_MS
}

function normalizeState(raw: unknown): TeamState {
  if (!raw || typeof raw !== 'object') throw new TeamError('team state is invalid')
  const state = raw as Partial<TeamState> & {
    version?: number
    team?: Partial<TeamState['team']>
  }
  if (!state.team?.name || !state.team.createdAt || !state.members || !state.tasks || !state.messages) {
    throw new TeamError('team state is missing required fields')
  }
  const maxMembers = state.team.maxMembers ?? DEFAULT_MAX_MEMBERS
  const tmuxSession = state.team.tmuxSession ?? `pool-team-${sanitizeTeamName(state.team.name)}`
  return {
    ...(state as Omit<TeamState, 'version' | 'team'>),
    version: 2,
    team: {
      ...state.team,
      lead: state.team.lead ?? 'team-lead',
      maxMembers,
      tmuxSession,
      progressCheckIntervalMinutes: state.team.progressCheckIntervalMinutes ?? DEFAULT_PROGRESS_CHECK_INTERVAL_MINUTES,
      maxStalledChecks: state.team.maxStalledChecks ?? DEFAULT_MAX_STALLED_CHECKS,
    } as TeamState['team'],
  }
}

export function assertMember(state: TeamState, name: string): void {
  if (!state.members.some(member => member.name === name)) {
    throw new TeamError(`member "${name}" is not part of team "${state.team.name}"`)
  }
}

function clearInitialAssignmentDeadlineWhenExecutable(state: TeamState): void {
  const hasExecutableAssignment = state.tasks.some(task =>
    task.owner
    && task.owner !== state.team.lead
    && task.status !== 'completed'
    && task.status !== 'decomposed'
    && task.blockedBy.every(id => getTask(state, id).status === 'completed'),
  )
  if (!hasExecutableAssignment) return
  state.team.initialAssignmentDeadlineAt = undefined
  state.team.initialAssignmentEscalatedAt = undefined
}

function assertTaskIds(state: TeamState, ids: string[]): void {
  for (const id of ids) getTask(state, id)
}

function getTask(state: TeamState, id: string): TeamTask {
  const task = state.tasks.find(item => item.id === id)
  if (!task) throw new TeamError(`task "${id}" was not found`)
  return task
}

export function hasUnresolvedTasks(state: TeamState): boolean {
  return state.tasks.some(task => task.status === 'pending' || task.status === 'in_progress')
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST'
}
