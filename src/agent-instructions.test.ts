import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTeammateInstructions, buildTeamLeaderInstructions } from './agent-instructions.js'

test('renders the leader template with MCP-only coordination and the role prompt', () => {
  const instructions = buildTeamLeaderInstructions({
    name: 'team-lead',
    teamName: 'chat-ui',
    projectRoot: '/workspace/chat-ui',
    rolePrompt: 'Coordinate implementation delivery.',
  })
  assert.match(instructions, /task_create\(\{ subject, description, owner, depends_on\? \}\)/)
  assert.match(instructions, /team_work_plan\(\{ summary, steps \}\)/)
  assert.match(instructions, /team_finalize/)
  assert.match(instructions, /Assign independent, immediately executable tasks in parallel when that helps/)
  assert.match(instructions, /leave a reviewer, tester, or other teammate idle/)
  assert.match(instructions, /Never use shell commands, tmux, tmux send-keys/)
  assert.match(instructions, /Coordinate implementation delivery\./)
  assert.match(instructions, /\/workspace\/chat-ui/)
})

test('renders the teammate template with task lifecycle calls and the role prompt', () => {
  const instructions = buildTeammateInstructions({
    name: 'developer',
    teamName: 'chat-ui',
    projectRoot: '/workspace/chat-ui',
    rolePrompt: 'Implement the assigned UI.',
    teamLead: 'team-lead',
  })
  assert.match(instructions, /message_list\(\{\}\)\` and \`task_list/)
  assert.match(instructions, /status: "in_progress"/)
  assert.match(instructions, /to: "team-lead"/)
  assert.match(instructions, /Communicate freely with the team leader or any teammate/)
  assert.match(instructions, /Implement the assigned UI\./)
})
