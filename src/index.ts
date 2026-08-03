import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  DEFAULT_MAX_MEMBERS,
  DEFAULT_MAX_STALLED_CHECKS,
  DEFAULT_PROGRESS_CHECK_INTERVAL_MINUTES,
  TeamError,
  type TeamCreationPlan,
  TeamStore,
  assertMember,
  requireTeam,
  sanitizeTeamName,
  validateMemberName,
} from './store.js'
import {
  assertTmuxAvailable,
  createTeamTmuxSession,
  interruptTmuxPane,
  isProcessAlive,
  isTmuxPaneAlive,
  killTeamTmuxSession,
  sendPromptToTmuxPane,
  startOrganizationWatchdog,
  spawnPoolWorker,
  startTeamWatchdog,
  teamTmuxSessionName,
} from './runner.js'
import {
  MESSAGE_KINDS,
  TASK_STATUSES,
  defaultRequiresResponse,
  type MessageKind,
  type TaskStatus,
} from './types.js'
import { OrganizationStore, normalizePlan } from './organization.js'
import { LifecycleStore, archiveRuntimeDirectory, type TeardownKind } from './lifecycle.js'

const projectRoot = process.env.POOL_AGENT_TEAM_PROJECT_ROOT || process.cwd()
const organizationName = process.env.POOL_AGENT_ORGANIZATION
const organizationTeamName = process.env.POOL_AGENT_TEAM_NAME
const organizationStore = new OrganizationStore(projectRoot)
const lifecycleStore = new LifecycleStore(projectRoot)
if (organizationName && !organizationTeamName) {
  throw new Error('organization workers require POOL_AGENT_TEAM_NAME')
}
const store = organizationName && organizationTeamName
  ? organizationStore.teamStore(organizationName, organizationTeamName)
  : new TeamStore(projectRoot)
const server = new McpServer({ name: 'pool-agent-team', version: '0.1.0' })

const nonEmpty = z.string().trim().min(1)
const taskStatus = z.enum(TASK_STATUSES)
const messageKind = z.enum(MESSAGE_KINDS)
const maxMembers = z.number().int().min(1).max(64)
const recoveryMessage = z.string().trim().min(1).max(20_000)
const progressCheckIntervalMinutes = z.number().int().min(1).max(60)
const maxStalledChecks = z.number().int().min(1).max(10)
let heartbeatTimer: NodeJS.Timeout | undefined
let progressMonitorTimer: NodeJS.Timeout | undefined
let progressMonitorInProgress = false
let initialAssignmentMonitorTimer: NodeJS.Timeout | undefined
let initialAssignmentMonitorInProgress = false

function callerName(): string {
  return process.env.POOL_AGENT_TEAM_MEMBER || 'team-lead'
}

function isMainPoolCli(): boolean {
  return !process.env.POOL_AGENT_TEAM_MEMBER
}

function requireMainPoolCli(): void {
  if (!isMainPoolCli()) throw new TeamError('only the main Pool CLI can create, approve, or delete teams')
}

function isOrganizationWorker(): boolean {
  return Boolean(organizationName && organizationTeamName)
}

function organizationTmuxSessionName(org: string, team: string): string {
  return `pool-org-${sanitizeTeamName(org)}-team-${sanitizeTeamName(team)}`
}

function requiredOrganizationApproval(planId: string): string {
  return `APPROVE ORGANIZATION ${planId}`
}

function requiredTeamApproval(planId: string): string {
  return `APPROVE TEAM ${planId}`
}

function requiredTeardownApproval(kind: TeardownKind, planId: string): string {
  return `APPROVE ${kind === 'organization' ? 'ORGANIZATION' : 'TEAM'} TEARDOWN ${planId}`
}

function assertConversationalApproval(planId: string, userApproval: string): void {
  if (userApproval.trim() !== requiredOrganizationApproval(planId)) {
    throw new TeamError(`user_approval must exactly match: ${requiredOrganizationApproval(planId)}`)
  }
}

function assertTeamApproval(planId: string, userApproval: string): void {
  if (userApproval.trim() !== requiredTeamApproval(planId)) {
    throw new TeamError(`user_approval must exactly match: ${requiredTeamApproval(planId)}`)
  }
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

function buildMessagePrompt(from: string, message: string, kind: MessageKind, fromTeamLead = false): string {
  return [
    `Coordination message from ${from}:`,
    message,
    fromTeamLead
      ? 'This is an explicit new work instruction from team-lead. Treat it as assigned work even if all existing tasks are completed or none is assigned to you. Do not merely wait or say that prior work is finished.'
      : `This ${kind} message requires a response. Check whether it affects your assigned work, then act on the relevant request.`,
    from === 'system'
      ? 'Check task_list and message_list, perform the requested coordination, then update tasks or notify the affected teammate. Do not reply to system.'
      : 'Check task_list and message_list, perform the requested work, then send a concise completion or blocker report back to the sender with message_send.',
  ].join('\n')
}

function buildTaskAssignmentMessage(task: { id: string, subject: string, description: string }): string {
  return [
    `You have been assigned task #${task.id}: ${task.subject}`,
    task.description,
    'Start with the smallest concrete step. Call task_update to mark the task in_progress and include a progress_note for each material result or blocker.',
  ].join('\n\n')
}

function buildStandaloneLeaderPrompt(description?: string): string {
  return [
    'Coordinate this team autonomously after the creating Pool session has created its initial members and tasks.',
    description ? `Team objective: ${description}` : '',
    'Whenever a teammate reports completion, blocker, handoff, or review result, immediately read message_list and task_list.',
    'Turn each result into an explicit next task, validation task, review task, or a concise final outcome. Assign every task to a named teammate and use depends_on for prerequisites.',
    'Do not leave teammates waiting after a completion report. Before declaring the team finished, confirm that every task is completed and that all completion/report messages have been handled.',
    'Do not create teammates unless the creating lead explicitly requests it; coordinate the members already present.',
  ].filter(Boolean).join('\n\n')
}

async function notifyLeaderOfTaskCompletion(task: { id: string, subject: string }, from: string) {
  const state = await currentState()
  if (from === state.team.lead) return { status: 'not_required' as const }
  const leader = state.members.find(member => member.name === state.team.lead)
  const message = await store.addMessage({
    from: 'system',
    to: state.team.lead,
    kind: 'system',
    body: `Task #${task.id} "${task.subject}" was marked completed by ${from}. Review the task result and pending teammate reports, then assign or communicate the next step.`,
    requiresResponse: true,
  })
  const alive = leader?.tmuxPaneId ? await isTmuxPaneAlive(leader.tmuxPaneId) : false
  if (!alive || !leader?.tmuxPaneId) return { status: 'recorded_no_live_leader' as const, message }
  await sendPromptToTmuxPane(leader.tmuxPaneId, buildMessagePrompt('system', message.body, 'handoff'))
  await store.updateMember(leader.name, member => {
    member.lastActivityAt = new Date().toISOString()
  })
  return { status: 'delivered' as const, message }
}

async function deliverTaskAssignment(task: {
  id: string
  subject: string
  description: string
  owner?: string
  blockedBy: string[]
}, from: string) {
  if (!task.owner || task.owner === from) return { status: 'not_required' as const }
  const state = await currentState()
  const member = state.members.find(item => item.name === task.owner)
  if (!member) return { status: 'owner_not_found' as const }
  if (member.role !== 'teammate') return { status: 'recorded_for_team_lead' as const }
  const hasIncompleteDependency = task.blockedBy.some(id =>
    state.tasks.find(candidate => candidate.id === id)?.status !== 'completed',
  )
  if (hasIncompleteDependency) return { status: 'queued_until_dependencies_complete' as const }
  const activeForOwner = state.tasks.some(candidate =>
    candidate.owner === task.owner && candidate.status === 'in_progress',
  )
  if (activeForOwner) return { status: 'queued_while_owner_is_busy' as const }
  const nextForOwner = state.tasks
    .filter(candidate => candidate.owner === task.owner && candidate.status === 'pending')
    .filter(candidate => candidate.blockedBy.every(id => state.tasks.find(item => item.id === id)?.status === 'completed'))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || Number(a.id) - Number(b.id))[0]
  if (nextForOwner?.id !== task.id) return { status: 'queued_for_owner_priority' as const }
  const message = buildTaskAssignmentMessage(task)
  const stored = await store.addMessage({
    from,
    to: member.name,
    body: message,
    messageKind: 'task',
    requiresResponse: true,
  })
  const alive = member.tmuxPaneId ? await isTmuxPaneAlive(member.tmuxPaneId) : false
  if (alive && member.tmuxPaneId) {
    await sendPromptToTmuxPane(
      member.tmuxPaneId,
      buildMessagePrompt(from, message, 'task', from === state.team.lead),
    )
    return { status: 'delivered' as const, message: stored }
  }
  if (member.terminationReason === 'shutdown_requested' || member.status === 'shutdown_requested') {
    return { status: 'queued_shutdown_requested' as const, message: stored }
  }
  if (from !== state.team.lead) return { status: 'queued_requires_lead_recovery' as const, message: stored }
  const resumed = await resumeMember(member.name, message)
  return { status: 'resumed_and_delivered' as const, message: stored, ...resumed }
}

async function deliverNewlyUnblockedTasks(completedTaskId: string, from: string) {
  const state = await currentState()
  const candidates = state.tasks.filter(task =>
    task.status === 'pending'
    && Boolean(task.owner)
    && task.blockedBy.includes(completedTaskId)
    && task.blockedBy.every(id => state.tasks.find(candidate => candidate.id === id)?.status === 'completed'),
  )
  return Promise.all(candidates.map(task => deliverTaskAssignment(task, from)))
}

async function deliverOwnerNextTask(owner: string | undefined, from: string) {
  if (!owner) return []
  const state = await currentState()
  const candidates = state.tasks
    .filter(task => task.owner === owner && task.status === 'pending')
    .filter(task => task.blockedBy.every(id => state.tasks.find(item => item.id === id)?.status === 'completed'))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || Number(a.id) - Number(b.id))
  if (!candidates[0]) return []
  return [await deliverTaskAssignment(candidates[0], from)]
}

function memberWorkStatus(memberName: string, state: Awaited<ReturnType<typeof currentState>>) {
  const owned = state.tasks.filter(task => task.owner === memberName && task.status !== 'completed' && task.status !== 'decomposed')
  const active = owned.filter(task => task.status === 'in_progress')
  if (active.length > 0) return { status: 'working' as const, taskIds: active.map(task => task.id) }
  const pending = owned.filter(task => task.status === 'pending')
  if (pending.length === 0) return { status: 'waiting_for_assignment' as const, taskIds: [] }
  const blocked = pending.every(task => task.blockedBy.some(id =>
    state.tasks.find(candidate => candidate.id === id)?.status !== 'completed',
  ))
  return {
    status: blocked ? 'blocked' as const : 'assigned_pending' as const,
    taskIds: pending.map(task => task.id),
  }
}

function progressReminderPrompt(task: { id: string, subject: string }, intervalMinutes: number): string {
  return [
    `Automated team-lead progress review: task #${task.id} "${task.subject}" has no recorded material progress for ${intervalMinutes} minutes.`,
    'Immediately record a concise, concrete progress note or blocker with task_update, then send the same status to team-lead with message_send.',
    'Do not continue silent/open-ended reasoning. If blocked, state the exact missing input or failed approach.',
  ].join('\n')
}

function decompositionPrompt(task: { id: string, subject: string }, intervalMinutes: number, checks: number): string {
  return [
    `Automated team-lead escalation: task #${task.id} "${task.subject}" remained unchanged across ${checks} consecutive ${intervalMinutes}-minute reviews.`,
    'The owner has been interrupted. Use task_decompose now to create 2-4 small, independently verifiable child tasks with concrete acceptance criteria.',
    'The child tasks will be delivered before this owner’s ordinary pending work. Do not resume the original broad task.',
  ].join('\n')
}

async function runLeaderProgressMonitor(): Promise<void> {
  if (progressMonitorInProgress) return
  progressMonitorInProgress = true
  try {
    const state = await store.read()
    if (!state || state.team.lead !== callerName()) return
    const intervalMinutes = state.team.progressCheckIntervalMinutes ?? DEFAULT_PROGRESS_CHECK_INTERVAL_MINUTES
    const intervalMs = intervalMinutes * 60_000
    const maxChecks = state.team.maxStalledChecks ?? DEFAULT_MAX_STALLED_CHECKS
    const members = new Map(state.members.map(member => [member.name, member]))
    for (const task of state.tasks) {
      if (task.status !== 'in_progress' || !task.owner) continue
      const owner = members.get(task.owner)
      if (!owner || owner.role !== 'teammate' || !owner.tmuxPaneId || !(await isTmuxPaneAlive(owner.tmuxPaneId))) continue
      const review = await store.checkTaskProgress({
        taskId: task.id,
        intervalMs,
        maxStalledChecks: maxChecks,
      })
      if (review.status === 'active' || review.status === 'already_escalated') continue
      const prompt = review.status === 'decompose'
        ? decompositionPrompt(review.task, intervalMinutes, review.task.stalledCheckCount ?? maxChecks)
        : progressReminderPrompt(review.task, intervalMinutes)
      const recipient = review.status === 'decompose' ? state.team.lead : owner.name
      await store.addMessage({ from: state.team.lead, to: recipient, body: prompt, messageKind: 'task', requiresResponse: true })
      // A decomposition request must preempt an endless thinking turn before
      // the instruction is entered into the interactive Pool session.
      if (review.status === 'decompose') {
        await interruptTmuxPane(owner.tmuxPaneId).catch(() => undefined)
        await sendPromptToTmuxPane(owner.tmuxPaneId, 'Your stalled task has been paused. Wait for team-lead to assign focused recovery work.').catch(() => undefined)
      }
      const recipientMember = members.get(recipient)
      if (recipientMember?.tmuxPaneId) await sendPromptToTmuxPane(recipientMember.tmuxPaneId, prompt)
    }
  } catch {
    // Monitoring is best effort. Subsequent intervals retry transient tmux or
    // state-lock failures without disrupting the leader session.
  } finally {
    progressMonitorInProgress = false
  }
}

function initialAssignmentPrompt(teammates: string[]): string {
  return [
    'Automated leadership escalation: initial work has not been assigned to every approved teammate.',
    `Immediately create and assign a concrete task to each of: ${teammates.join(', ')}.`,
    'Do not inspect or modify project files, install dependencies, scaffold an application, or perform implementation work yourself. Use task_create and message_send only to establish the work plan.',
  ].join('\n')
}

async function runInitialAssignmentMonitor(): Promise<void> {
  if (initialAssignmentMonitorInProgress) return
  initialAssignmentMonitorInProgress = true
  try {
    const state = await store.read()
    if (!state || state.team.lead !== callerName() || !state.team.initialAssignmentDeadlineAt) return
    const teammates = state.members.filter(member => member.role === 'teammate')
    if (teammates.length === 0) return
    const unassigned = teammates.filter(member => !state.tasks.some(task =>
      task.owner === member.name && task.status !== 'completed' && task.status !== 'decomposed',
    ))
    if (unassigned.length === 0) {
      await store.updateTeam(team => {
        team.initialAssignmentDeadlineAt = undefined
        team.initialAssignmentEscalatedAt = undefined
      })
      return
    }
    const deadline = Date.parse(state.team.initialAssignmentDeadlineAt)
    if (!Number.isFinite(deadline) || Date.now() < deadline) return
    const lastEscalation = Date.parse(state.team.initialAssignmentEscalatedAt ?? '')
    if (Number.isFinite(lastEscalation) && Date.now() - lastEscalation < 30_000) return
    const prompt = initialAssignmentPrompt(unassigned.map(member => member.name))
    await store.updateTeam(team => { team.initialAssignmentEscalatedAt = new Date().toISOString() })
    await store.addMessage({ from: 'system', to: state.team.lead, body: prompt, kind: 'system', requiresResponse: true })
    const leader = state.members.find(member => member.name === state.team.lead)
    if (leader?.tmuxPaneId) {
      await interruptTmuxPane(leader.tmuxPaneId).catch(() => undefined)
      await sendPromptToTmuxPane(leader.tmuxPaneId, prompt).catch(() => undefined)
    }
  } catch {
    // The next interval retries a transient state or tmux error without
    // affecting team lifecycle.
  } finally {
    initialAssignmentMonitorInProgress = false
  }
}

async function startLeaderProgressMonitor(): Promise<void> {
  if (isMainPoolCli() || progressMonitorTimer) return
  const state = await store.read()
  if (!state || state.team.lead !== callerName()) return
  const intervalMinutes = state.team.progressCheckIntervalMinutes ?? DEFAULT_PROGRESS_CHECK_INTERVAL_MINUTES
  progressMonitorTimer = setInterval(() => { void runLeaderProgressMonitor() }, intervalMinutes * 60_000)
  progressMonitorTimer.unref()
  initialAssignmentMonitorTimer = setInterval(() => { void runInitialAssignmentMonitor() }, 10_000)
  initialAssignmentMonitorTimer.unref()
  void runInitialAssignmentMonitor()
}

function stopLeaderProgressMonitor(): void {
  if (progressMonitorTimer) clearInterval(progressMonitorTimer)
  progressMonitorTimer = undefined
  if (initialAssignmentMonitorTimer) clearInterval(initialAssignmentMonitorTimer)
  initialAssignmentMonitorTimer = undefined
}

async function resumeMember(name: string, message?: string) {
  const state = await currentState()
  const member = state.members.find(item => item.name === name)
  if (!member || member.role !== 'teammate') throw new TeamError(`member "${name}" was not found`)
  if (!member.prompt) throw new TeamError(`member "${name}" has no saved worker prompt and cannot be resumed`)
  const unfinishedTasks = state.tasks
    .filter(task => task.owner === name && task.status !== 'completed')
    .map(task => `- [${task.id}] ${task.subject}: ${task.description}`)
  const unreadMessages = state.messages
    .filter(item => (item.to === name || item.to === '*') && !item.readAt)
    .map(item => `- From ${item.from}: ${item.body}`)
  const recoveryContext = [
    'Recovery context. Do not assume prior terminal output is still available.',
    unfinishedTasks.length ? `Unfinished assigned tasks:\n${unfinishedTasks.join('\n')}` : 'No unfinished task is currently assigned to you.',
    unreadMessages.length ? `Unread team messages:\n${unreadMessages.join('\n')}` : 'No unread team messages were found.',
    message ? `New message from the coordinator:\n${message}` : '',
  ].filter(Boolean).join('\n\n')
  const spawned = await spawnPoolWorker({
    name: member.name,
    prompt: member.prompt,
    teamName: state.team.name,
    tmuxSession: state.team.tmuxSession,
    projectRoot,
    organizationName,
    runtimeDirectory: organizationName
      ? organizationStore.teamRuntimeDirectory(organizationName, state.team.name)
      : undefined,
    agentName: member.agentName,
    model: member.model,
    replaceExisting: true,
    resumeSessionId: member.sessionId,
    recoveryMessage: recoveryContext,
  }, store)
  return {
    tmux_pane_id: spawned.tmuxPaneId,
    pid: spawned.pid,
    resumed_session_id: spawned.sessionId,
    used_saved_session: Boolean(member.sessionId),
    fallback: member.sessionId ? 'fresh session if Pool resume exits with an error' : 'fresh session',
  }
}

async function requireCaller(): Promise<string> {
  if (isMainPoolCli()) {
    throw new TeamError('the main Pool CLI has delegated coordination to team-lead; wait for team_report instead of calling team member or task tools')
  }
  const state = await currentState()
  const caller = callerName()
  assertMember(state, caller)
  return caller
}

async function requireLead(): Promise<void> {
  const caller = await requireCaller()
  const state = await currentState()
  if (state.team.lead !== caller) {
    throw new TeamError('only team-lead can perform this operation')
  }
}

function startLeaderHeartbeat(): void {
  if (heartbeatTimer || isMainPoolCli()) return
  void (async () => {
    const state = await store.read()
    if (!state || state.team.lead !== callerName() || heartbeatTimer) return
    await store.updateTeam(team => {
      team.leaderPid = process.ppid
      team.heartbeatAt = new Date().toISOString()
    })
    heartbeatTimer = setInterval(() => {
      void store.updateTeam(team => {
        team.heartbeatAt = new Date().toISOString()
      }).catch(() => undefined)
    }, 2_000)
    heartbeatTimer.unref()
  })().catch(() => undefined)
}

async function cleanupLeaderTeam(): Promise<void> {
  if (isMainPoolCli()) return
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
  stopLeaderProgressMonitor()
}

process.once('SIGINT', () => void cleanupLeaderTeam().finally(() => process.exit(0)))
process.once('SIGTERM', () => void cleanupLeaderTeam().finally(() => process.exit(0)))
process.once('SIGHUP', () => void cleanupLeaderTeam().finally(() => process.exit(0)))
process.stdin.once('end', () => void cleanupLeaderTeam().finally(() => process.exit(0)))

const plannedMember = z.object({
  name: nonEmpty,
  prompt: nonEmpty,
  agent_name: nonEmpty.optional(),
  model: nonEmpty.optional(),
})
const plannedTeam = z.object({
  name: nonEmpty,
  description: nonEmpty.optional(),
  leader: plannedMember.describe('Every team must define exactly one team leader.'),
  teammates: z.array(plannedMember).optional(),
  max_members: maxMembers.optional(),
  progress_check_interval_minutes: progressCheckIntervalMinutes.optional(),
  stalled_check_limit: maxStalledChecks.optional(),
})

server.tool(
  'organization_plan',
  'Save a proposed organization team list without starting tmux sessions or Pool agents. Every team requires a leader. Present the returned plan to the user and call organization_approve only after explicit user approval.',
  {
    organization_name: nonEmpty,
    description: nonEmpty.optional(),
    teams: z.array(plannedTeam).min(1),
  },
  async ({ organization_name, description, teams }) =>
    execute(async () => {
      requireMainPoolCli()
      if (isOrganizationWorker()) throw new TeamError('only the main Pool CLI can create an organization plan')
      const plan = await organizationStore.createPlan(normalizePlan({
        organizationName: organization_name,
        description,
        teams: teams.map(team => ({
          name: team.name,
          description: team.description,
          leader: {
            name: team.leader.name,
            prompt: team.leader.prompt,
            agentName: team.leader.agent_name,
            model: team.leader.model,
          },
          teammates: team.teammates?.map(member => ({
            name: member.name,
            prompt: member.prompt,
            agentName: member.agent_name,
            model: member.model,
          })),
          maxMembers: team.max_members,
          progressCheckIntervalMinutes: team.progress_check_interval_minutes,
          maxStalledChecks: team.stalled_check_limit,
        })),
      }))
      return {
        status: 'awaiting_user_approval',
        plan_id: plan.id,
        organization_name: plan.organizationName,
        teams: plan.teams.map(team => ({
          name: team.name,
          leader: team.leader.name,
          initial_members: 1 + team.teammates.length,
          max_members: team.maxMembers,
          progress_check_interval_minutes: team.progressCheckIntervalMinutes ?? DEFAULT_PROGRESS_CHECK_INTERVAL_MINUTES,
          stalled_check_limit: team.maxStalledChecks ?? DEFAULT_MAX_STALLED_CHECKS,
        })),
        estimated_pool_sessions: plan.teams.reduce((total, team) => total + 1 + team.teammates.length, 0),
        approval_rules: [
          'Show this complete plan to the user, then stop and ask for approval.',
          'Do not call organization_approve in the same turn as organization_plan.',
          'Only call organization_approve after a later user message contains the exact approval statement below.',
          'Never create, infer, paraphrase, or claim the user approval statement on the user\'s behalf.',
        ],
        required_user_approval: requiredOrganizationApproval(plan.id),
      }
    }),
)

server.tool(
  'organization_approve',
  'Start the exact planned organization only after a later user message explicitly provides the required approval statement. The agent must copy that user statement verbatim into user_approval; never infer or create approval. This creates tmux sessions and starts Pool agents.',
  {
    plan_id: nonEmpty,
    user_approval: nonEmpty.describe('Copy the exact approval statement from the user message after the plan was shown.'),
  },
  async ({ plan_id, user_approval }) =>
    execute(async () => {
      requireMainPoolCli()
      if (isOrganizationWorker()) throw new TeamError('only the main Pool CLI can approve an organization plan')
      if (await organizationStore.read()) throw new TeamError('an organization already exists in this project')
      const plan = await organizationStore.getPlan(plan_id)
      assertConversationalApproval(plan.id, user_approval)
      await assertTmuxAvailable()
      const sessions = plan.teams.map(team => ({ name: team.name, tmuxSession: organizationTmuxSessionName(plan.organizationName, team.name) }))
      try {
        for (const team of plan.teams) {
          const session = sessions.find(item => item.name === team.name)!.tmuxSession
          const teamStore = organizationStore.teamStore(plan.organizationName, team.name)
          await teamStore.create({
            teamName: team.name,
            description: team.description,
            maxMembers: team.maxMembers,
            tmuxSession: session,
            leaderPid: process.ppid,
            leaderName: team.leader.name,
            progressCheckIntervalMinutes: team.progressCheckIntervalMinutes,
            maxStalledChecks: team.maxStalledChecks,
          })
          await createTeamTmuxSession({
            session,
            projectRoot,
            statePath: teamStore.statePath,
            runtimeDirectory: organizationStore.teamRuntimeDirectory(plan.organizationName, team.name),
          })
        }
        const organization = await organizationStore.activate(plan, process.ppid, sessions)
        startOrganizationWatchdog({ statePath: organizationStore.statePath })
        for (const team of plan.teams) {
          const session = sessions.find(item => item.name === team.name)!.tmuxSession
          const teamStore = organizationStore.teamStore(plan.organizationName, team.name)
          await spawnPoolWorker({
            name: team.leader.name,
            prompt: team.leader.prompt,
            teamName: team.name,
            tmuxSession: session,
            projectRoot,
            organizationName: plan.organizationName,
            role: 'leader',
            runtimeDirectory: organizationStore.teamRuntimeDirectory(plan.organizationName, team.name),
            agentName: team.leader.agentName,
            model: team.leader.model,
            replaceExisting: true,
          }, teamStore)
          for (const teammate of team.teammates) {
            await spawnPoolWorker({
              name: teammate.name,
              prompt: teammate.prompt,
              teamName: team.name,
              tmuxSession: session,
              projectRoot,
              organizationName: plan.organizationName,
              runtimeDirectory: organizationStore.teamRuntimeDirectory(plan.organizationName, team.name),
              agentName: teammate.agentName,
              model: teammate.model,
            }, teamStore)
          }
        }
        return {
          status: 'running',
          organization: organization.organization,
          teams: organization.teams.map(team => ({ name: team.name, lead: team.lead, tmux_session: team.tmuxSession })),
          main_handoff: {
            status: 'awaiting_team_leader_reports',
            instruction: 'Coordination is now owned by each team-lead. Do not call organization_status or team/member/task/message tools. Wait for leaders to finalize, then call organization_report to relay their reports to the user.',
          },
        }
      } catch (error) {
        await Promise.all(sessions.map(item => killTeamTmuxSession(item.tmuxSession)))
        await organizationStore.remove()
        throw error
      }
    }),
)

server.tool(
  'organization_status',
  'Show the organization and its teams to organization workers. The main Pool CLI must wait for organization_report after delegation.',
  {},
  async () => execute(async () => {
    if (isMainPoolCli()) throw new TeamError('the main Pool CLI has delegated coordination to team-leads; wait for organization_report instead of organization_status')
    const state = await organizationStore.read()
    if (!state) throw new TeamError('no organization exists in this project')
    const teams = isOrganizationWorker()
      ? state.teams.filter(team => team.name === organizationTeamName)
      : state.teams
    return { organization: state.organization, teams }
  }),
)

server.tool(
  'organization_report',
  'Read finalized reports from all organization team-leads. Only the main Pool CLI may call this after delegating work.',
  {},
  async () => execute(async () => {
    requireMainPoolCli()
    const organization = await organizationStore.read()
    if (!organization) throw new TeamError('no organization exists in this project')
    const reports = await Promise.all(organization.teams.map(async team => {
      const state = requireTeam(await organizationStore.teamStore(organization.organization.name, team.name).read())
      return { team_name: team.name, leader: team.lead, final_report: state.team.finalReport ?? null }
    }))
    const pending = reports.filter(report => !report.final_report).map(report => report.team_name)
    return pending.length > 0
      ? {
          status: 'awaiting_team_leader_reports',
          organization_name: organization.organization.name,
          pending_teams: pending,
          instruction: 'Continue waiting. Do not send tasks or messages to organization teams; team-leads own coordination until they finalize.',
        }
      : { status: 'reported', organization_name: organization.organization.name, reports }
  }),
)

server.tool(
  'organization_message_send',
  'Share an opinion with another team. Only a team-lead may send this message, and it is delivered only to the target team-lead.',
  {
    to_team: nonEmpty,
    message: nonEmpty,
    message_kind: messageKind.optional(),
    requires_response: z.boolean().optional(),
  },
  async ({ to_team, message, message_kind, requires_response }) =>
    execute(async () => {
      if (!isOrganizationWorker() || !organizationName || !organizationTeamName) {
        throw new TeamError('organization_message_send is available only to a team-lead in an organization')
      }
      await requireLead()
      const organization = await organizationStore.read()
      if (!organization) throw new TeamError('no organization exists in this project')
      const targetName = sanitizeTeamName(to_team)
      if (targetName === organizationTeamName) throw new TeamError('use message_send for communication within your own team')
      const target = organization.teams.find(team => team.name === targetName)
      if (!target) throw new TeamError(`team "${targetName}" is not part of organization "${organizationName}"`)
      const resolvedMessageKind = message_kind ?? 'decision'
      const responseRequired = requires_response ?? defaultRequiresResponse(resolvedMessageKind)
      const recorded = await organizationStore.addMessage({
        fromTeam: organizationTeamName,
        toTeam: targetName,
        body: message.trim(),
        messageKind: resolvedMessageKind,
        requiresResponse: responseRequired,
      })
      const targetStore = organizationStore.teamStore(organizationName, targetName)
      const targetState = requireTeam(await targetStore.read())
      const stored = await targetStore.addMessage({
        from: `team:${organizationTeamName}`,
        to: target.lead,
        body: message,
        messageKind: resolvedMessageKind,
        requiresResponse: responseRequired,
      })
      const leader = targetState.members.find(member => member.name === target.lead)
      if (!responseRequired || !leader?.tmuxPaneId || !(await isTmuxPaneAlive(leader.tmuxPaneId))) {
        return { organization_message: recorded, message: stored, delivery: 'recorded_for_team_lead' }
      }
      await sendPromptToTmuxPane(leader.tmuxPaneId, buildMessagePrompt(`team:${organizationTeamName}`, message, resolvedMessageKind))
      return { organization_message: recorded, message: stored, delivery: 'delivered_to_team_lead' }
    }),
)

server.tool(
  'organization_teardown_plan',
  'Prepare, but do not execute, main CLI cancellation and teardown of the active organization. Show the returned impact and exact approval statement to the user, then wait for a later explicit approval.',
  {},
  async () => execute(async () => {
    requireMainPoolCli()
    if (isOrganizationWorker()) throw new TeamError('only the main Pool CLI can tear down an organization')
    const state = await organizationStore.read()
    if (!state) throw new TeamError('no organization exists in this project')
    const teamStates = await Promise.all(state.teams.map(team => organizationStore.teamStore(state.organization.name, team.name).read()))
    const plan = await lifecycleStore.create({
      kind: 'organization',
      targetName: state.organization.name,
      impact: {
        tmuxSessions: state.teams.map(team => team.tmuxSession),
        memberCount: teamStates.reduce((total, team) => total + (team?.members.length ?? 0), 0),
        activeTaskCount: teamStates.reduce((total, team) => total + (team?.tasks.filter(task => task.status === 'pending' || task.status === 'in_progress').length ?? 0), 0),
      },
    })
    return {
      status: 'awaiting_user_approval',
      teardown_id: plan.id,
      organization_name: plan.targetName,
      impact: plan.impact,
      approval_rules: ['This plan does not stop work.', 'Only call organization_teardown_approve after a later user message contains the exact statement below.'],
      required_user_approval: requiredTeardownApproval('organization', plan.id),
    }
  }),
)

server.tool(
  'organization_teardown_approve',
  'Stop every active organization worker, archive its state, and remove it from active lifecycle only after a later explicit user approval.',
  { teardown_id: nonEmpty, user_approval: nonEmpty },
  async ({ teardown_id, user_approval }) => execute(async () => {
    requireMainPoolCli()
    if (isOrganizationWorker()) throw new TeamError('only the main Pool CLI can tear down an organization')
    const plan = await lifecycleStore.get(teardown_id)
    if (plan.kind !== 'organization') throw new TeamError(`teardown plan "${teardown_id}" is not for an organization`)
    if (user_approval.trim() !== requiredTeardownApproval('organization', plan.id)) {
      throw new TeamError(`user_approval must exactly match: ${requiredTeardownApproval('organization', plan.id)}`)
    }
    const state = await organizationStore.read()
    if (!state || state.organization.name !== plan.targetName) throw new TeamError('the planned organization is no longer active')
    await Promise.all(state.teams.map(team => killTeamTmuxSession(team.tmuxSession)))
    const archive_path = await archiveRuntimeDirectory(projectRoot, organizationStore.directory, 'organization', state.organization.name)
    await lifecycleStore.consume(plan.id)
    return { torn_down: true, organization_name: state.organization.name, archive_path }
  }),
)

server.tool(
  'organization_delete',
  'Disabled immediate-delete alias. Use organization_teardown_plan, show its impact to the user, then call organization_teardown_approve only after a later explicit approval.',
  {},
  async () => execute(async () => {
    throw new TeamError('organization_delete is disabled; use organization_teardown_plan followed by organization_teardown_approve')
  }),
)

function normalizeStandalonePlan(input: {
  teamName: string
  description?: string
  leader: { name: string, prompt: string, agentName?: string, model?: string }
  teammates: Array<{ name: string, prompt: string, agentName?: string, model?: string }>
  maxMembers?: number
  progressCheckIntervalMinutes?: number
  maxStalledChecks?: number
}): Omit<TeamCreationPlan, 'id' | 'createdAt'> {
  const leader = { ...input.leader, name: validateMemberName(input.leader.name), prompt: input.leader.prompt.trim() }
  const teammates = input.teammates.map(member => ({ ...member, name: validateMemberName(member.name), prompt: member.prompt.trim() }))
  const names = new Set([leader.name])
  for (const teammate of teammates) {
    if (names.has(teammate.name)) throw new TeamError(`duplicate member "${teammate.name}" in team plan`)
    names.add(teammate.name)
  }
  const max = input.maxMembers ?? Math.max(DEFAULT_MAX_MEMBERS, names.size)
  if (max < names.size) throw new TeamError('max_members must include every planned member')
  return {
    teamName: sanitizeTeamName(input.teamName),
    description: input.description?.trim(),
    leader,
    teammates,
    maxMembers: max,
    progressCheckIntervalMinutes: input.progressCheckIntervalMinutes,
    maxStalledChecks: input.maxStalledChecks,
  }
}

server.tool(
  'team_plan',
  'Save a complete standalone team composition without starting tmux or Pool workers. Show the plan to the user and call team_approve only after a later explicit approval.',
  {
    team_name: nonEmpty,
    description: nonEmpty.optional(),
    leader: plannedMember,
    teammates: z.array(plannedMember).min(1),
    max_members: maxMembers.optional(),
    progress_check_interval_minutes: progressCheckIntervalMinutes.optional(),
    stalled_check_limit: maxStalledChecks.optional(),
  },
  async ({ team_name, description, leader, teammates, max_members, progress_check_interval_minutes, stalled_check_limit }) =>
    execute(async () => {
      requireMainPoolCli()
      if (isOrganizationWorker()) throw new TeamError('standalone team plans are unavailable in organization workers')
      if (await store.read()) throw new TeamError('a team already exists in this project; delete it explicitly before planning another')
      const plan = await store.createPlan(normalizeStandalonePlan({
        teamName: team_name,
        description,
        leader: { name: leader.name, prompt: leader.prompt, agentName: leader.agent_name, model: leader.model },
        teammates: teammates.map(member => ({ name: member.name, prompt: member.prompt, agentName: member.agent_name, model: member.model })),
        maxMembers: max_members,
        progressCheckIntervalMinutes: progress_check_interval_minutes,
        maxStalledChecks: stalled_check_limit,
      }))
      return {
        status: 'awaiting_user_approval',
        plan_id: plan.id,
        team: { name: plan.teamName, leader: plan.leader.name, teammates: plan.teammates.map(member => member.name), max_members: plan.maxMembers },
        required_user_approval: requiredTeamApproval(plan.id),
      }
    }),
)

server.tool(
  'team_approve',
  'Create the exact planned standalone team only after a later user message contains the required approval statement, then delegate all team work to team-lead.',
  { plan_id: nonEmpty, user_approval: nonEmpty },
  async ({ plan_id, user_approval }) => execute(async () => {
    requireMainPoolCli()
    if (await store.read()) throw new TeamError('a team already exists in this project')
    const plan = await store.getPlan(plan_id)
    assertTeamApproval(plan.id, user_approval)
    await assertTmuxAvailable()
    const tmuxSession = teamTmuxSessionName(plan.teamName)
    const state = await store.create({
      teamName: plan.teamName,
      description: plan.description,
      maxMembers: plan.maxMembers,
      tmuxSession,
      leaderPid: process.ppid,
      leaderName: plan.leader.name,
      progressCheckIntervalMinutes: plan.progressCheckIntervalMinutes,
      maxStalledChecks: plan.maxStalledChecks,
    })
    try {
      await createTeamTmuxSession({ session: tmuxSession, projectRoot, statePath: store.statePath })
      const watchdogPid = startTeamWatchdog({ statePath: store.statePath, session: tmuxSession })
      await store.updateTeam(team => { team.watchdogPid = watchdogPid })
      await spawnPoolWorker({
        name: plan.leader.name,
        prompt: buildStandaloneLeaderPrompt(plan.description),
        teamName: state.team.name,
        tmuxSession,
        projectRoot,
        role: 'leader',
        agentName: plan.leader.agentName,
        model: plan.leader.model,
        replaceExisting: true,
        waitForSessionId: false,
      }, store)
      for (const teammate of plan.teammates) {
        await spawnPoolWorker({
          name: teammate.name,
          prompt: teammate.prompt,
          teamName: state.team.name,
          tmuxSession,
          projectRoot,
          agentName: teammate.agentName,
          model: teammate.model,
        }, store)
      }
    } catch (error) {
      await killTeamTmuxSession(tmuxSession)
      await store.remove()
      throw error
    }
    return {
      status: 'running',
      team_name: state.team.name,
      tmux_session: tmuxSession,
      lead_agent: plan.leader.name,
      main_handoff: {
        status: 'awaiting_leader_report',
        instruction: 'Team coordination is now exclusively owned by team-lead. Do not call team_status, team_list, team_adopt, task, or message tools. Wait until team-lead finalizes, then call team_report to relay the result to the user.',
      },
    }
  }),
)

server.tool('team_create', 'Deprecated. Use team_plan and team_approve so the user can approve the complete team composition.', {}, async () =>
  execute(async () => { throw new TeamError('team_create is disabled; use team_plan followed by team_approve') }),
)

server.tool('team_list', 'List the currently configured team and all members.', {}, async () =>
  execute(async () => {
    await requireCaller()
    const state = await currentState()
    return { team: state.team, members: state.members }
  }),
)

server.tool(
  'team_adopt',
  'Transfer team-lead ownership to this Pool session after an explicit leader recovery. The team remains preserved when the prior leader exits. Set force only when the recorded leader process is still alive.',
  { force: z.boolean().optional().describe('Required to take over from a still-running recorded leader.') },
  async ({ force }) =>
    execute(async () => {
      if (isOrganizationWorker()) throw new TeamError('organization team leadership is managed by the organization')
      if (isMainPoolCli()) throw new TeamError('the main Pool CLI has delegated coordination to team-lead and cannot adopt leadership; wait for team_report')
      await requireLead()
      const state = await currentState()
      const previousLeaderPid = state.team.leaderPid
      if (previousLeaderPid && previousLeaderPid !== process.ppid && isProcessAlive(previousLeaderPid) && !force) {
        throw new TeamError('the recorded team leader is still running; call team_adopt with force: true to transfer ownership')
      }
      await store.updateTeam(team => {
        team.leaderPid = process.ppid
        team.heartbeatAt = new Date().toISOString()
      })
      startLeaderHeartbeat()
      await startLeaderProgressMonitor()
      return {
        adopted: true,
        tmux_session: state.team.tmuxSession,
        previous_leader_pid: previousLeaderPid,
        leader_pid: process.ppid,
      }
    }),
)

server.tool('team_status', 'Show worker-process liveness separately from each teammate’s assigned-work status, task counts, unread messages, and unassigned tasks.', {}, async () =>
  execute(async () => {
    const caller = await requireCaller()
    const status = await store.status(caller, isProcessAlive)
    const state = await currentState()
    const members = await Promise.all(status.members.map(async member => ({
      ...member,
      alive: member.tmuxPaneId
        ? await isTmuxPaneAlive(member.tmuxPaneId)
        : member.alive,
    })))
    return {
      ...status,
      members: members.map(member => ({
        ...member,
        work_status: member.role === 'teammate' ? memberWorkStatus(member.name, state) : undefined,
        runtime_status: member.role === 'teammate' && !member.alive
          ? member.terminationReason === 'shutdown_requested'
            ? 'shutdown_requested'
            : 'recoverable'
          : 'live',
      })),
      unassigned_tasks: state.tasks
        .filter(task => task.status !== 'completed' && !task.owner)
        .map(task => ({ id: task.id, subject: task.subject, status: task.status })),
    }
  }),
)

server.tool(
  'team_report',
  'Read the team-lead final outcome. Only the main Pool CLI may call this after it delegated team coordination.',
  {},
  async () => execute(async () => {
    requireMainPoolCli()
    const state = requireTeam(await store.read())
    if (!state.team.finalReport) {
      return {
        status: 'awaiting_leader_report',
        team_name: state.team.name,
        lead_agent: state.team.lead,
        instruction: 'Continue waiting. Do not send tasks or messages to the team; team-lead owns coordination until it finalizes.',
      }
    }
    return { status: 'reported', team_name: state.team.name, lead_agent: state.team.lead, final_report: state.team.finalReport }
  }),
)

server.tool(
  'team_finalize',
  'Record the final team outcome for the main Pool CLI. Only team-lead can finalize; this never deletes the team.',
  {
    status: z.enum(['completed', 'blocked']),
    summary: nonEmpty,
    evidence: nonEmpty,
    blockers: nonEmpty.optional(),
  },
  async ({ status, summary, evidence, blockers }) => execute(async () => {
    await requireLead()
    const state = await currentState()
    const unresolved = state.tasks.filter(task => task.status === 'pending' || task.status === 'in_progress')
    if (status === 'completed' && unresolved.length > 0) {
      throw new TeamError(`cannot finalize completed while tasks remain active: ${unresolved.map(task => task.id).join(', ')}`)
    }
    if (status === 'blocked' && !blockers?.trim()) throw new TeamError('blocked final reports require blockers')
    const report = { status, finalizedAt: new Date().toISOString(), summary: summary.trim(), evidence: evidence.trim(), blockers: blockers?.trim() }
    await store.updateTeam(team => { team.finalReport = report })
    return { finalized: true, report }
  }),
)

server.tool(
  'team_spawn',
  'Disabled. Team members must be included in a user-approved team plan.',
  {
    name: nonEmpty.describe('Unique teammate name, such as researcher or tester.'),
    prompt: nonEmpty.describe('Concrete outcome and scope for the teammate.'),
    agent_name: nonEmpty.optional().describe('Optional teammate metadata; interactive Pool does not use it to select an agent.'),
    model: nonEmpty.optional().describe('Optional Pool model for the interactive teammate session.'),
  },
  async () => execute(async () => {
    throw new TeamError('team_spawn is disabled; include every member in team_plan before approval')
  }),
)

server.tool(
  'task_create',
  'Create a task in the shared team task list. Use depends_on for prerequisite task IDs; blocks is the legacy inverse relation for task IDs that this task prevents from starting. Supplying a teammate owner immediately delivers an actionable assignment prompt to that teammate; an unowned task is only recorded and will appear as unassigned in team_status.',
  {
    subject: nonEmpty,
    description: nonEmpty,
    owner: nonEmpty.optional().describe('Optional teammate name.'),
    depends_on: z.array(nonEmpty).optional().describe('IDs of prerequisite tasks that must be completed before this task can start.'),
    blocks: z.array(nonEmpty).optional().describe('Legacy inverse relation: IDs of tasks this task prevents from starting. Prefer depends_on for normal task ordering.'),
  },
  async ({ subject, description, owner, blocks, depends_on }) =>
    execute(async () => {
      await requireLead()
      const from = callerName()
      const task = await store.addTask({ subject, description, owner, blocks, dependsOn: depends_on })
      const assignment_delivery = await deliverTaskAssignment(task, from)
      return { ...task, assignment_delivery }
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
  'Update a task status, owner, content, or dependency list. Use depends_on for prerequisite task IDs; blocks is the legacy inverse relation. Assigning a teammate immediately delivers an actionable assignment prompt to that teammate.',
  {
    task_id: nonEmpty,
    subject: nonEmpty.optional(),
    description: nonEmpty.optional(),
    status: taskStatus.optional(),
    owner: nonEmpty.nullable().optional().describe('Teammate name; pass null to clear.'),
    depends_on: z.array(nonEmpty).optional().describe('Prerequisite task IDs that must complete before this task can start.'),
    blocks: z.array(nonEmpty).optional().describe('Legacy inverse relation. Prefer depends_on.'),
    progress_note: nonEmpty.optional().describe('Concrete result, evidence, or blocker. Resets the leader progress-watchdog timer.'),
  },
  async ({ task_id, subject, description, status, owner, blocks, depends_on, progress_note }) =>
    execute(async () => {
      const from = await requireCaller()
      const before = (await currentState()).tasks.find(item => item.id === task_id)
      if (!before) throw new TeamError(`task "${task_id}" was not found`)
      const leader = (await currentState()).team.lead
      if (from !== leader) {
        if (before.owner !== from) throw new TeamError('teammates may update only their own tasks')
        if (subject !== undefined || description !== undefined || owner !== undefined || blocks !== undefined || depends_on !== undefined) {
          throw new TeamError('teammates cannot change task assignment, content, or dependencies')
        }
        if (status === 'decomposed') throw new TeamError('only team-lead can decompose a task')
      }
      if (status === 'in_progress' && owner === undefined) {
        const state = await currentState()
        const task = state.tasks.find(item => item.id === task_id)
        if (task && !task.owner) owner = callerName()
      }
      const task = await store.updateTask(task_id, {
        subject,
        description,
        status: status as TaskStatus | undefined,
        owner,
        blocks,
        dependsOn: depends_on,
        progressNote: progress_note,
      })
      const assignment_delivery = owner !== undefined && task.owner !== before?.owner
        ? await deliverTaskAssignment(task, from)
        : { status: 'not_required' as const }
      const unblocked_deliveries = task.status === 'completed' && before?.status !== 'completed'
        ? await deliverNewlyUnblockedTasks(task.id, from)
        : []
      const next_owner_deliveries = task.status === 'completed' && before?.status !== 'completed'
        ? await deliverOwnerNextTask(before.owner, from)
        : []
      const leader_completion_delivery = task.status === 'completed' && before?.status !== 'completed'
        ? await notifyLeaderOfTaskCompletion(task, from)
        : { status: 'not_required' as const }
      return { ...task, assignment_delivery, unblocked_deliveries, next_owner_deliveries, leader_completion_delivery }
    }),
)

server.tool(
  'task_decompose',
  'Interrupt recovery for a stalled task. Only team-lead may split it into 2-4 focused child tasks; children receive priority over the owner’s ordinary pending work.',
  {
    task_id: nonEmpty,
    children: z.array(z.object({
      subject: nonEmpty,
      description: nonEmpty,
      owner: nonEmpty,
      depends_on: z.array(nonEmpty).optional(),
    })).min(2).max(4),
  },
  async ({ task_id, children }) => execute(async () => {
    await requireLead()
    const decomposition = await store.decomposeTask({
      taskId: task_id,
      children: children.map(child => ({
        subject: child.subject,
        description: child.description,
        owner: child.owner,
        dependsOn: child.depends_on,
      })),
    })
    const deliveries = await Promise.all(decomposition.children.map(child => deliverTaskAssignment(child, callerName())))
    return { ...decomposition, deliveries }
  }),
)

server.tool(
  'message_send',
  'Send a message to a teammate by name, or use * for all teammates. Choose message_kind: task, handoff, and decision messages prompt a response by default; fyi and ack messages are recorded for message_list without interrupting or restarting recipients. requires_response overrides that default. A task message from team-lead is an explicit work instruction even if the recipient previously completed its tasks.',
  {
    to: nonEmpty,
    message: nonEmpty,
    message_kind: messageKind.optional().describe('task, handoff, decision, fyi, or ack. Defaults to task.'),
    requires_response: z.boolean().optional().describe('Whether to prompt the recipient for action and a report. Defaults to false for fyi/ack and true otherwise.'),
  },
  async ({ to, message, message_kind, requires_response }) =>
    execute(async () => {
      const from = await requireCaller()
      const state = await currentState()
      if (to !== '*') assertMember(state, to)
      const resolvedMessageKind = message_kind ?? 'task'
      // Completion reports are sometimes incorrectly labelled FYI by a
      // teammate. Reports addressed to the lead are orchestration events and
      // must always wake a live autonomous leader pane.
      const responseRequired = to === state.team.lead && from !== state.team.lead
        ? true
        : requires_response ?? defaultRequiresResponse(resolvedMessageKind)
      const stored = await store.addMessage({
        from,
        to,
        body: message,
        messageKind: resolvedMessageKind,
        requiresResponse: responseRequired,
      })
      const recipients = state.members.filter(member =>
        (to === '*' || member.name === to)
        && (member.role === 'teammate' || member.name === state.team.lead)
        && member.name !== from,
      )
      if (!responseRequired) {
        return {
          message: stored,
          deliveries: recipients.map(member => ({
            name: member.name,
            status: 'recorded_no_prompt' as const,
          })),
        }
      }
      const deliveries = await Promise.all(recipients.map(async member => {
        const alive = member.tmuxPaneId ? await isTmuxPaneAlive(member.tmuxPaneId) : false
        if (alive && member.tmuxPaneId) {
          await sendPromptToTmuxPane(member.tmuxPaneId, buildMessagePrompt(from, message, resolvedMessageKind, from === state.team.lead))
          await store.updateMember(member.name, current => {
            current.lastActivityAt = new Date().toISOString()
          })
          return { name: member.name, status: 'delivered' as const }
        }
        if (member.terminationReason === 'shutdown_requested' || member.status === 'shutdown_requested') {
          return { name: member.name, status: 'queued_shutdown_requested' as const }
        }
        if (from !== state.team.lead) {
          return { name: member.name, status: 'queued_requires_lead_recovery' as const }
        }
        const resumed = await resumeMember(member.name, message)
        return { name: member.name, status: 'resumed_and_delivered' as const, ...resumed }
      }))
      return { message: stored, deliveries }
    }),
)

server.tool(
  'team_resume',
  'Restart a stopped, failed, or dead-pane teammate. Restores its saved Pool session when possible, otherwise creates a fresh session with its role, unfinished tasks, unread messages, and an optional recovery instruction.',
  { name: nonEmpty, message: recoveryMessage.optional() },
  async ({ name, message }) =>
    execute(async () => {
      await requireLead()
      const memberName = validateMemberName(name)
      const state = await currentState()
      if (memberName === state.team.lead) throw new TeamError('team-lead cannot be resumed')
      const member = state.members.find(item => item.name === memberName)
      if (!member) throw new TeamError(`member "${memberName}" was not found`)
      if (member.tmuxPaneId && await isTmuxPaneAlive(member.tmuxPaneId)) {
        if (message) await sendPromptToTmuxPane(member.tmuxPaneId, buildMessagePrompt(state.team.lead, message, 'task', true))
        return { name: memberName, resumed: false, already_running: true, message_delivered: Boolean(message) }
      }
      return { name: memberName, resumed: true, ...(await resumeMember(memberName, message)) }
    }),
)

server.tool(
  'message_list',
  'List messages addressed to the calling team member and mark unread messages as read.',
  {},
  async () => execute(async () => store.messagesFor(await requireCaller(), true)),
)

server.tool(
  'team_interrupt',
  'Interrupt the current Pool task for a teammate while keeping its interactive session open. Only team-lead can call this.',
  { name: nonEmpty },
  async ({ name }) =>
    execute(async () => {
      await requireLead()
      const state = await currentState()
      const memberName = validateMemberName(name)
      if (memberName === state.team.lead) throw new TeamError('team-lead cannot interrupt itself')
      const member = state.members.find(item => item.name === memberName)
      if (!member?.tmuxPaneId) throw new TeamError(`member "${memberName}" has no running tmux pane`)
      await interruptTmuxPane(member.tmuxPaneId)
      return { name: memberName, interrupted: true, tmux_pane_id: member.tmuxPaneId }
    }),
)

server.tool(
  'team_request_shutdown',
  'Disabled for team workers. The main Pool CLI controls team lifecycle through explicit deletion.',
  { name: nonEmpty },
  async () => execute(async () => {
    throw new TeamError('team_request_shutdown is disabled; only the main Pool CLI may delete a team')
  }),
)

server.tool(
  'team_teardown_plan',
  'Prepare, but do not execute, main CLI cancellation and teardown of the active standalone team. Show the returned impact and exact approval statement to the user, then wait for a later explicit approval.',
  {},
  async () =>
    execute(async () => {
      requireMainPoolCli()
      if (isOrganizationWorker()) throw new TeamError('use organization_teardown_plan to remove an organization')
      const state = await currentState()
      const plan = await lifecycleStore.create({
        kind: 'team',
        targetName: state.team.name,
        impact: {
          tmuxSessions: [state.team.tmuxSession],
          memberCount: state.members.length,
          activeTaskCount: state.tasks.filter(task => task.status === 'pending' || task.status === 'in_progress').length,
        },
      })
      return {
        status: 'awaiting_user_approval',
        teardown_id: plan.id,
        team_name: plan.targetName,
        impact: plan.impact,
        approval_rules: ['This plan does not stop work.', 'Only call team_teardown_approve after a later user message contains the exact statement below.'],
        required_user_approval: requiredTeardownApproval('team', plan.id),
      }
    }),
)

server.tool(
  'team_teardown_approve',
  'Stop every standalone team worker, archive its state, and remove it from active lifecycle only after a later explicit user approval.',
  { teardown_id: nonEmpty, user_approval: nonEmpty },
  async ({ teardown_id, user_approval }) => execute(async () => {
    requireMainPoolCli()
    if (isOrganizationWorker()) throw new TeamError('use organization_teardown_approve to remove an organization')
    const plan = await lifecycleStore.get(teardown_id)
    if (plan.kind !== 'team') throw new TeamError(`teardown plan "${teardown_id}" is not for a standalone team`)
    if (user_approval.trim() !== requiredTeardownApproval('team', plan.id)) {
      throw new TeamError(`user_approval must exactly match: ${requiredTeardownApproval('team', plan.id)}`)
    }
    const state = await currentState()
    if (state.team.name !== plan.targetName) throw new TeamError('the planned team is no longer active')
    await killTeamTmuxSession(state.team.tmuxSession)
    const archive_path = await archiveRuntimeDirectory(projectRoot, dirname(store.statePath), 'team', state.team.name)
    await lifecycleStore.consume(plan.id)
    return { torn_down: true, team_name: state.team.name, archive_path }
  }),
)

server.tool(
  'team_delete',
  'Disabled immediate-delete alias. Use team_teardown_plan, show its impact to the user, then call team_teardown_approve only after a later explicit approval.',
  {},
  async () => execute(async () => {
    throw new TeamError('team_delete is disabled; use team_teardown_plan followed by team_teardown_approve')
  }),
)

await server.connect(new StdioServerTransport())
startLeaderHeartbeat()
void startLeaderProgressMonitor()
