import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizePlan, OrganizationStore } from './organization.js'
import { TeamError } from './store.js'

test('plans an organization without creating Team state, then activates isolated teams', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pool-agent-organization-'))
  try {
    const organizations = new OrganizationStore(projectRoot)
    const plan = await organizations.createPlan(normalizePlan({
      organizationName: 'Product Delivery',
      teams: [
        {
          name: 'build',
          description: 'Build the requested feature.',
          leader: { name: 'builder', prompt: 'Coordinate implementation.' },
          teammates: [{ name: 'coder', prompt: 'Implement the feature.' }],
        },
        {
          name: 'quality',
          description: 'Validate the requested feature.',
          leader: { name: 'reviewer', prompt: 'Coordinate validation.' },
        },
      ],
    }))
    assert.equal((await organizations.read()), undefined)
    assert.equal(plan.teams[0]?.leader.name, 'builder')

    for (const team of plan.teams) {
      await organizations.teamStore(plan.organizationName, team.name).create({
        teamName: team.name,
        maxMembers: team.maxMembers,
        tmuxSession: `pool-org-product-delivery-team-${team.name}`,
        leaderPid: process.pid,
        leaderName: team.leader.name,
      })
    }
    const state = await organizations.activate(plan, process.pid, plan.teams.map(team => ({
      name: team.name,
      tmuxSession: `pool-org-product-delivery-team-${team.name}`,
    })))
    assert.equal(state.teams.length, 2)
    assert.equal(state.teams[0]?.tmuxSession, 'pool-org-product-delivery-team-build')

    const buildStore = organizations.teamStore('product-delivery', 'build')
    const qualityStore = organizations.teamStore('product-delivery', 'quality')
    assert.match(buildStore.statePath, /\.poolside\/agent-organization\/build\/state\.json$/)
    await buildStore.addMember({ name: 'coder', role: 'teammate', joinedAt: new Date().toISOString(), status: 'idle' })
    await assert.rejects(
      () => buildStore.addMessage({ from: 'coder', to: 'reviewer', body: 'Can you review this?' }),
      TeamError,
    )
    await assert.rejects(
      () => qualityStore.messagesFor('coder', false),
      TeamError,
    )
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test('requires a leader and rejects duplicate team or member names in a plan', () => {
  assert.throws(() => normalizePlan({
    organizationName: 'test',
    teams: [{ name: 'a', description: 'Coordinate work.', leader: undefined as never }],
  }), /team leader is required/)
  assert.throws(() => normalizePlan({
    organizationName: 'test',
    teams: [
      { name: 'a', description: 'Coordinate work.', leader: { name: 'lead', prompt: 'Lead.' } },
      { name: 'a', description: 'Coordinate other work.', leader: { name: 'other', prompt: 'Lead.' } },
    ],
  }), /duplicate team name/)
  assert.throws(() => normalizePlan({
    organizationName: 'test',
    teams: [{
      name: 'a',
      description: 'Coordinate work.',
      leader: { name: 'lead', prompt: 'Lead.' },
      teammates: [{ name: 'lead', prompt: 'Duplicate.' }],
    }],
  }), /duplicate member/)
})
