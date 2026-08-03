import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { interruptTmuxPane, sendPromptToTmuxPane, spawnPoolWorker } from './runner.js'
import { TeamStore } from './store.js'

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition did not become true before timeout')
}

test('starts interactive Pool workers in tiled panes of the team window', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pool-agent-team-runner-'))
  const fakeTmux = join(projectRoot, 'fake-tmux.mjs')
  const fakeBwrap = join(projectRoot, 'fake-bwrap.sh')
  const receivedArgs = join(projectRoot, 'tmux-args.json')
  const previousCommand = process.env.POOL_AGENT_TEAM_TMUX_COMMAND
  const previousOutput = process.env.POOL_AGENT_TEAM_TEST_OUTPUT
  const previousDiscoveryTimeout = process.env.POOL_AGENT_TEAM_SESSION_DISCOVERY_TIMEOUT_MS
  const previousBwrap = process.env.POOL_AGENT_TEAM_BWRAP_COMMAND
  try {
    await writeFile(
      fakeTmux,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync(process.env.POOL_AGENT_TEAM_TEST_OUTPUT, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "if (process.argv.includes('new-window') || process.argv.includes('split-window')) process.stdout.write('%7:999\\n');",
        "if (process.argv.includes('list-panes')) process.stdout.write('%7:0\\n');",
      ].join('\n'),
    )
    await chmod(fakeTmux, 0o755)
    await writeFile(fakeBwrap, '#!/bin/sh\nexit 0\n')
    await chmod(fakeBwrap, 0o755)
    process.env.POOL_AGENT_TEAM_TMUX_COMMAND = fakeTmux
    process.env.POOL_AGENT_TEAM_TEST_OUTPUT = receivedArgs
    process.env.POOL_AGENT_TEAM_SESSION_DISCOVERY_TIMEOUT_MS = '0'
    process.env.POOL_AGENT_TEAM_BWRAP_COMMAND = fakeBwrap

    const store = new TeamStore(projectRoot)
    await store.create({
      teamName: 'feature-x',
      maxMembers: 4,
      tmuxSession: 'pool-team-feature-x',
      leaderPid: process.pid,
    })
    const spawned = await spawnPoolWorker(
      {
        name: 'tester',
        teamName: 'feature-x',
        tmuxSession: 'pool-team-feature-x',
        prompt: 'Run the test suite.',
        projectRoot,
        agentName: 'metadata-agent',
        model: 'laguna-test',
      },
      store,
    )
    const secondSpawned = await spawnPoolWorker(
      {
        name: 'reviewer',
        teamName: 'feature-x',
        tmuxSession: 'pool-team-feature-x',
        prompt: 'Review the implementation.',
        projectRoot,
      },
      store,
    )
    await interruptTmuxPane(spawned.tmuxPaneId)
    await sendPromptToTmuxPane(spawned.tmuxPaneId, 'Continue with the assigned task.')

    const invocations = (await readFile(receivedArgs, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    const launch = invocations.find(args => args.includes('new-window'))
    const split = invocations.find(args => args.includes('split-window'))
    assert.ok(launch)
    assert.ok(split)
    assert.ok(launch.includes('pool-team-feature-x'))
    assert.ok(split.includes('pool-team-feature-x:team'))
    assert.ok(invocations.some(args => args.includes('select-layout') && args.includes('tiled')))
    assert.ok(invocations.some(args => args.includes('pipe-pane') && args.includes('%7')))
    assert.ok(invocations.some(args => args.includes('send-keys') && args.includes('Escape')))
    assert.ok(invocations.some(args => args.includes('send-keys') && args.includes('-l') && args.includes('Continue with the assigned task.')))
    assert.equal(spawned.tmuxPaneId, '%7')
    assert.equal(secondSpawned.tmuxWindow, 'team')
    assert.equal((await store.read())?.members.find(member => member.name === 'tester')?.tmuxWindow, 'team')

    const config = JSON.parse(await readFile(join(projectRoot, '.poolside', 'agent-team', 'run', 'tester.json'), 'utf8')) as {
      poolArgs: string[]
      agentName?: string
    }
    assert.deepEqual(config.poolArgs.slice(0, 7), [
      '--directory',
      projectRoot,
      '--mode',
      'always-allow',
      '--prompt-queue',
      config.poolArgs[5]!,
      '--model',
    ])
    assert.equal(config.poolArgs[7], 'laguna-test')
    assert.ok(!config.poolArgs.includes('exec'))
    assert.ok(!config.poolArgs.includes('--agent-name'))
    assert.equal(config.agentName, 'metadata-agent')
    assert.match(config.poolArgs[5]!, /direct coordination message from team-lead is an explicit task assignment/)
    assert.match(config.poolArgs[5]!, /task_update with a concise progress_note/)
    assert.match(config.poolArgs[5]!, /watchdog reviews unchanged in-progress tasks every five minutes/)
    assert.match(config.poolArgs[5]!, /Only leave the team after an explicit shutdown request/)

    const leader = await spawnPoolWorker(
      {
        name: 'team-lead',
        teamName: 'feature-x',
        tmuxSession: 'pool-team-feature-x',
        prompt: 'Coordinate the approved work.',
        projectRoot,
        role: 'leader',
        replaceExisting: true,
      },
      store,
    )
    assert.ok(leader.tmuxPaneId)
    const leaderConfig = JSON.parse(await readFile(join(projectRoot, '.poolside', 'agent-team', 'run', 'team-lead.json'), 'utf8')) as {
      leaderSandbox?: { command: string, args: string[] }
      poolArgs: string[]
    }
    assert.equal(leaderConfig.leaderSandbox?.command, fakeBwrap)
    assert.ok(leaderConfig.leaderSandbox?.args.includes('--ro-bind'))
    assert.ok(leaderConfig.leaderSandbox?.args.includes(join(projectRoot, '.poolside', 'agent-team')))
    assert.match(leaderConfig.poolArgs[5]!, /coordination-only leader/)
  } finally {
    if (previousCommand === undefined) delete process.env.POOL_AGENT_TEAM_TMUX_COMMAND
    else process.env.POOL_AGENT_TEAM_TMUX_COMMAND = previousCommand
    if (previousOutput === undefined) delete process.env.POOL_AGENT_TEAM_TEST_OUTPUT
    else process.env.POOL_AGENT_TEAM_TEST_OUTPUT = previousOutput
    if (previousDiscoveryTimeout === undefined) delete process.env.POOL_AGENT_TEAM_SESSION_DISCOVERY_TIMEOUT_MS
    else process.env.POOL_AGENT_TEAM_SESSION_DISCOVERY_TIMEOUT_MS = previousDiscoveryTimeout
    if (previousBwrap === undefined) delete process.env.POOL_AGENT_TEAM_BWRAP_COMMAND
    else process.env.POOL_AGENT_TEAM_BWRAP_COMMAND = previousBwrap
    await rm(projectRoot, { recursive: true, force: true })
  }
})
