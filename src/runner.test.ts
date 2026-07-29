import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { spawnPoolWorker } from './runner.js'
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

test('starts a pool worker in a named tmux window', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pool-agent-team-runner-'))
  const fakeTmux = join(projectRoot, 'fake-tmux.mjs')
  const receivedArgs = join(projectRoot, 'tmux-args.json')
  const previousCommand = process.env.POOL_AGENT_TEAM_TMUX_COMMAND
  const previousOutput = process.env.POOL_AGENT_TEAM_TEST_OUTPUT
  try {
    await writeFile(
      fakeTmux,
      [
        '#!/usr/bin/env node',
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.POOL_AGENT_TEAM_TEST_OUTPUT, JSON.stringify({ args: process.argv.slice(2) }));",
        "if (process.argv.includes('new-window')) process.stdout.write('%7:999\\n');",
      ].join('\n'),
    )
    await chmod(fakeTmux, 0o755)
    process.env.POOL_AGENT_TEAM_TMUX_COMMAND = fakeTmux
    process.env.POOL_AGENT_TEAM_TEST_OUTPUT = receivedArgs

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
      },
      store,
    )

    const invocation = JSON.parse(await readFile(receivedArgs, 'utf8')) as {
      args: string[]
    }
    assert.ok(invocation.args.includes('new-window'))
    assert.ok(invocation.args.includes('pool-team-feature-x'))
    assert.equal(spawned.tmuxPaneId, '%7')
    assert.equal((await store.read())?.members.find(member => member.name === 'tester')?.tmuxWindow, 'tester')
  } finally {
    if (previousCommand === undefined) delete process.env.POOL_AGENT_TEAM_TMUX_COMMAND
    else process.env.POOL_AGENT_TEAM_TMUX_COMMAND = previousCommand
    if (previousOutput === undefined) delete process.env.POOL_AGENT_TEAM_TEST_OUTPUT
    else process.env.POOL_AGENT_TEAM_TEST_OUTPUT = previousOutput
    await rm(projectRoot, { recursive: true, force: true })
  }
})
