import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
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
    assert.ok(names.includes('team_create'))
    assert.ok(names.includes('team_spawn'))
    assert.ok(names.includes('team_adopt'))
    assert.ok(names.includes('team_resume'))
    assert.ok(names.includes('team_interrupt'))
    assert.ok(names.includes('organization_plan'))
    assert.ok(names.includes('organization_approve'))
    assert.ok(names.includes('organization_message_send'))
    const messageSend = (tools.result as { tools: Array<{ name: string, inputSchema: { properties?: Record<string, unknown> } }> }).tools
      .find(tool => tool.name === 'message_send')
    assert.ok(messageSend?.inputSchema.properties?.message_kind)
    assert.ok(messageSend?.inputSchema.properties?.requires_response)

    const create = await request('tools/call', {
      name: 'team_create',
      arguments: { team_name: 'MCP Feature', description: 'MCP test team', leader_name: 'team-lead' },
    })
    const result = create.result as { content: Array<{ text: string }> }
    assert.equal(JSON.parse(result.content[0]!.text).team_name, 'mcp-feature')

    const adopt = await request('tools/call', { name: 'team_adopt', arguments: {} })
    const adoptResult = adopt.result as { content: Array<{ text: string }> }
    assert.equal(JSON.parse(adoptResult.content[0]!.text).adopted, true)

    const task = await request('tools/call', {
      name: 'task_create',
      arguments: { subject: 'Validate MCP', description: 'Create a task through JSON-RPC' },
    })
    const taskResult = task.result as { content: Array<{ text: string }> }
    assert.equal(JSON.parse(taskResult.content[0]!.text).id, '1')

    const acknowledgement = await request('tools/call', {
      name: 'message_send',
      arguments: { to: 'team-lead', message: 'Thanks.', message_kind: 'ack' },
    })
    const acknowledgementResult = acknowledgement.result as { content: Array<{ text: string }> }
    const acknowledgementPayload = JSON.parse(acknowledgementResult.content[0]!.text)
    assert.equal(acknowledgementPayload.message.messageKind, 'ack')
    assert.equal(acknowledgementPayload.message.requiresResponse, false)

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
  } finally {
    server.kill('SIGTERM')
    await once(server, 'exit')
    await assert.rejects(() => execFileAsync('tmux', ['has-session', '-t', 'pool-team-mcp-feature']))
    await rm(projectRoot, { recursive: true, force: true })
  }

  assert.equal(stderr, '')
})
