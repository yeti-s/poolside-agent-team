# Poolside Agent Team

Poolside Agent Team is a local MCP server for coordinating multiple Pool CLI agents as one team. A leader creates the team and shared tasks; teammates run in separate tmux windows as parallel `pool exec` workers.

## Features

- **Team creation and leadership** — The current `pool` session becomes `team-lead`. Only one active team is allowed per project.
- **Concurrent member limits** — `team_create.max_members` limits concurrent members, including the leader. The default is four.
- **Parallel teammate execution** — Only the leader can call `team_spawn`. Each teammate runs as an independent `pool exec` process in the shared workspace.
- **tmux visibility** — Every team receives a `pool-team-<team-name>` tmux session, a `team-status` window, and one named window per teammate.
- **Shared task coordination** — Teammates share tasks, ownership, dependencies, and completion state. Finished or failed teammates free a slot for a replacement.
- **Direct messaging** — Team members exchange progress updates, questions, and blockers by teammate name.
- **Automatic cleanup** — `team_delete` terminates remaining teammate windows and removes team state. When the leader Pool CLI exits, the tmux session and all teammate work stop as well. A watchdog handles unexpected leader termination.

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

The `team-status` window displays shared team state. Each teammate window shows that worker's live Pool output.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `team_create` | Create a team and configure `max_members` |
| `team_list`, `team_status` | Inspect members, tmux identifiers, task summary, and messages |
| `team_spawn` | Start a teammate in a tmux window |
| `task_create`, `task_list`, `task_update` | Create, view, assign, and complete shared tasks |
| `message_send`, `message_list` | Send and read teammate messages |
| `team_request_shutdown` | Ask one teammate to shut down cooperatively |
| `team_delete` | Stop all teammate windows and remove team resources |

## Runtime files and safety

- Team state: `.poolside/agent-team/state.json`
- Teammate logs: `.poolside/agent-team/logs/`
- tmux launch scripts: `.poolside/agent-team/run/`

Teammates run with `pool exec --unsafe-auto-allow`. They can edit files and execute commands without per-action approval, so use this only in trusted projects. All teammates share one workspace; split work to avoid editing the same files concurrently.
