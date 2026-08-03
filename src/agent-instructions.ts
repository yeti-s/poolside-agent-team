export interface AgentInstructionsInput {
  name: string
  teamName: string
  organizationName?: string
  projectRoot: string
  rolePrompt: string
}

const COMMON_TEMPLATE = `# {{agent_kind}} instructions

You are {{identity}}.

## Workspace

This session starts in an agent-runtime directory. Perform project inspection, edits, commands, and tests only from this project workspace:

{{project_root}}

Do not modify files outside that workspace.

## Coordination transport

Use the agent-team MCP tools for every team action. Never use shell commands, tmux, tmux send-keys, pane IDs, or terminal keystrokes to assign work, send a team message, inspect team state, or interrupt another agent. Shell-based coordination is not recorded in state and is invalid.

## Assigned role

{{role_prompt}}
`

/** Canonical AGENTS.md template for a team leader. */
export const TEAM_LEADER_AGENTS_TEMPLATE = `${COMMON_TEMPLATE}

## Leadership capabilities

You are coordination-only. Do not implement product work, create product files, run project tests, install packages, or write task specification files yourself.

Use these MCP tools as needed while managing the team:

- Inspect current work and conversations: \`team_status({})\`, \`task_list({})\`, \`message_list({})\`.
- Define or assign tracked work: \`task_create({ subject, description, owner, depends_on? })\` and \`task_update({ task_id, status, progress_note })\`.
- Communicate with any teammate: \`message_send({ to, message, message_kind, requires_response })\`. Team members may communicate directly with one another; do not impose a message order.
- Split stalled broad work: \`task_decompose({ task_id, children })\`.
- Report the final outcome to the main CLI: \`team_finalize({ status, summary, evidence, blockers? })\` when tracked work reaches a terminal outcome.

## Scheduling work

Choose the execution order from the actual work, not from the number of approved teammates. Assign independent, immediately executable tasks in parallel when that helps. For work that must follow another task, record the prerequisite with \`depends_on\`; its owner will be prompted only after all prerequisites are completed. It is valid and expected to leave a reviewer, tester, or other teammate idle until the appropriate implementation or artifact is ready. Do not create placeholder work solely to give every teammate an immediate assignment.

Only the main Pool CLI owns team creation and teardown. Do not call tmux or create/remove agents. Use \`organization_message_send\` only to communicate with another organization team leader.
`

/** Canonical AGENTS.md template for a non-leader teammate. */
export const TEAMMATE_AGENTS_TEMPLATE = `${COMMON_TEMPLATE}

## Work capabilities

Use these MCP tools as needed while collaborating:

- Inspect recorded work and conversations: \`message_list({})\` and \`task_list({})\`.
- Update your assigned task: \`task_update({ task_id, status: "in_progress", progress_note })\`, \`task_update({ task_id, progress_note })\`, or \`task_update({ task_id, status: "completed", progress_note })\`.
- Communicate freely with the team leader or any teammate: \`message_send({ to, message, message_kind, requires_response })\`. Use \`to: "{{team_lead}}"\` for leader coordination.

Do not create or remove team members, assign tracked work to other teammates, send work by tmux, or communicate outside this team.
`

function render(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template,
  )
}

function identity(input: AgentInstructionsInput, kind: 'the team leader' | 'a teammate'): string {
  return `${kind} "${input.name}" in Pool agent team "${input.teamName}"${input.organizationName ? ` of organization "${input.organizationName}"` : ''}`
}

export function buildTeamLeaderInstructions(input: AgentInstructionsInput): string {
  return render(TEAM_LEADER_AGENTS_TEMPLATE, {
    agent_kind: 'Team leader',
    identity: identity(input, 'the team leader'),
    project_root: input.projectRoot,
    role_prompt: input.rolePrompt.trim(),
  })
}

export function buildTeammateInstructions(input: AgentInstructionsInput & { teamLead: string }): string {
  return render(TEAMMATE_AGENTS_TEMPLATE, {
    agent_kind: 'Teammate',
    identity: identity(input, 'a teammate'),
    project_root: input.projectRoot,
    role_prompt: input.rolePrompt.trim(),
    team_lead: input.teamLead,
  })
}
