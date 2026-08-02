import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TeamError, TeamStore, sanitizeTeamName, validateMemberName } from './store.js'
import { defaultRequiresResponse } from './types.js'

async function createTeam(store: TeamStore, overrides: Partial<{
  teamName: string
  description: string
  maxMembers: number
  tmuxSession: string
}> = {}) {
  return store.create({
    teamName: 'feature-x',
    description: 'Implement feature X',
    maxMembers: 4,
    tmuxSession: 'pool-team-feature-x',
    leaderPid: process.pid,
    ...overrides,
  })
}

async function withStore(
  action: (store: TeamStore) => Promise<void>,
): Promise<void> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pool-agent-team-'))
  try {
    await action(new TeamStore(projectRoot))
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
}

test('normalizes safe team and member names', () => {
  assert.equal(sanitizeTeamName(' Feature X / API '), 'feature-x-api')
  assert.equal(validateMemberName('test_runner'), 'test_runner')
  assert.throws(() => validateMemberName('1tester'), TeamError)
})
test('creates one team and rejects a second active team', async () => {
  await withStore(async store => {
    const state = await createTeam(store)
    assert.equal(state.team.lead, 'team-lead')
    assert.equal(state.team.maxMembers, 4)
    assert.equal(state.members.length, 1)
    await assert.rejects(() => createTeam(store, { teamName: 'other-team' }), TeamError)
  })
})

test('maintains task dependencies and refuses blocked work', async () => {
  await withStore(async store => {
    await createTeam(store)
    const foundation = await store.addTask({
      subject: 'Create API',
      description: 'Implement API foundation',
    })
    const client = await store.addTask({
      subject: 'Create client',
      description: 'Implement client',
      blocks: [foundation.id],
    })
    assert.deepEqual((await store.read())?.tasks[0]?.blockedBy, [client.id])
    await assert.rejects(
      () => store.updateTask(foundation.id, { status: 'in_progress' }),
      /blocked by/,
    )
    await store.updateTask(client.id, { status: 'completed' })
    const updated = await store.updateTask(foundation.id, { status: 'in_progress' })
    assert.equal(updated.status, 'in_progress')
  })
})

test('uses dependsOn for normal prerequisite ordering without reversing the relationship', async () => {
  await withStore(async store => {
    await createTeam(store)
    const foundation = await store.addTask({ subject: 'Create API', description: 'Implement API foundation' })
    const client = await store.addTask({
      subject: 'Create client',
      description: 'Implement the client after the API',
      dependsOn: [foundation.id],
    })
    assert.deepEqual(client.blockedBy, [foundation.id])
    await assert.rejects(() => store.updateTask(client.id, { status: 'in_progress' }), /blocked by: 1/)
    await store.updateTask(foundation.id, { status: 'completed' })
    assert.equal((await store.updateTask(client.id, { status: 'in_progress' })).status, 'in_progress')
  })
})

test('assigns tasks only to registered members and clears an owner', async () => {
  await withStore(async store => {
    await createTeam(store)
    const task = await store.addTask({ subject: 'Test', description: 'Write tests' })
    await assert.rejects(() => store.updateTask(task.id, { owner: 'tester' }), TeamError)
    await store.addMember({
      name: 'tester',
      role: 'teammate',
      joinedAt: new Date().toISOString(),
      status: 'idle',
    })
    assert.equal((await store.updateTask(task.id, { owner: 'tester' })).owner, 'tester')
    assert.equal((await store.updateTask(task.id, { owner: null })).owner, undefined)
  })
})

test('delivers and marks messages addressed to a teammate', async () => {
  await withStore(async store => {
    await createTeam(store)
    await store.addMember({
      name: 'tester',
      role: 'teammate',
      joinedAt: new Date().toISOString(),
      status: 'idle',
    })
    await store.addMessage({ from: 'team-lead', to: 'tester', body: 'Run tests' })
    await store.addMessage({ from: 'team-lead', to: '*', body: 'Share blockers' })
    assert.equal((await store.messagesFor('tester', true)).length, 2)
    const status = await store.status('tester', () => false)
    assert.equal(status.pendingMessages, 0)
  })
})

test('records acknowledgement messages without requiring a response', async () => {
  await withStore(async store => {
    await createTeam(store)
    await store.addMember({
      name: 'tester',
      role: 'teammate',
      joinedAt: new Date().toISOString(),
      status: 'idle',
    })
    const message = await store.addMessage({
      from: 'team-lead',
      to: 'tester',
      body: 'Thanks for the review.',
      messageKind: 'ack',
      requiresResponse: defaultRequiresResponse('ack'),
    })
    assert.equal(message.messageKind, 'ack')
    assert.equal(message.requiresResponse, false)
    assert.equal(defaultRequiresResponse('fyi'), false)
    assert.equal(defaultRequiresResponse('task'), true)
  })
})

test('preserves worker recovery metadata through state reads', async () => {
  await withStore(async store => {
    await createTeam(store)
    await store.addMember({
      name: 'recoverable',
      role: 'teammate',
      joinedAt: new Date().toISOString(),
      status: 'failed',
      sessionId: '019fb2b6-3c2d-775f-bd7a-f64434859f06',
      terminationReason: 'error',
      lastError: 'connection reset by peer',
      restartCount: 2,
    })
    const member = (await store.read())?.members.find(item => item.name === 'recoverable')
    assert.equal(member?.sessionId, '019fb2b6-3c2d-775f-bd7a-f64434859f06')
    assert.equal(member?.terminationReason, 'error')
    assert.equal(member?.restartCount, 2)
  })
})

test('tracks unchanged work and requests decomposition after repeated leader reviews', async () => {
  await withStore(async store => {
    await createTeam(store)
    await store.addMember({
      name: 'developer',
      role: 'teammate',
      joinedAt: new Date().toISOString(),
      status: 'running',
    })
    const task = await store.addTask({
      subject: 'Implement feature',
      description: 'Complete the feature end to end',
      owner: 'developer',
    })
    await store.updateTask(task.id, { status: 'in_progress', progressNote: 'Started implementation.' })
    const startedAt = Date.parse((await store.read())!.tasks[0]!.lastProgressAt!)
    const first = await store.checkTaskProgress({
      taskId: task.id,
      intervalMs: 5 * 60_000,
      maxStalledChecks: 2,
      now: startedAt + 5 * 60_000,
    })
    assert.equal(first.status, 'remind')
    assert.equal(first.task.stalledCheckCount, 1)
    const second = await store.checkTaskProgress({
      taskId: task.id,
      intervalMs: 5 * 60_000,
      maxStalledChecks: 2,
      now: startedAt + 10 * 60_000,
    })
    assert.equal(second.status, 'decompose')
    assert.equal(second.task.stalledCheckCount, 2)
    assert.ok(second.task.decompositionRequestedAt)
    const repeated = await store.checkTaskProgress({
      taskId: task.id,
      intervalMs: 5 * 60_000,
      maxStalledChecks: 2,
      now: startedAt + 15 * 60_000,
    })
    assert.equal(repeated.status, 'already_escalated')
    await store.updateTask(task.id, { progressNote: 'Added a focused implementation step.' })
    const progressed = await store.checkTaskProgress({
      taskId: task.id,
      intervalMs: 5 * 60_000,
      maxStalledChecks: 2,
      now: Date.now(),
    })
    assert.equal(progressed.status, 'active')
    assert.equal(progressed.task.stalledCheckCount, 0)
  })
})

test('serializes concurrent task creation without reusing IDs', async () => {
  await withStore(async store => {
    await createTeam(store)
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.addTask({ subject: `Task ${index}`, description: 'Concurrent task' }),
      ),
    )
    assert.deepEqual(
      created.map(task => task.id).sort((a, b) => Number(a) - Number(b)),
      Array.from({ length: 10 }, (_, index) => String(index + 1)),
    )
  })
})

test('enforces a member limit that includes team-lead', async () => {
  await withStore(async store => {
    await createTeam(store, { maxMembers: 2 })
    await store.addMember({
      name: 'tester',
      role: 'teammate',
      joinedAt: new Date().toISOString(),
      status: 'idle',
    })
    await assert.rejects(
      () => store.addMember({
        name: 'researcher',
        role: 'teammate',
        joinedAt: new Date().toISOString(),
        status: 'idle',
      }),
      /member limit reached/,
    )
    await store.updateMember('tester', member => {
      member.status = 'stopped'
    })
    await store.addMember({
      name: 'researcher',
      role: 'teammate',
      joinedAt: new Date().toISOString(),
      status: 'idle',
    })
  })
})

test('reads a legacy v1 state with safe v2 defaults', async () => {
  await withStore(async store => {
    await mkdir(join(store.projectRoot, '.poolside', 'agent-team'), { recursive: true })
    await writeFile(store.statePath, JSON.stringify({
      version: 1,
      team: {
        name: 'legacy-team',
        createdAt: '2026-01-01T00:00:00.000Z',
        lead: 'team-lead',
      },
      nextTaskNumber: 1,
      nextMessageNumber: 1,
      members: [{ name: 'team-lead', role: 'leader', joinedAt: '2026-01-01T00:00:00.000Z', status: 'idle' }],
      tasks: [],
      messages: [],
    }))
    const state = await store.read()
    assert.equal(state?.version, 2)
    assert.equal(state?.team.maxMembers, 4)
    assert.equal(state?.team.tmuxSession, 'pool-team-legacy-team')
  })
})
