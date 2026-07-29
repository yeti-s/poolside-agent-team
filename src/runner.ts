import { execFile, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { TeamStore } from './store.js'
import type { TeamMember } from './types.js'

const execFileAsync = promisify(execFile)

export interface SpawnWorkerInput {
  name: string
  teamName: string
  tmuxSession: string
  prompt: string
  projectRoot: string
  agentName?: string
  model?: string
}
export interface SpawnedWorker {
  pid: number
  logPath: string
  tmuxWindow: string
  tmuxPaneId: string
}

type WorkerConfig = SpawnWorkerInput & {
  poolCommand: string
  poolArgs: string[]
  logPath: string
}

function tmuxCommand(): string {
  return process.env.POOL_AGENT_TEAM_TMUX_COMMAND || 'tmux'
}

async function tmux(args: string[]): Promise<string> {
  const result = await execFileAsync(tmuxCommand(), args, { encoding: 'utf8' })
  return result.stdout.trim()
}

export function teamTmuxSessionName(teamName: string): string {
  return `pool-team-${teamName}`
}

export async function assertTmuxAvailable(): Promise<void> {
  try {
    await tmux(['-V'])
  } catch {
    throw new Error('tmux is required for agent-team; install tmux and try again')
  }
}

export async function tmuxSessionExists(session: string): Promise<boolean> {
  try {
    await tmux(['has-session', '-t', session])
    return true
  } catch {
    return false
  }
}

export async function createTeamTmuxSession(input: {
  session: string
  projectRoot: string
  statePath: string
}): Promise<void> {
  if (await tmuxSessionExists(input.session)) {
    throw new Error(`tmux session "${input.session}" already exists`)
  }
  const runDirectory = join(input.projectRoot, '.poolside', 'agent-team', 'run')
  await mkdir(runDirectory, { recursive: true })
  const dashboardPath = join(runDirectory, 'team-status.sh')
  await writeFile(
    dashboardPath,
    [
      '#!/bin/sh',
      'while :; do',
      '  clear',
      `  cat ${shellQuote(input.statePath)} 2>/dev/null || exit 0`,
      '  sleep 2',
      'done',
      '',
    ].join('\n'),
    { mode: 0o700 },
  )
  await tmux([
    'new-session',
    '-d',
    '-s',
    input.session,
    '-n',
    'team-status',
    `exec /bin/sh ${shellQuote(dashboardPath)}`,
  ])
  await tmux(['set-option', '-t', input.session, 'remain-on-exit', 'on'])
}

export async function spawnPoolWorker(
  input: SpawnWorkerInput,
  store: TeamStore,
): Promise<SpawnedWorker> {
  const teamDirectory = join(input.projectRoot, '.poolside', 'agent-team')
  const runDirectory = join(teamDirectory, 'run')
  const logsDirectory = join(teamDirectory, 'logs')
  await Promise.all([mkdir(runDirectory, { recursive: true }), mkdir(logsDirectory, { recursive: true })])

  const logPath = join(logsDirectory, `${input.name}.log`)
  const configPath = join(runDirectory, `${input.name}.json`)
  const workerEntrypoint = fileURLToPath(new URL('./worker.js', import.meta.url))
  const poolCommand = process.env.POOL_AGENT_TEAM_POOL_COMMAND || 'pool'
  const poolArgs = [
    'exec',
    '--directory',
    input.projectRoot,
    '--unsafe-auto-allow',
    '--output',
    'json',
    '--prompt',
    buildWorkerPrompt(input),
  ]
  if (input.agentName) poolArgs.push('--agent-name', input.agentName)
  const config: WorkerConfig = { ...input, poolCommand, poolArgs, logPath }
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 })

  const paneResult = await tmux([
    'new-window',
    '-d',
    '-P',
    '-F',
    '#{pane_id}:#{pane_pid}',
    '-t',
    input.tmuxSession,
    '-n',
    input.name,
    `exec ${shellQuote(process.execPath)} ${shellQuote(workerEntrypoint)} ${shellQuote(configPath)}`,
  ])
  const [tmuxPaneId, rawPid] = paneResult.split(':')
  const pid = Number(rawPid)
  if (!tmuxPaneId || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`tmux did not return a pane ID and PID: ${paneResult}`)
  }

  const spawned: SpawnedWorker = {
    pid,
    logPath,
    tmuxWindow: input.name,
    tmuxPaneId,
  }
  await store.addMember(makeMember(input, spawned))
  return spawned
}

export async function killTeamTmuxSession(session: string): Promise<void> {
  if (await tmuxSessionExists(session)) await tmux(['kill-session', '-t', session])
}

export async function isTmuxPaneAlive(paneId: string): Promise<boolean> {
  try {
    const panes = await tmux(['list-panes', '-a', '-F', '#{pane_id}'])
    return panes.split('\n').includes(paneId)
  } catch {
    return false
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    )
  }
}

export function startTeamWatchdog(input: { statePath: string; session: string }): number {
  const watchdogEntrypoint = fileURLToPath(new URL('./watchdog.js', import.meta.url))
  const child = spawn(process.execPath, [watchdogEntrypoint, input.statePath, input.session], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, POOL_AGENT_TEAM_MEMBER: 'watchdog' },
  })
  child.unref()
  if (!child.pid) throw new Error('agent-team watchdog did not provide a process ID')
  return child.pid
}

function buildWorkerPrompt(input: SpawnWorkerInput): string {
  return [
    `You are teammate "${input.name}" in Pool agent team "${input.teamName}".`,
    'Use the agent-team MCP tools for all coordination.',
    'Start by checking task_list and message_list. Work only on tasks assigned to you or explicitly ask the lead before claiming work.',
    'After completing work, call task_update to mark it completed, send a concise message to team-lead, then check for more work or exit if no work remains.',
    'You cannot create teammates or delete the team. Do not modify files outside the requested project.',
    '',
    'Assigned work:',
    input.prompt,
  ].join('\n')
}

function makeMember(input: SpawnWorkerInput, spawned: SpawnedWorker): TeamMember {
  return {
    name: input.name,
    role: 'teammate',
    agentName: input.agentName,
    model: input.model,
    prompt: input.prompt,
    joinedAt: new Date().toISOString(),
    status: 'running',
    pid: spawned.pid,
    logPath: spawned.logPath,
    tmuxWindow: spawned.tmuxWindow,
    tmuxPaneId: spawned.tmuxPaneId,
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
