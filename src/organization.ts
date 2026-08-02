import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TeamError, TeamStore, sanitizeTeamName, validateMemberName } from './store.js'

const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5_000

export interface PlannedTeammate {
  name: string
  prompt: string
  agentName?: string
  model?: string
}

export interface PlannedTeam {
  name: string
  description?: string
  leader: PlannedTeammate
  teammates: PlannedTeammate[]
  maxMembers: number
}

export interface OrganizationPlan {
  id: string
  organizationName: string
  description?: string
  teams: PlannedTeam[]
  createdAt: string
}

export interface OrganizationState {
  version: 1
  organization: {
    name: string
    description?: string
    createdAt: string
    lead: 'organization-lead'
    leaderPid: number
  }
  teams: Array<{
    name: string
    description?: string
    lead: string
    tmuxSession: string
    statePath: string
  }>
  nextMessageNumber: number
  messages: OrganizationMessage[]
}

export interface OrganizationMessage {
  id: string
  fromTeam: string
  toTeam: string
  body: string
  createdAt: string
  messageKind: 'task' | 'handoff' | 'decision' | 'fyi' | 'ack'
  requiresResponse: boolean
}

export class OrganizationStore {
  readonly directory: string
  readonly statePath: string
  readonly planPath: string
  private readonly lockPath: string

  constructor(readonly projectRoot: string) {
    this.directory = join(projectRoot, '.poolside', 'agent-organization')
    this.statePath = join(this.directory, 'state.json')
    this.planPath = join(this.directory, 'plans.json')
    this.lockPath = join(this.directory, 'state.lock')
  }

  teamStore(organizationName: string, teamName: string): TeamStore {
    return new TeamStore(this.projectRoot, this.teamStatePath(organizationName, teamName))
  }

  teamStatePath(organizationName: string, teamName: string): string {
    return join(this.directory, sanitizeTeamName(organizationName), 'teams', sanitizeTeamName(teamName), 'state.json')
  }

  teamRuntimeDirectory(organizationName: string, teamName: string): string {
    return join(this.directory, sanitizeTeamName(organizationName), 'teams', sanitizeTeamName(teamName))
  }

  async read(): Promise<OrganizationState | undefined> {
    try {
      return normalizeOrganizationState(JSON.parse(await readFile(this.statePath, 'utf8')))
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  async createPlan(input: Omit<OrganizationPlan, 'id' | 'createdAt'>): Promise<OrganizationPlan> {
    const plan: OrganizationPlan = {
      ...input,
      id: `org-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    }
    await this.withLock(async () => {
      const plans = await this.readPlans()
      plans.push(plan)
      await mkdir(this.directory, { recursive: true })
      await writeFile(this.planPath, `${JSON.stringify(plans, null, 2)}\n`, 'utf8')
    })
    return plan
  }

  async getPlan(id: string): Promise<OrganizationPlan> {
    const plan = (await this.readPlans()).find(item => item.id === id)
    if (!plan) throw new TeamError(`organization plan "${id}" was not found`)
    return plan
  }

  async activate(plan: OrganizationPlan, leaderPid: number, sessions: Array<{ name: string, tmuxSession: string }>): Promise<OrganizationState> {
    return this.withLock(async () => {
      const current = await this.read()
      if (current) throw new TeamError(`organization "${current.organization.name}" already exists`)
      const sessionByTeam = new Map(sessions.map(item => [item.name, item.tmuxSession]))
      const now = new Date().toISOString()
      const state: OrganizationState = {
        version: 1,
        organization: {
          name: plan.organizationName,
          description: plan.description,
          createdAt: now,
          lead: 'organization-lead',
          leaderPid,
        },
        teams: plan.teams.map(team => ({
          name: team.name,
          description: team.description,
          lead: team.leader.name,
          tmuxSession: sessionByTeam.get(team.name)!,
          statePath: this.teamStatePath(plan.organizationName, team.name),
        })),
        nextMessageNumber: 1,
        messages: [],
      }
      await this.writeState(state)
      return state
    })
  }

  async addMessage(input: Omit<OrganizationMessage, 'id' | 'createdAt'>): Promise<OrganizationMessage> {
    let message!: OrganizationMessage
    await this.mutate(state => {
      message = {
        ...input,
        id: String(state.nextMessageNumber++),
        createdAt: new Date().toISOString(),
      }
      state.messages.push(message)
      return state
    })
    return message
  }

  async remove(): Promise<void> {
    await this.withLock(async () => {
      await rm(this.directory, { recursive: true, force: true })
    })
  }

  private async readPlans(): Promise<OrganizationPlan[]> {
    try {
      return JSON.parse(await readFile(this.planPath, 'utf8')) as OrganizationPlan[]
    } catch (error: unknown) {
      if (isNotFound(error)) return []
      throw error
    }
  }

  private async mutate(action: (state: OrganizationState) => OrganizationState): Promise<OrganizationState> {
    return this.withLock(async () => {
      const current = await this.read()
      if (!current) throw new TeamError('no organization exists in this project')
      const result = action(current)
      await this.writeState(result)
      return result
    })
  }

  private async writeState(state: OrganizationState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporaryPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.statePath)
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true })
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    let handle: Awaited<ReturnType<typeof open>> | undefined
    while (!handle) {
      try {
        handle = await open(this.lockPath, 'wx')
        await handle.writeFile(String(process.pid))
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw error
        if (Date.now() >= deadline) throw new TeamError('timed out waiting for the organization state lock')
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }
    try {
      return await action()
    } finally {
      await handle.close()
      await rm(this.lockPath, { force: true })
    }
  }
}

export function normalizePlan(input: {
  organizationName: string
  description?: string
  teams: Array<{
    name: string
    description?: string
    leader: PlannedTeammate
    teammates?: PlannedTeammate[]
    maxMembers?: number
  }>
}): Omit<OrganizationPlan, 'id' | 'createdAt'> {
  const organizationName = sanitizeTeamName(input.organizationName)
  if (input.teams.length === 0) throw new TeamError('an organization plan requires at least one team')
  const names = new Set<string>()
  const teams = input.teams.map(raw => {
    const name = sanitizeTeamName(raw.name)
    if (names.has(name)) throw new TeamError(`duplicate team name "${name}" in organization plan`)
    names.add(name)
    const leader = normalizeMember(raw.leader, 'team leader')
    const teammates = (raw.teammates ?? []).map(member => normalizeMember(member, 'teammate'))
    const memberNames = new Set([leader.name])
    for (const teammate of teammates) {
      if (memberNames.has(teammate.name)) throw new TeamError(`duplicate member "${teammate.name}" in team "${name}"`)
      memberNames.add(teammate.name)
    }
    const maxMembers = raw.maxMembers ?? Math.max(4, memberNames.size)
    if (!Number.isInteger(maxMembers) || maxMembers < memberNames.size || maxMembers > 64) {
      throw new TeamError(`team "${name}" max_members must be between its initial member count and 64`)
    }
    return { name, description: raw.description?.trim(), leader, teammates, maxMembers }
  })
  return { organizationName, description: input.description?.trim(), teams }
}

function normalizeMember(member: PlannedTeammate | undefined, label: string): PlannedTeammate {
  if (!member) throw new TeamError(`${label} is required`)
  if (!member.prompt?.trim()) throw new TeamError(`${label} prompt is required`)
  return {
    name: validateMemberName(member.name),
    prompt: member.prompt.trim(),
    agentName: member.agentName?.trim() || undefined,
    model: member.model?.trim() || undefined,
  }
}

function normalizeOrganizationState(raw: unknown): OrganizationState {
  if (!raw || typeof raw !== 'object') throw new TeamError('organization state is invalid')
  const state = raw as OrganizationState
  if (state.version !== 1 || !state.organization?.name || !Array.isArray(state.teams) || !Array.isArray(state.messages)) {
    throw new TeamError('organization state is missing required fields')
  }
  return state
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST'
}
