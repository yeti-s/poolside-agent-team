import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import {
  DEFAULT_MAX_MEMBERS,
  TeamError,
  TeamStore,
  assertMember,
  isTeamHeartbeatStale,
  requireTeam,
  sanitizeTeamName,
  validateMemberName,
} from './store.js'
import {
  assertTmuxAvailable,
  createTeamTmuxSession,
  isProcessAlive,
  isTmuxPaneAlive,
  killTeamTmuxSession,
  spawnPoolWorker,
  startTeamWatchdog,
  teamTmuxSessionName,
} from './runner.js'
import { TASK_STATUSES, type TaskStatus } from './types.js'

const projectRoot = process.env.POOL_AGENT_TEAM_PROJECT_ROOT || process.cwd()
const store = new TeamStore(projectRoot)
const server = new McpServer({ name: 'pool-agent-team', version: '0.1.0' })

const nonEmpty = z.string().trim().min(1)
const taskStatus = z.enum(TASK_STATUSES)
const maxMembers = z.number().int().min(1).max(64)
let heartbeatTimer: NodeJS.Timeout | undefined
let leaderSessionForExit: string | undefined
let cleanupInProgress = false

function callerName(): string {
  return process.env.POOL_AGENT_TEAM_MEMBER || 'team-lead'
}

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text' as const, text: message }], isError: true as const }
}

async function execute<T>(action: () => Promise<T>) {
  try {
    return text(await action())
  } catch (error) {
    return failure(error)
  }
}

async function currentState() {
  return requireTeam(await store.read())
}

async function requireCaller(): Promise<string> {
  const state = await currentState()
  const caller = callerName()
  assertMember(state, caller)
  return caller
}

async function requireLead(): Promise<void> {
  const caller = await requireCaller()
  if (caller !== 'team-lead') {
    throw new TeamError('only team-lead can perform this operation')
  }
}

function startLeaderHeartbeat(): void {
  if (callerName() !== 'team-lead' || heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    void store.updateTeam(team => {
      team.heartbeatAt = new Date().toISOString()
    }).catch(() => undefined)
  }, 2_000)
  heartbeatTimer.unref()
}

async function cleanupLeaderTeam(): Promise<void> {
  if (callerName() !== 'team-lead' || cleanupInProgress) return
  cleanupInProgress = true
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
  try {
    const state = await store.read()
    if (!state || state.team.leaderPid !== process.ppid) return
    await killTeamTmuxSession(state.team.tmuxSession)
  } finally {
    cleanupInProgress = false
  }
}

function cleanStaleTeamSynchronously(): void {
  if (!leaderSessionForExit) return
  spawnSync(process.env.POOL_AGENT_TEAM_TMUX_COMMAND || 'tmux', [
    'kill-session',
    '-t',
    leaderSessionForExit,
  ], { stdio: 'ignore' })
}

process.once('SIGINT', () => void cleanupLeaderTeam().finally(() => process.exit(0)))
process.once('SIGTERM', () => void cleanupLeaderTeam().finally(() => process.exit(0)))
process.once('SIGHUP', () => void cleanupLeaderTeam().finally(() => process.exit(0)))
process.stdin.once('end', () => void cleanupLeaderTeam().finally(() => process.exit(0)))
process.once('exit', cleanStaleTeamSynchronously)

server.tool(
  'team_create',
  'Create a shared Pool agent team and its task/message state.',
  {
    team_name: nonEmpty.describe('A unique, filesystem-safe team name.'),
    description: nonEmpty.optional(),
    max_members: maxMembers.optional().describe('Maximum team size including team-lead. Defaults to 4.'),
  },
  async ({ team_name, description, max_members }) =>
    execute(async () => {
      if (callerName() !== 'team-lead') throw new TeamError('a teammate cannot create a team')
      const existing = await store.read()
      if (existing) {
        const leaderIsAlive = existing.team.leaderPid ? isProcessAlive(existing.team.leaderPid) : false
        if (!leaderIsAlive && isTeamHeartbeatStale(existing)) {
          await killTeamTmuxSession(existing.team.tmuxSession)
          await store.remove()
        } else {
          throw new TeamError(`team "${existing.team.name}" already exists`)
        }
      }
      await assertTmuxAvailable()
      const normalizedTeamName = sanitizeTeamName(team_name)
      const tmuxSession = teamTmuxSessionName(normalizedTeamName)
      const state = await store.create({
        teamName: normalizedTeamName,
        description,
        maxMembers: max_members ?? DEFAULT_MAX_MEMBERS,
        tmuxSession,
        leaderPid: process.ppid,
      })
      try {
        await createTeamTmuxSession({
          session: tmuxSession,
          projectRoot,
          statePath: store.statePath,
        })
        const watchdogPid = startTeamWatchdog({ statePath: store.statePath, session: tmuxSession })
        await store.updateTeam(team => {
          team.watchdogPid = watchdogPid
        })
      } catch (error) {
        await store.remove()
        throw error
      }
      leaderSessionForExit = tmuxSession
      startLeaderHeartbeat()
      return {
        team_name: state.team.name,
        state_path: store.statePath,
        lead_agent: state.team.lead,
        max_members: state.team.maxMembers,
        tmux_session: tmuxSession,
      }
    }),
)

server.tool('team_list', 'List the currently configured team and all members.', {}, async () =>
  execute(async () => {
    await requireCaller()
    const state = await currentState()
    return { team: state.team, members: state.members }
  }),
)

server.tool('team_status', 'Show team member liveness, task counts, and unread messages.', {}, async () =>
  execute(async () => {
    const caller = await requireCaller()
    const status = await store.status(caller, isProcessAlive)
    const members = await Promise.all(status.members.map(async member => ({
      ...member,
      alive: member.tmuxPaneId
        ? await isTmuxPaneAlive(member.tmuxPaneId)
        : member.alive,
    })))
    return { ...status, members }
  }),
)

server.tool(
  'team_spawn',
  'Start a non-interactive pool exec teammate in the shared project workspace.',
  {
    name: nonEmpty.describe('Unique teammate name, such as researcher or tester.'),
    prompt: nonEmpty.describe('Concrete outcome and scope for the teammate.'),
    agent_name: nonEmpty.optional().describe('Optional Pool managed-agent name.'),
    model: nonEmpty.optional().describe('Optional model label recorded for the teammate.'),
  },
  async ({ name, prompt, agent_name, model }) =>
    execute(async () => {
      await requireLead()
      const state = await currentState()
      const memberName = validateMemberName(name)
      if (state.members.some(member => member.name === memberName)) {
        throw new TeamError(`member "${memberName}" already exists`)
      }
      const input = {
        name: memberName,
        prompt,
        teamName: state.team.name,
        tmuxSession: state.team.tmuxSession,
        projectRoot,
        agentName: agent_name,
        model,
      }
      const spawned = await spawnPoolWorker(input, store)
      return {
        name: memberName,
        pid: spawned.pid,
        log_path: spawned.logPath,
        team_name: state.team.name,
        tmux_session: state.team.tmuxSession,
        tmux_window: spawned.tmuxWindow,
        tmux_pane_id: spawned.tmuxPaneId,
      }
    }),
)

server.tool(
  'task_create',
  'Create a task in the shared team task list.',
  {
    subject: nonEmpty,
    description: nonEmpty,
    owner: nonEmpty.optional().describe('Optional teammate name.'),
    blocks: z.array(nonEmpty).optional().describe('IDs of tasks blocked by this task.'),
  },
  async ({ subject, description, owner, blocks }) =>
    execute(async () => {
      await requireCaller()
      return store.addTask({ subject, description, owner, blocks })
    }),
)

server.tool('task_list', 'List all shared tasks in ID order.', {}, async () =>
  execute(async () => {
    await requireCaller()
    const state = await currentState()
    return state.tasks
  }),
)

server.tool(
  'task_update',
  'Update a task status, owner, content, or dependency list.',
  {
    task_id: nonEmpty,
    subject: nonEmpty.optional(),
    description: nonEmpty.optional(),
    status: taskStatus.optional(),
    owner: nonEmpty.nullable().optional().describe('Teammate name; pass null to clear.'),
    blocks: z.array(nonEmpty).optional(),
  },
  async ({ task_id, subject, description, status, owner, blocks }) =>
    execute(async () => {
      await requireCaller()
      if (status === 'in_progress' && owner === undefined) {
        const state = await currentState()
        const task = state.tasks.find(item => item.id === task_id)
        if (task && !task.owner) owner = callerName()
      }
      return store.updateTask(task_id, {
        subject,
        description,
        status: status as TaskStatus | undefined,
        owner,
        blocks,
      })
    }),
)

server.tool(
  'message_send',
  'Send a text message to a teammate by name, or use * for all teammates.',
  { to: nonEmpty, message: nonEmpty },
  async ({ to, message }) =>
    execute(async () => {
      const from = await requireCaller()
      const state = await currentState()
      if (to !== '*') assertMember(state, to)
      return store.addMessage({ from, to, body: message })
    }),
)

server.tool(
  'message_list',
  'List messages addressed to the calling team member and mark unread messages as read.',
  {},
  async () => execute(async () => store.messagesFor(await requireCaller(), true)),
)

server.tool(
  'team_request_shutdown',
  'Request that a teammate finish safely and exit. This is cooperative and does not kill the process.',
  { name: nonEmpty },
  async ({ name }) =>
    execute(async () => {
      await requireLead()
      const memberName = validateMemberName(name)
      if (memberName === 'team-lead') throw new TeamError('team-lead cannot request its own shutdown')
      await store.updateMember(memberName, member => {
        member.status = 'shutdown_requested'
      })
      return store.addMessage({
        from: 'team-lead',
        to: memberName,
        kind: 'system',
        body: 'Shutdown requested: finish or safely stop your current work, update your task, and exit.',
      })
    }),
)

server.tool(
  'team_delete',
  'Terminate all teammate windows and delete the team state.',
  {},
  async () =>
    execute(async () => {
      await requireLead()
      const state = await currentState()
      await killTeamTmuxSession(state.team.tmuxSession)
      await store.remove()
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
      leaderSessionForExit = undefined
      return { deleted: true, team_name: state.team.name }
    }),
)

await server.connect(new StdioServerTransport())
