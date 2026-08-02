import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TeamStore } from './store.js'
import type { TeamMember } from './types.js'

const execFileAsync = promisify(execFile)
const TEAM_WINDOW = 'team'

export interface SpawnWorkerInput {
  name: string
  teamName: string
  tmuxSession: string
  prompt: string
  projectRoot: string
  organizationName?: string
  role?: TeamMember['role']
  runtimeDirectory?: string
  agentName?: string
  model?: string
  /** Restart an existing member instead of adding a new one. */
  replaceExisting?: boolean
  /** Prefer restoring this interactive Pool session. */
  resumeSessionId?: string
  /** A coordination message to queue immediately after startup or resume. */
  recoveryMessage?: string
}
export interface SpawnedWorker {
  pid: number
  logPath: string
  tmuxWindow: string
  tmuxPaneId: string
  sessionId?: string
}

type WorkerConfig = SpawnWorkerInput & {
  poolCommand: string
  poolArgs: string[]
  logPath: string
  knownSessionIds: string[]
  sessionIdPath: string
  fallbackPoolArgs?: string[]
  statePath: string
}

let workerLaunchQueue: Promise<void> = Promise.resolve()

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
  runtimeDirectory?: string
}): Promise<void> {
  if (await tmuxSessionExists(input.session)) {
    throw new Error(`tmux session "${input.session}" already exists`)
  }
  const runDirectory = input.runtimeDirectory
    ? join(input.runtimeDirectory, 'run')
    : join(input.projectRoot, '.poolside', 'agent-team', 'run')
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
  const launch = workerLaunchQueue.then(() => spawnPoolWorkerSerial(input, store))
  // Pool only exposes an interactive session ID through local history.  Keep the
  // bootstrap window serial so that a new history entry can be mapped to its
  // teammate reliably.
  workerLaunchQueue = launch.then(() => undefined, () => undefined)
  return launch
}

async function spawnPoolWorkerSerial(
  input: SpawnWorkerInput,
  store: TeamStore,
): Promise<SpawnedWorker> {
  const teamDirectory = input.runtimeDirectory ?? join(input.projectRoot, '.poolside', 'agent-team')
  const runDirectory = join(teamDirectory, 'run')
  const logsDirectory = join(teamDirectory, 'logs')
  await Promise.all([mkdir(runDirectory, { recursive: true }), mkdir(logsDirectory, { recursive: true })])

  const logPath = join(logsDirectory, `${input.name}.log`)
  const configPath = join(runDirectory, `${input.name}.json`)
  const sessionIdPath = join(runDirectory, `${input.name}.session.json`)
  const workerEntrypoint = fileURLToPath(new URL('./worker.js', import.meta.url))
  const poolCommand = process.env.POOL_AGENT_TEAM_POOL_COMMAND || 'pool'
  const basePoolArgs = [
    '--directory',
    input.projectRoot,
    '--mode',
    'always-allow',
    '--prompt-queue',
    buildWorkerPrompt({ ...input, resumeSessionId: undefined }),
  ]
  if (input.recoveryMessage) basePoolArgs.push('--prompt-queue', buildRecoveryPrompt(input.recoveryMessage))
  if (input.model) basePoolArgs.push('--model', input.model)
  const poolArgs = input.resumeSessionId
    ? ['--resume', input.resumeSessionId, ...basePoolArgs.slice(0, 4), ...basePoolArgs.slice(4)]
    : basePoolArgs
  const config: WorkerConfig = {
    ...input,
    poolCommand,
    poolArgs,
    logPath,
    knownSessionIds: input.resumeSessionId ? [] : await recentPoolSessionIds(input.projectRoot, poolCommand),
    sessionIdPath,
    fallbackPoolArgs: input.resumeSessionId ? basePoolArgs : undefined,
    statePath: store.statePath,
  }
  await rm(sessionIdPath, { force: true })
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 })

  const teamWindowTarget = `${input.tmuxSession}:${TEAM_WINDOW}`
  const command = `exec ${shellQuote(process.execPath)} ${shellQuote(workerEntrypoint)} ${shellQuote(configPath)}`
  const existingMember = (await store.read())?.members.find(member => member.name === input.name)
  if (existingMember && !input.replaceExisting) {
    throw new Error(`teammate "${input.name}" already exists`)
  }
  if (input.replaceExisting && existingMember?.tmuxPaneId) {
    await killTmuxPaneIfPresent(existingMember.tmuxPaneId)
  }
  const hasTeammates = (await store.read())?.members.some(
    member => member.name !== input.name && Boolean(member.tmuxPaneId),
  ) ?? false
  const paneResult = await tmux([
    hasTeammates ? 'split-window' : 'new-window',
    '-d',
    '-P',
    '-F',
    '#{pane_id}:#{pane_pid}',
    '-t',
    hasTeammates ? teamWindowTarget : input.tmuxSession,
    ...(hasTeammates ? [] : ['-n', TEAM_WINDOW]),
    command,
  ])
  const [tmuxPaneId, rawPid] = paneResult.split(':')
  const pid = Number(rawPid)
  if (!tmuxPaneId || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`tmux did not return a pane ID and PID: ${paneResult}`)
  }
  await tmux(['select-layout', '-t', teamWindowTarget, 'tiled'])
  await tmux(['pipe-pane', '-o', '-t', tmuxPaneId, `cat >> ${shellQuote(logPath)}`])
  await tmux(['select-window', '-t', teamWindowTarget])

  const spawned: SpawnedWorker = {
    pid,
    logPath,
    tmuxWindow: TEAM_WINDOW,
    tmuxPaneId,
  }
  if (existingMember) {
    await store.updateMember(input.name, member => {
      Object.assign(member, {
        ...makeMember(input, spawned),
        joinedAt: member.joinedAt,
        restartCount: (member.restartCount ?? 0) + 1,
        sessionId: input.resumeSessionId ?? member.sessionId,
        terminationReason: undefined,
        lastError: undefined,
        exitCode: undefined,
        lastActivityAt: new Date().toISOString(),
      })
    })
  } else {
    await store.addMember(makeMember(input, spawned))
  }

  const sessionId = input.resumeSessionId ?? await waitForSessionId(sessionIdPath)
  if (sessionId && !input.resumeSessionId) {
    await store.updateMember(input.name, member => {
      member.sessionId = sessionId
      member.lastActivityAt = new Date().toISOString()
    })
  }
  return { ...spawned, sessionId }
}

export async function killTeamTmuxSession(session: string): Promise<void> {
  if (await tmuxSessionExists(session)) await tmux(['kill-session', '-t', session])
}

export async function isTmuxPaneAlive(paneId: string): Promise<boolean> {
  try {
    const panes = await tmux(['list-panes', '-a', '-F', '#{pane_id}:#{pane_dead}'])
    return panes.split('\n').some(pane => {
      const [id, dead] = pane.split(':')
      return id === paneId && dead !== '1'
    })
  } catch {
    return false
  }
}

export async function interruptTmuxPane(paneId: string): Promise<void> {
  if (!(await isTmuxPaneAlive(paneId))) {
    throw new Error(`teammate pane "${paneId}" is not running`)
  }
  await tmux(['send-keys', '-t', paneId, 'Escape'])
}

export async function sendPromptToTmuxPane(paneId: string, prompt: string): Promise<void> {
  if (!(await isTmuxPaneAlive(paneId))) {
    throw new Error(`teammate pane "${paneId}" is not running`)
  }
  // -l prevents tmux from interpreting message content as key names.
  await tmux(['send-keys', '-t', paneId, '-l', prompt])
  await tmux(['send-keys', '-t', paneId, 'Enter'])
}

async function killTmuxPaneIfPresent(paneId: string): Promise<void> {
  try {
    await tmux(['kill-pane', '-t', paneId])
  } catch {
    // A dead pane may already have disappeared with the team window.
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

export function startOrganizationWatchdog(input: { statePath: string }): number {
  const watchdogEntrypoint = fileURLToPath(new URL('./organization-watchdog.js', import.meta.url))
  const child = spawn(process.execPath, [watchdogEntrypoint, input.statePath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, POOL_AGENT_TEAM_MEMBER: 'organization-watchdog' },
  })
  child.unref()
  if (!child.pid) throw new Error('organization watchdog did not provide a process ID')
  return child.pid
}

function buildWorkerPrompt(input: SpawnWorkerInput): string {
  return [
    `You are ${input.role === 'leader' ? 'the team leader' : 'a teammate'} "${input.name}" in Pool agent team "${input.teamName}"${input.organizationName ? ` of organization "${input.organizationName}"` : ''}.`,
    'Use the agent-team MCP tools for all coordination.',
    'Start by checking task_list and message_list. Work only on tasks assigned to you or explicitly ask the lead before claiming work.',
    'When a task takes more than a few minutes, periodically call task_update with a concise progress_note containing a concrete result, evidence, or blocker. Repeating an unchanged status is not progress.',
    'A team-lead watchdog reviews unchanged in-progress tasks every five minutes by default. After repeated unchanged reviews it will interrupt broad reasoning and require the task to be split into small, independently verifiable steps.',
    'A later direct coordination message from team-lead is an explicit task assignment, even when task_list has no unfinished task assigned to you. Execute it and report the result with message_send; do not dismiss it because earlier work is complete.',
    'After completing work, call task_update to mark it completed when there is a matching task, send a concise message to the requester or team-lead, then remain available for a later coordination message. Only leave the team after an explicit shutdown request.',
    input.role === 'leader'
      ? 'You may create and manage teammates only in your own team. Use organization_message_send only to exchange opinions with another team leader. Do not contact another team\'s teammates directly.'
      : 'You cannot create teammates or delete the team. Do not communicate with members outside your own team.',
    'Do not modify files outside the requested project.',
    '',
    'Assigned work:',
    input.prompt,
  ].join('\n')
}

function buildRecoveryPrompt(message: string): string {
  return [
    'System recovery notice: the team coordinator restarted or reactivated this teammate.',
    'Read task_list and message_list before taking action. Do not repeat already-completed work.',
    'New coordination message:',
    message,
  ].join('\n')
}

function makeMember(input: SpawnWorkerInput, spawned: SpawnedWorker): TeamMember {
  return {
    name: input.name,
    role: input.role ?? 'teammate',
    agentName: input.agentName,
    model: input.model,
    prompt: input.prompt,
    joinedAt: new Date().toISOString(),
    status: 'running',
    pid: spawned.pid,
    logPath: spawned.logPath,
    tmuxWindow: spawned.tmuxWindow,
    tmuxPaneId: spawned.tmuxPaneId,
    restartCount: 0,
    lastActivityAt: new Date().toISOString(),
  }
}

async function recentPoolSessionIds(projectRoot: string, poolCommand: string): Promise<string[]> {
  try {
    const result = await execFileAsync(poolCommand, ['history', 'sessions'], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
    return result.stdout
      .split('\n')
      .map(line => line.trim().split(/\s+/)[2])
      .filter((id): id is string => Boolean(id && /^[0-9a-f-]{16,}$/i.test(id)))
  } catch {
    return []
  }
}

async function waitForSessionId(sessionIdPath: string, timeoutMs = 30_000): Promise<string | undefined> {
  const configuredTimeout = Number(process.env.POOL_AGENT_TEAM_SESSION_DISCOVERY_TIMEOUT_MS)
  if (Number.isFinite(configuredTimeout) && configuredTimeout >= 0) timeoutMs = configuredTimeout
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(await readFile(sessionIdPath, 'utf8')) as { sessionId?: string; complete?: boolean }
      if (raw.sessionId) return raw.sessionId
      if (raw.complete) return undefined
    } catch {
      // The worker has not created its discovery result yet.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return undefined
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
