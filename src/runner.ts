import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
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
  /** Return after the pane and member record are ready; discovery continues in the worker. */
  waitForSessionId?: boolean
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
  role?: TeamMember['role']
}

let workerLaunchQueue: Promise<void> = Promise.resolve()

/** MCP tools deliberately available inside a team-lead Pool session. */
export const TEAM_LEADER_MCP_TOOLS = [
  'team_list',
  'team_status',
  'team_work_plan',
  'task_create',
  'task_list',
  'task_update',
  'task_decompose',
  'message_send',
  'message_list',
  'team_resume',
  'team_interrupt',
  'team_finalize',
] as const

const ORGANIZATION_TEAM_LEADER_MCP_TOOLS = ['organization_message_send'] as const

/** MCP tools deliberately available inside a non-leader team member session. */
export const TEAMMATE_MCP_TOOLS = [
  'task_list',
  'task_update',
  'message_send',
  'message_list',
] as const

export function mcpToolsForWorker(
  role?: TeamMember['role'],
  organizationName?: string,
): readonly string[] {
  if (role !== 'leader') return TEAMMATE_MCP_TOOLS
  return organizationName
    ? [...TEAM_LEADER_MCP_TOOLS, ...ORGANIZATION_TEAM_LEADER_MCP_TOOLS]
    : TEAM_LEADER_MCP_TOOLS
}

function buildWorkerSettings(input: SpawnWorkerInput): string {
  const mcpEntrypoint = fileURLToPath(new URL('./index.js', import.meta.url))
  const enabledTools = mcpToolsForWorker(input.role, input.organizationName)
  return [
    'mcp_servers:',
    '  agent-team:',
    `    command: ${JSON.stringify('node')}`,
    '    args:',
    `      - ${JSON.stringify(mcpEntrypoint)}`,
    `    cwd: ${JSON.stringify(input.projectRoot)}`,
    '    enabled_tools:',
    ...enabledTools.map(tool => `      - ${JSON.stringify(tool)}`),
    '',
  ].join('\n')
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
  runtimeDirectory?: string
}): Promise<void> {
  if (await tmuxSessionExists(input.session)) {
    throw new Error(`tmux session "${input.session}" already exists`)
  }
  const runDirectory = input.runtimeDirectory
    ?? join(input.projectRoot, '.poolside', 'agent-team')
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
  const teamDirectory = input.runtimeDirectory ?? join(input.projectRoot, '.poolside', 'agent-team', input.teamName)
  const agentDirectory = join(teamDirectory, `${input.teamName}-${input.name}`)
  await mkdir(agentDirectory, { recursive: true })

  const logPath = join(agentDirectory, `${input.name}.log`)
  const configPath = join(agentDirectory, `${input.name}.json`)
  const sessionIdPath = join(agentDirectory, `${input.name}.session.json`)
  const instructionsPath = join(agentDirectory, 'AGENTS.md')
  const settingsPath = join(agentDirectory, '.poolside', 'settings.local.yaml')
  const workerEntrypoint = fileURLToPath(new URL('./worker.js', import.meta.url))
  const poolCommand = process.env.POOL_AGENT_TEAM_POOL_COMMAND || 'pool'
  const basePoolArgs = [
    '--directory',
    agentDirectory,
    '--mode',
    'always-allow',
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
    role: input.role,
  }
  await writeFile(sessionIdPath, JSON.stringify({ complete: false }), { mode: 0o600 })
  await writeFile(instructionsPath, input.prompt, { mode: 0o600 })
  await mkdir(dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, buildWorkerSettings(input), { mode: 0o600 })
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

  const sessionId = input.resumeSessionId ?? (input.waitForSessionId === false
    ? undefined
    : await waitForSessionId(sessionIdPath))
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
