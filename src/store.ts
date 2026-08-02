import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  PublicTeamStatus,
  TaskStatus,
  TeamMember,
  TeamMessage,
  TeamState,
  TeamTask,
} from './types.js'

const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5_000
export const DEFAULT_MAX_MEMBERS = 4
export const LEADER_HEARTBEAT_TIMEOUT_MS = 8_000

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
  readonly statePath: string
  private readonly lockPath: string

  constructor(readonly projectRoot: string, statePath?: string) {
    this.statePath = statePath ?? join(projectRoot, '.poolside', 'agent-team', 'state.json')
    this.lockPath = join(dirname(this.statePath), 'state.lock')
  }

  async read(): Promise<TeamState | undefined> {
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
  }): Promise<TeamState> {
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
    const release = await this.acquireLock()
    try {
      await rm(dirname(this.statePath), { recursive: true, force: true })
    } finally {
      await release()
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

  async addTask(input: {
    subject: string
    description: string
    owner?: string
    blocks?: string[]
  }): Promise<TeamTask> {
    let created!: TeamTask
    await this.mutate(current => {
      const state = requireTeam(current)
      if (input.owner) assertMember(state, input.owner)
      const blocks = input.blocks ?? []
      assertTaskIds(state, blocks)
      const now = new Date().toISOString()
      created = {
        id: String(state.nextTaskNumber++),
        subject: input.subject.trim(),
        description: input.description.trim(),
        status: 'pending',
        owner: input.owner,
        blocks,
        blockedBy: [],
        createdAt: now,
        updatedAt: now,
      }
      state.tasks.push(created)
      for (const blockedTaskId of blocks) {
        const blocked = getTask(state, blockedTaskId)
        if (!blocked.blockedBy.includes(created.id)) blocked.blockedBy.push(created.id)
      }
      return state
    })
    return created
  }

  async updateTask(
    id: string,
    input: {
      subject?: string
      description?: string
      status?: TaskStatus
      owner?: string | null
      blocks?: string[]
    },
  ): Promise<TeamTask> {
    let updated!: TeamTask
    await this.mutate(current => {
      const state = requireTeam(current)
      const task = getTask(state, id)
      if (input.owner !== undefined && input.owner !== null) assertMember(state, input.owner)
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
      task.updatedAt = new Date().toISOString()
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
  if (!state) throw new TeamError('no team exists in this project; call team_create first')
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
    } as TeamState['team'],
  }
}

export function assertMember(state: TeamState, name: string): void {
  if (!state.members.some(member => member.name === name)) {
    throw new TeamError(`member "${name}" is not part of team "${state.team.name}"`)
  }
}

function assertTaskIds(state: TeamState, ids: string[]): void {
  for (const id of ids) getTask(state, id)
}

function getTask(state: TeamState, id: string): TeamTask {
  const task = state.tasks.find(item => item.id === id)
  if (!task) throw new TeamError(`task "${id}" was not found`)
  return task
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST'
}
