import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LifecycleStore, archiveRuntimeDirectory } from './lifecycle.js'

test('persists teardown confirmation plans and archives terminated runtime state', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pool-agent-lifecycle-'))
  try {
    const lifecycle = new LifecycleStore(projectRoot)
    const plan = await lifecycle.create({
      kind: 'team',
      targetName: 'chat-ui',
      impact: { tmuxSessions: ['pool-team-chat-ui'], memberCount: 5, activeTaskCount: 3 },
    })
    assert.equal((await lifecycle.get(plan.id)).impact.memberCount, 5)

    const runtime = join(projectRoot, '.poolside', 'agent-team')
    await mkdir(runtime, { recursive: true })
    await writeFile(join(runtime, 'state.json'), '{"team":"chat-ui"}\n')
    const archivePath = await archiveRuntimeDirectory(projectRoot, runtime, 'team', 'chat-ui')
    assert.match(archivePath, /agent-team-archive/)
    assert.equal(await readFile(join(archivePath, 'state.json'), 'utf8'), '{"team":"chat-ui"}\n')
    await assert.rejects(() => readFile(join(runtime, 'state.json'), 'utf8'))

    await lifecycle.consume(plan.id)
    await assert.rejects(() => lifecycle.get(plan.id), /was not found/)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})
