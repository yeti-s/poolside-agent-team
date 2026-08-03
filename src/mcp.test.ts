import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('serves agent-team tools through the MCP stdio protocol', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pool-agent-team-mcp-'))
  const server = spawn(process.execPath, [resolve('dist/index.js')], {
    cwd: process.cwd(),
    env: { ...process.env, POOL_AGENT_TEAM_PROJECT_ROOT: projectRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  let nextId = 1
  let buffered = ''
  let stderr = ''

  server.stdout.setEncoding('utf8')
  server.stdout.on('data', chunk => {
    buffered += chunk
    while (true) {
      const newline = buffered.indexOf('\n')
      if (newline === -1) break
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      const message = JSON.parse(line) as Record<string, unknown>
      const id = message.id
      if (typeof id === 'number') pending.get(id)?.(message)
    }
  })
  server.stderr.setEncoding('utf8')
  server.stderr.on('data', chunk => {
    stderr += chunk
  })

  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++
    const response = new Promise<Record<string, unknown>>(resolveResponse => {
      pending.set(id, resolveResponse)
    })
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const message = await response
    pending.delete(id)
    return message
  }

  try {
    const initialize = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'agent-team-test', version: '1.0.0' },
    })
    assert.equal((initialize.result as { serverInfo: { name: string } }).serverInfo.name, 'pool-agent-team')
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    const tools = await request('tools/list')
    const names = (tools.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)
    assert.ok(names.includes('team_plan'))
    assert.ok(names.includes('team_approve'))
    assert.ok(names.includes('team_finalize'))
    assert.ok(names.includes('team_report'))
    assert.ok(names.includes('team_teardown_plan'))
    assert.ok(names.includes('team_teardown_approve'))
    assert.ok(names.includes('team_resume'))
    assert.ok(names.includes('team_interrupt'))
    assert.ok(names.includes('organization_plan'))
    assert.ok(names.includes('organization_approve'))
    assert.ok(names.includes('organization_teardown_plan'))
    assert.ok(names.includes('organization_teardown_approve'))
    assert.ok(names.includes('organization_message_send'))
    const messageSend = (tools.result as { tools: Array<{ name: string, inputSchema: { properties?: Record<string, unknown> } }> }).tools
      .find(tool => tool.name === 'message_send')
    assert.ok(messageSend?.inputSchema.properties?.message_kind)
    assert.ok(messageSend?.inputSchema.properties?.requires_response)
    const teamPlan = (tools.result as { tools: Array<{ name: string, inputSchema: { properties?: Record<string, unknown> } }> }).tools
      .find(tool => tool.name === 'team_plan')
    assert.ok(teamPlan?.inputSchema.properties?.progress_check_interval_minutes)
    assert.ok(teamPlan?.inputSchema.properties?.stalled_check_limit)
    const taskCreate = (tools.result as { tools: Array<{ name: string, inputSchema: { properties?: Record<string, unknown> } }> }).tools
      .find(tool => tool.name === 'task_create')
    assert.ok(taskCreate?.inputSchema.properties?.depends_on)

    const create = await request('tools/call', {
      name: 'team_plan',
      arguments: {
        team_name: 'MCP Feature',
        description: 'MCP test team',
        leader: { name: 'team-lead', prompt: 'Coordinate only the approved teammates.' },
        teammates: [{ name: 'developer', prompt: 'Implement the approved work.' }],
        progress_check_interval_minutes: 5,
        stalled_check_limit: 2,
      },
    })
    const result = create.result as { content: Array<{ text: string }> }
    const planPayload = JSON.parse(result.content[0]!.text)
    assert.equal(planPayload.status, 'awaiting_user_approval')
    assert.equal(planPayload.team.name, 'mcp-feature')
    assert.equal(planPayload.required_user_approval, `APPROVE TEAM ${planPayload.plan_id}`)
    const rejectedTeamApproval = await request('tools/call', {
      name: 'team_approve',
      arguments: { plan_id: planPayload.plan_id, user_approval: 'APPROVE TEAM other-plan' },
    })
    assert.equal((rejectedTeamApproval.result as { isError?: boolean }).isError, true)

    const organizationPlan = await request('tools/call', {
      name: 'organization_plan',
      arguments: {
        organization_name: 'MCP Organization',
        teams: [{
          name: 'delivery',
          leader: { name: 'delivery_lead', prompt: 'Coordinate delivery work.' },
          teammates: [{ name: 'implementer', prompt: 'Implement the approved work.' }],
        }],
      },
    })
    const organizationPlanResult = organizationPlan.result as { content: Array<{ text: string }> }
    const organizationPlanPayload = JSON.parse(organizationPlanResult.content[0]!.text)
    assert.equal(organizationPlanPayload.status, 'awaiting_user_approval')
    assert.equal(organizationPlanPayload.estimated_pool_sessions, 2)

    assert.equal(organizationPlanPayload.required_user_approval, `APPROVE ORGANIZATION ${organizationPlanPayload.plan_id}`)
    const rejectedApproval = await request('tools/call', {
      name: 'organization_approve',
      arguments: { plan_id: organizationPlanPayload.plan_id, user_approval: 'APPROVE ORGANIZATION some-other-plan' },
    })
    const rejectedApprovalResult = rejectedApproval.result as { isError?: boolean, content: Array<{ text: string }> }
    assert.equal(rejectedApprovalResult.isError, true)
    assert.match(rejectedApprovalResult.content[0]!.text, /user_approval must exactly match/)
  } finally {
    server.kill('SIGTERM')
    await once(server, 'exit')
    await assert.rejects(() => execFileAsync('tmux', ['has-session', '-t', 'pool-team-mcp-feature']))
    await rm(projectRoot, { recursive: true, force: true })
  }

  assert.equal(stderr, '')
})

test('delivers owned tasks and exposes unassigned tasks separately from live workers', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pool-agent-team-assignment-'))
  const fakeTmux = join(projectRoot, 'fake-tmux.mjs')
  const tmuxLog = join(projectRoot, 'tmux.log')
  await writeFile(
    fakeTmux,
    [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.POOL_AGENT_TEAM_TEST_TMUX_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      "if (process.argv.includes('-V')) process.stdout.write('tmux 3.2a\\n');",
      "if (process.argv.includes('has-session')) process.exit(1);",
      "if (process.argv.includes('new-window') || process.argv.includes('split-window')) process.stdout.write('%leader:999\\n');",
      "if (process.argv.includes('list-panes')) process.stdout.write('%worker:0\\n%leader:0\\n');",
    ].join('\n'),
  )
  await chmod(fakeTmux, 0o755)
  const statePath = join(projectRoot, '.poolside', 'agent-team', 'state.json')
  await mkdir(join(projectRoot, '.poolside', 'agent-team'), { recursive: true })
  await writeFile(statePath, JSON.stringify({
    version: 2,
    team: {
      name: 'assignment-test',
      createdAt: new Date().toISOString(),
      lead: 'team-lead',
      maxMembers: 4,
      tmuxSession: 'pool-team-assignment-test',
      progressCheckIntervalMinutes: 5,
      maxStalledChecks: 2,
    },
    nextTaskNumber: 1,
    nextMessageNumber: 1,
    members: [
      { name: 'team-lead', role: 'leader', joinedAt: new Date().toISOString(), status: 'running', tmuxPaneId: '%leader' },
      { name: 'worker', role: 'teammate', joinedAt: new Date().toISOString(), status: 'running', tmuxPaneId: '%worker' },
    ],
    tasks: [],
    messages: [],
  }))
  const server = spawn(process.execPath, [resolve('dist/index.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      POOL_AGENT_TEAM_PROJECT_ROOT: projectRoot,
      POOL_AGENT_TEAM_TMUX_COMMAND: fakeTmux,
      POOL_AGENT_TEAM_TEST_TMUX_LOG: tmuxLog,
      POOL_AGENT_TEAM_MEMBER: 'team-lead',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  let nextId = 1
  let buffered = ''
  server.stdout.setEncoding('utf8')
  server.stdout.on('data', chunk => {
    buffered += chunk
    while (true) {
      const newline = buffered.indexOf('\n')
      if (newline === -1) break
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      const message = JSON.parse(line) as Record<string, unknown>
      if (typeof message.id === 'number') pending.get(message.id)?.(message)
    }
  })
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++
    const response = new Promise<Record<string, unknown>>(resolveResponse => pending.set(id, resolveResponse))
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const message = await response
    pending.delete(id)
    return message
  }

  try {
    await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'agent-team-assignment-test', version: '1.0.0' },
    })
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const owned = await request('tools/call', {
      name: 'task_create',
      arguments: { subject: 'Implement assignment', description: 'Make the delivery observable.', owner: 'worker' },
    })
    const ownedResult = owned.result as { isError?: boolean, content: Array<{ text: string }> }
    assert.equal(ownedResult.isError, undefined, ownedResult.content[0]?.text)
    const ownedPayload = JSON.parse(ownedResult.content[0]!.text)
    assert.equal(ownedPayload.assignment_delivery.status, 'delivered')

    await request('tools/call', {
      name: 'task_create',
      arguments: { subject: 'Needs an owner', description: 'Leave this task unassigned.' },
    })
    const blocked = await request('tools/call', {
      name: 'task_create',
      arguments: {
        subject: 'Review implementation',
        description: 'Run after implementation completes.',
        owner: 'worker',
        depends_on: ['1'],
      },
    })
    const blockedPayload = JSON.parse((blocked.result as { content: Array<{ text: string }> }).content[0]!.text)
    assert.equal(blockedPayload.assignment_delivery.status, 'queued_until_dependencies_complete')
    const completed = await request('tools/call', {
      name: 'task_update',
      arguments: { task_id: '1', status: 'completed' },
    })
    const completedPayload = JSON.parse((completed.result as { content: Array<{ text: string }> }).content[0]!.text)
    assert.equal(completedPayload.unblocked_deliveries[0].status, 'delivered')
    const status = await request('tools/call', { name: 'team_status', arguments: {} })
    const statusResult = status.result as { isError?: boolean, content: Array<{ text: string }> }
    assert.equal(statusResult.isError, undefined, statusResult.content[0]?.text)
    const statusPayload = JSON.parse(statusResult.content[0]!.text)
    assert.equal(statusPayload.members.find((member: { name: string }) => member.name === 'worker').work_status.status, 'assigned_pending')
    assert.deepEqual(statusPayload.unassigned_tasks, [{ id: '2', subject: 'Needs an owner', status: 'pending' }])

    const invocations = (await readFile(tmuxLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[])
    assert.ok(invocations.some(args => args.includes('send-keys') && args.includes('%worker') && args.some(value => value.includes('You have been assigned task #1'))))
    assert.ok(invocations.some(args => args.includes('send-keys') && args.includes('%worker') && args.some(value => value.includes('You have been assigned task #3'))))
  } finally {
    server.kill('SIGTERM')
    await once(server, 'exit')
    await rm(projectRoot, { recursive: true, force: true })
  }
})
