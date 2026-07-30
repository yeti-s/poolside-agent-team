import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { TeamStore } from './store.js'

type WorkerConfig = {
  name: string
  teamName: string
  projectRoot: string
  poolCommand: string
  poolArgs: string[]
  logPath: string
  agentName?: string
  model?: string
}

const configPath = process.argv[2]
if (!configPath) throw new Error('worker configuration path is required')
const config = JSON.parse(readFileSync(configPath, 'utf8')) as WorkerConfig
const child = spawn(config.poolCommand, config.poolArgs, {
  cwd: config.projectRoot,
  env: {
    ...process.env,
    POOL_AGENT_TEAM_MEMBER: config.name,
    POOL_AGENT_TEAM_NAME: config.teamName,
    POOL_AGENT_TEAM_PROJECT_ROOT: config.projectRoot,
    ...(config.model ? { POOL_AGENT_TEAM_MODEL: config.model } : {}),
  },
  stdio: 'inherit',
})

let finished = false
async function finish(code: number | null, signal?: string, startupError?: string): Promise<void> {
  if (finished) return
  finished = true
  try {
    const store = new TeamStore(config.projectRoot)
    await store.updateMember(config.name, member => {
      member.status = code === 0 && !startupError ? 'stopped' : 'failed'
      member.exitCode = code
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

child.once('exit', (code, signal) => void finish(code, signal ?? undefined))

child.once('error', error => {
  console.error(`Failed to start worker: ${error.message}`)
  void finish(null, undefined, error.message)
})
