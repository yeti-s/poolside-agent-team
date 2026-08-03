import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TeamError, sanitizeTeamName } from './store.js'

const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5_000

export type TeardownKind = 'team' | 'organization'

export interface TeardownPlan {
  id: string
  kind: TeardownKind
  targetName: string
  createdAt: string
  impact: {
    tmuxSessions: string[]
    memberCount: number
    activeTaskCount: number
  }
}

/** Durable, main-CLI-only confirmation records for destructive lifecycle work. */
export class LifecycleStore {
  readonly directory: string
  private readonly plansPath: string
  private readonly lockPath: string

  constructor(projectRoot: string) {
    this.directory = join(projectRoot, '.poolside', 'agent-lifecycle')
    this.plansPath = join(this.directory, 'teardown-plans.json')
    this.lockPath = join(this.directory, 'teardown-plans.lock')
  }

  async create(input: Omit<TeardownPlan, 'id' | 'createdAt'>): Promise<TeardownPlan> {
    return this.withLock(async () => {
      const plans = await this.readPlans()
      const plan: TeardownPlan = {
        ...input,
        id: `${input.kind}-teardown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
      }
      plans.push(plan)
      await this.writePlans(plans)
      return plan
    })
  }

  async get(id: string): Promise<TeardownPlan> {
    const plan = (await this.readPlans()).find(item => item.id === id)
    if (!plan) throw new TeamError(`teardown plan "${id}" was not found`)
    return plan
  }

  async consume(id: string): Promise<void> {
    await this.withLock(async () => this.writePlans((await this.readPlans()).filter(plan => plan.id !== id)))
  }

  private async readPlans(): Promise<TeardownPlan[]> {
    try {
      return JSON.parse(await readFile(this.plansPath, 'utf8')) as TeardownPlan[]
    } catch (error: unknown) {
      if (isNotFound(error)) return []
      throw error
    }
  }

  private async writePlans(plans: TeardownPlan[]): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const temporary = `${this.plansPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(plans, null, 2)}\n`, 'utf8')
    await rename(temporary, this.plansPath)
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true })
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    let handle: Awaited<ReturnType<typeof open>> | undefined
    while (!handle) {
      try {
        handle = await open(this.lockPath, 'wx')
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw error
        if (Date.now() >= deadline) throw new TeamError('timed out waiting for teardown plan lock')
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

/** Move a terminated runtime out of the active path while retaining audit evidence. */
export async function archiveRuntimeDirectory(
  projectRoot: string,
  sourceDirectory: string,
  kind: TeardownKind,
  targetName: string,
): Promise<string> {
  const archiveRoot = join(projectRoot, '.poolside', `${kind === 'team' ? 'agent-team' : 'agent-organization'}-archive`)
  await mkdir(archiveRoot, { recursive: true })
  const archivePath = join(
    archiveRoot,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${sanitizeTeamName(targetName)}`,
  )
  await rename(sourceDirectory, archivePath)
  return archivePath
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST'
}
