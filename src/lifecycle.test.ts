import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LifecycleStore, archiveOrganizationRuntime, archiveRuntimeDirectory } from './lifecycle.js'

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

test('archives organization state and team runtimes while preserving plans', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pool-agent-organization-lifecycle-'))
  try {
    const runtime = join(projectRoot, '.poolside', 'agent-organization')
    await mkdir(join(runtime, 'build'), { recursive: true })
    await mkdir(join(runtime, 'quality'), { recursive: true })
    await writeFile(join(runtime, 'plans.json'), '[]\n')
    await writeFile(join(runtime, 'state.json'), '{"organization":"delivery"}\n')
    await writeFile(join(runtime, 'build', 'state.json'), '{"team":"build"}\n')
    await writeFile(join(runtime, 'quality', 'state.json'), '{"team":"quality"}\n')

    const archivePath = await archiveOrganizationRuntime({
      projectRoot,
      organizationDirectory: runtime,
      organizationName: 'delivery',
      teamNames: ['build', 'quality'],
    })
    assert.match(archivePath, /agent-organization-archive/)
    assert.equal(await readFile(join(archivePath, 'build', 'state.json'), 'utf8'), '{"team":"build"}\n')
    assert.equal(await readFile(join(runtime, 'plans.json'), 'utf8'), '[]\n')
    await assert.rejects(() => readFile(join(runtime, 'state.json'), 'utf8'))
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})
