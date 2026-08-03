import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('main CLI requires a later approval before tearing down and archiving a standalone team', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pool-agent-team-teardown-mcp-'))
  const tmux = join(projectRoot, 'fake-tmux.mjs')
  const tmuxLog = join(projectRoot, 'tmux.log')
  await writeFile(tmux, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.POOL_AGENT_TEAM_TEST_TMUX_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
  ].join('\n'))
  await chmod(tmux, 0o755)
  const runtime = join(projectRoot, '.poolside', 'agent-team')
  await mkdir(runtime, { recursive: true })
  await writeFile(join(runtime, 'state.json'), JSON.stringify({
    version: 2,
    team: { name: 'chat-ui', createdAt: new Date().toISOString(), lead: 'team-lead', maxMembers: 2, tmuxSession: 'pool-team-chat-ui' },
    nextTaskNumber: 2,
    nextMessageNumber: 1,
    members: [
      { name: 'team-lead', role: 'leader', joinedAt: new Date().toISOString(), status: 'running' },
      { name: 'developer', role: 'teammate', joinedAt: new Date().toISOString(), status: 'running' },
    ],
    tasks: [{ id: '1', subject: 'Build UI', description: 'Implement chat UI.', status: 'in_progress', owner: 'developer', blocks: [], blockedBy: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    messages: [],
  }))

  const server = spawn(process.execPath, [resolve('dist/index.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      POOL_AGENT_TEAM_PROJECT_ROOT: projectRoot,
      POOL_AGENT_TEAM_TMUX_COMMAND: tmux,
      POOL_AGENT_TEAM_TEST_TMUX_LOG: tmuxLog,
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
    const result = await response
    pending.delete(id)
    return result
  }

  try {
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'teardown-test', version: '1.0.0' } })
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const delegatedStatus = await request('tools/call', { name: 'team_status', arguments: {} })
    const delegatedStatusResult = delegatedStatus.result as { isError?: boolean, content: Array<{ text: string }> }
    assert.equal(delegatedStatusResult.isError, true)
    assert.match(delegatedStatusResult.content[0]!.text, /delegated coordination/)
    const reportWhileRunning = await request('tools/call', { name: 'team_report', arguments: {} })
    const reportPayload = JSON.parse((reportWhileRunning.result as { content: Array<{ text: string }> }).content[0]!.text)
    assert.equal(reportPayload.status, 'awaiting_leader_report')
    const planned = await request('tools/call', { name: 'team_teardown_plan', arguments: {} })
    const payload = JSON.parse((planned.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      teardown_id: string
      impact: { activeTaskCount: number }
      required_user_approval: string
    }
    assert.equal(payload.impact.activeTaskCount, 1)
    await assert.rejects(() => readFile(tmuxLog, 'utf8'))

    const rejected = await request('tools/call', {
      name: 'team_teardown_approve',
      arguments: { teardown_id: payload.teardown_id, user_approval: 'APPROVE TEAM TEARDOWN other-plan' },
    })
    assert.equal((rejected.result as { isError?: boolean }).isError, true)
    assert.ok(await readFile(join(runtime, 'state.json'), 'utf8'))

    const approved = await request('tools/call', {
      name: 'team_teardown_approve',
      arguments: { teardown_id: payload.teardown_id, user_approval: payload.required_user_approval },
    })
    const approvedPayload = JSON.parse((approved.result as { content: Array<{ text: string }> }).content[0]!.text)
    assert.equal(approvedPayload.torn_down, true)
    const archives = await readdir(join(projectRoot, '.poolside', 'agent-team-archive'))
    assert.equal(archives.length, 1)
    assert.ok(await readFile(join(projectRoot, '.poolside', 'agent-team-archive', archives[0]!, 'state.json'), 'utf8'))
    const tmuxCalls = await readFile(tmuxLog, 'utf8')
    assert.match(tmuxCalls, /kill-session/)
  } finally {
    server.kill('SIGTERM')
    await once(server, 'exit')
    await rm(projectRoot, { recursive: true, force: true })
  }
})
