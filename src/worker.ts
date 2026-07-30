import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { TeamStore } from './store.js'

type WorkerConfig = {
  name: string
  teamName: string
  projectRoot: string
  poolCommand: string
  poolArgs: string[]
  logPath: string
  knownSessionIds: string[]
  sessionIdPath: string
  fallbackPoolArgs?: string[]
  agentName?: string
  model?: string
}

const configPath = process.argv[2]
if (!configPath) throw new Error('worker configuration path is required')
const config = JSON.parse(readFileSync(configPath, 'utf8')) as WorkerConfig
const execFileAsync = promisify(execFile)
let fallbackAttempted = false
let sessionDiscoveryTimer: NodeJS.Timeout | undefined

function workerEnvironment() {
  return {
    ...process.env,
    POOL_AGENT_TEAM_MEMBER: config.name,
    POOL_AGENT_TEAM_NAME: config.teamName,
    POOL_AGENT_TEAM_PROJECT_ROOT: config.projectRoot,
    ...(config.model ? { POOL_AGENT_TEAM_MODEL: config.model } : {}),
  }
}

function startPool(args: string[]) {
  return spawn(config.poolCommand, args, {
    cwd: config.projectRoot,
    env: workerEnvironment(),
    stdio: 'inherit',
  })
}

let child = startPool(config.poolArgs)
void discoverSessionId()

let finished = false
async function finish(code: number | null, signal?: string, startupError?: string): Promise<void> {
  if (finished) return
  finished = true
  try {
    const store = new TeamStore(config.projectRoot)
    await store.updateMember(config.name, member => {
      const shutdownRequested = member.status === 'shutdown_requested'
      member.status = shutdownRequested || (code === 0 && !startupError) ? 'stopped' : 'failed'
      member.exitCode = code
      member.terminationReason = shutdownRequested
        ? 'shutdown_requested'
        : code === 0 && !startupError ? 'completed' : startupError ? 'error' : 'unknown'
      member.lastError = startupError ?? (code === 0 ? undefined : `Pool exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`)
      member.lastActivityAt = new Date().toISOString()
    })
    await store.addMessage({
      from: 'system',
      to: 'team-lead',
      kind: 'system',
      body: startupError
        ? `Worker ${config.name} failed to start: ${startupError}.`
        : `Worker ${config.name} ${signal ? `stopped by ${signal}` : `exited with code ${code ?? 'unknown'}`}.`,
    })
  } catch {
    // The lead may have deleted the team while this worker was exiting.
  }
  process.exitCode = code ?? 1
}

child.once('exit', (code, signal) => {
  if (!fallbackAttempted && code !== 0 && config.fallbackPoolArgs) {
    fallbackAttempted = true
    void startFreshFallback()
    return
  }
  void finish(code, signal ?? undefined)
})

child.once('error', error => {
  console.error(`Failed to start worker: ${error.message}`)
  void finish(null, undefined, error.message)
})

async function discoverSessionId(): Promise<void> {
  if (config.knownSessionIds.length === 0) {
    // A resumed worker already has a durable ID; a new worker still reports
    // completion so its launcher never waits for an ID that cannot be inferred.
    await writeFile(config.sessionIdPath, JSON.stringify({ complete: Boolean(config.fallbackPoolArgs) }))
    if (config.fallbackPoolArgs) return
  }
  const known = new Set(config.knownSessionIds)
  const deadline = Date.now() + 30_000
  sessionDiscoveryTimer = setInterval(() => {
    void (async () => {
      try {
        const result = await execFileAsync(config.poolCommand, ['history', 'sessions'], {
          cwd: config.projectRoot,
          encoding: 'utf8',
        })
        const sessionId = result.stdout
          .split('\n')
          .map(line => line.trim().split(/\s+/)[2])
          .find(id => Boolean(id && /^[0-9a-f-]{16,}$/i.test(id) && !known.has(id)))
        if (sessionId) {
          if (sessionDiscoveryTimer) clearInterval(sessionDiscoveryTimer)
          await writeFile(config.sessionIdPath, JSON.stringify({ sessionId, complete: true }))
          const store = new TeamStore(config.projectRoot)
          await store.updateMember(config.name, member => { member.sessionId = sessionId })
          return
        }
      } catch {
        // History is best effort; a later poll or a fresh-session fallback remains safe.
      }
      if (Date.now() >= deadline && sessionDiscoveryTimer) {
        clearInterval(sessionDiscoveryTimer)
        await writeFile(config.sessionIdPath, JSON.stringify({ complete: true }))
      }
    })()
  }, 250)
}

async function prepareFreshFallback(): Promise<void> {
  try {
    const result = await execFileAsync(config.poolCommand, ['history', 'sessions'], {
      cwd: config.projectRoot,
      encoding: 'utf8',
    })
    config.knownSessionIds = result.stdout
      .split('\n')
      .map(line => line.trim().split(/\s+/)[2])
      .filter((id): id is string => Boolean(id && /^[0-9a-f-]{16,}$/i.test(id)))
  } catch {
    config.knownSessionIds = []
  }
  config.fallbackPoolArgs = undefined
  await writeFile(config.sessionIdPath, JSON.stringify({ complete: false }))
  const store = new TeamStore(config.projectRoot)
  await store.updateMember(config.name, member => { member.sessionId = undefined })
  void discoverSessionId()
}

async function startFreshFallback(): Promise<void> {
  console.error(`Pool session resume failed for ${config.name}; starting a fresh recovery session.`)
  const fallbackArgs = config.fallbackPoolArgs
  if (!fallbackArgs) return
  await prepareFreshFallback()
  child = startPool(fallbackArgs)
  child.once('exit', (fallbackCode, fallbackSignal) => void finish(fallbackCode, fallbackSignal ?? undefined))
  child.once('error', error => void finish(null, undefined, error.message))
}
