# Poolside Agent Team

Poolside Agent Team is a local MCP server for coordinating multiple Pool CLI agents as one team. A leader creates the team and shared tasks; teammates run as interactive `pool` sessions in tmux panes.

![Four teammates collaborating through direct messages in tmux](assets/team-collaboration.gif)

This demo runs [Pool](https://github.com/poolsideai/pool) on an NVIDIA DGX Spark with `Qwen/Qwen3.6-35B-A3B-FP8`, showing four teammates coordinating in English through direct messages.

## Features

- **Team creation and leadership** — A team always has a leader. The main Pool CLI creates the approved members, then sends the saved team objective to the leader. Only one active standalone team is allowed per project.
- **Concurrent member limits** — `team_plan.max_members` limits concurrent members, including the leader. The default is four.
- **Idle-first execution** — Every approved member starts as an independent idle interactive `pool` session. No work prompt is queued during creation; after all members are ready, only the leader receives the initial objective and distributes teammate tasks.
- **Single-screen tmux view** — Every team receives a `pool-team-<team-name>` tmux session. The `team` window tiles all teammate panes together, while `team-status` displays shared state.
- **Shared task coordination** — Teammates share tasks, ownership, dependencies, and completion state. Finished or failed teammates free a slot for a replacement.
- **Progress watchdog** — The leader sidecar checks each live teammate's in-progress task every five minutes by default. After two unchanged checks, it interrupts the open-ended turn and requires the teammate to split the work into small, independently verifiable steps before continuing.
- **Recoverable teammates** — Each worker records its Pool session ID when available. A stopped worker can resume that session; if it cannot, the team starts a fresh recovery session with its role, outstanding tasks, and unread messages.
- **Direct messaging** — Team members exchange progress updates, questions, and blockers by teammate name. Use `message_kind: fyi` or `ack` for non-actionable information and acknowledgements; they are recorded without interrupting recipients. A response-required lead message automatically revives an unexpectedly stopped teammate before delivery; deliberately shutdown teammates remain queued.
- **User and leader intervention** — Attach to a teammate pane to give its Pool session more instructions or press `Esc` to interrupt its current work. The leader can use `team_interrupt` to interrupt one teammate remotely; teammates cannot interrupt one another.
- **Main-owned cleanup** — Only the main Pool CLI may tear down a team or organization after explicit user approval. Teardown moves the active runtime to an ignored archive directory for audit evidence.
- **Organization coordination** — An organization contains isolated teams, each with a required team lead and its own tmux session. The organization lead first saves a team plan; Pool agents and tmux sessions start only after the user explicitly approves that plan.

## Install and build

```bash
npm install
npm run build
npm test
```

`tmux` must be installed to run teammates.

## Connect to a Pool project

This repository includes its own `.poolside/settings.yaml` and `agent-team` Skill. Running `pool` from this repository uses the built MCP server and Skill directly.

To use it from another Pool project, copy the settings and Skill into that project's `.poolside/` directory, then update the MCP executable path to this repository's absolute `dist/index.js` path.

```yaml
mcp_servers:
  agent-team:
    command: node
    args:
      - <absolute-path>/dist/index.js
    cwd: .
```

In Pool, apply the `agent-team` Skill or ask the agent to coordinate work with the agent-team MCP tools.

## View a team in tmux

```bash
tmux attach -t pool-team-<team-name>
tmux list-windows -t pool-team-<team-name>
```

The `team` window displays every live teammate in a tiled pane. Select a pane to type directly into its Pool session; press `Esc` there to interrupt only its current task while leaving the session available for follow-up work. The `team-status` window displays shared state.

Organization teams use one session per team:

```bash
tmux attach -t pool-org-<organization-name>-team-<team-name>
```

## Organization workflow

1. Call `organization_plan` with the organization purpose and its complete team list. Every listed team must include one `leader` with a name and prompt; optional `teammates` are started with that leader.
2. Show the returned plan ID, team list, and estimated Pool session count to the user. This operation starts no tmux session or Pool agent.
3. Stop and ask the user for the exact `required_user_approval` statement returned by the plan. Only after a later user message contains that exact statement may the Agent call `organization_approve` with the plan ID and copied statement. Never infer, paraphrase, or create approval on the user's behalf.
4. Each team then receives an isolated state file, per-agent runtime directories, and idle tmux sessions. After every member is ready, the main CLI sends each team description to its leader. A teammate can use normal task and message tools only inside its own team. Use `organization_message_send` only from a team lead to another team lead for cross-team opinions.

The organization lead can inspect the teams with `organization_status` and remove all organization resources with `organization_delete`. A team lead may manage teammates only within its own team; it cannot delete the organization.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `team_plan`, `team_approve` | Save a complete standalone team plan, obtain explicit user approval, create idle members, then automatically send the saved objective to the leader |
| `team_list`, `team_status` | Inspect members, tmux identifiers, task summary, and messages |
| `team_adopt` | Transfer team-lead ownership to a restarted Pool CLI session |
| `team_resume` | Explicitly restart a stopped or failed teammate, preferring its saved Pool session |
| `task_create`, `task_list`, `task_update` | Create, view, assign, and complete shared tasks; use `depends_on` for prerequisites and `task_update.progress_note` for concrete progress or blockers |
| `message_send`, `message_list` | Send and read teammate messages (`task`/`handoff`/`decision` prompt a response; `fyi`/`ack` do not) |
| `team_interrupt` | Leader-only: interrupt a teammate's current task without closing its Pool session |
| `team_request_shutdown` | Ask one teammate to shut down cooperatively |
| `team_teardown_plan`, `team_teardown_approve` | Main-CLI-only approved teardown; stop panes and archive the active team runtime |
| `organization_plan` | Save a complete Team configuration without starting resources; every Team needs a leader |
| `organization_approve` | Create idle sessions for every approved member, then send each team objective to its leader |
| `organization_status`, `organization_teardown_*` | Inspect an organization or archive it after main-CLI user-approved teardown |
| `organization_message_send` | Team-lead-only cross-Team opinion sharing |

## Runtime files and safety

Active runtime is intentionally visible to Git and is archived only when the main CLI tears it down:

```text
.poolside/agent-team/
  plans.json
  <team>/state.json
  <team>/<team>-<agent>/AGENTS.md
  <team>/<team>-<agent>/.poolside/settings.local.yaml
  <team>/<team>-<agent>/<agent>.json
  <team>/<team>-<agent>/<agent>.session.json
  <team>/<team>-<agent>/<agent>.log

.poolside/agent-organization/
  plans.json
  state.json
  <team>/state.json
  <team>/<team>-<agent>/...
```

Each agent starts in its own runtime directory, where Pool loads its native `AGENTS.md` and a generated local MCP configuration. That configuration exposes only the agent-team tools appropriate to the agent's role: coordination and recovery tools to the team leader, and task/message tools to teammates. It does not expose main-CLI lifecycle tools. The instruction file and the member `prompt` saved in team state contain the same role instructions; they direct project work to the actual project root. `.poolside/agent-team-archive/` and `.poolside/agent-organization-archive/` are ignored and receive the complete terminated runtime.

When Pool's model server disconnects, a pane can remain open at the interactive
prompt even though its prior turn failed. `team_status` reports pane liveness;
send the worker a follow-up with `message_send`, or use `team_resume` when its
pane has exited. A message from the lead is treated as a new explicit work
instruction, including for a teammate whose earlier tasks are complete. The
worker must report completion or a blocker through `message_send` rather than
silently waiting at the Pool prompt. `message_send` is not merely a mailbox:
when sent by the lead to a recoverable stopped worker, it restarts the worker
and queues the message. `team_request_shutdown` opts a worker out of this
automatic restart behavior.

To upgrade or restart a lead Pool CLI without destroying a live team, open the
replacement Pool CLI first and call `team_adopt` (use `force: true` only when
the original leader is still alive). The old lead then no longer owns cleanup
of the tmux session, so it can exit safely.

Teammates run as `pool --mode always-allow` interactive sessions. They can edit files and execute commands without per-action approval, so use this only in trusted projects. All teammates share one workspace; split work to avoid editing the same files concurrently.

## Long-running task handling

For every in-progress task with a live teammate owner, the leader sidecar checks
`lastProgressAt` on the configured cadence. A material `task_update` (status,
owner, task content, dependencies, or a non-empty `progress_note`) resets this
timer. The first unchanged review asks for a concrete progress/blocker report.
At the configured `stalled_check_limit` (two checks by default), the sidecar
sends `Esc` to stop the current thinking turn, then directs the teammate to
create or update 2–4 smaller tasks with acceptance criteria and work only on
the smallest next step. An escalation is sent once per unchanged stretch;
recording real progress resets the counter.

Use `depends_on` when one task must finish before another can start. The older
`blocks` field is intentionally retained for compatibility, but has the inverse
meaning: it lists tasks that the current task prevents from starting. Using
`blocks` as a normal dependency can deadlock a team.

The team leader chooses the execution schedule. Independent, ready tasks may be
assigned in parallel. A reviewer, tester, or other teammate may remain idle
until an implementation prerequisite is complete; represent that sequence with
`depends_on`, or assign the later work only when it becomes ready. The initial
leadership watchdog requires one executable first assignment, not an immediate
assignment for every teammate.
