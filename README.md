# Poolside Agent Team

Poolside Agent Team is a local MCP server for coordinating multiple Pool CLI agents as one team. A leader creates the team and shared tasks; teammates run as interactive `pool` sessions in tmux panes.

![Four teammates collaborating through direct messages in tmux](assets/team-collaboration.gif)

This demo runs [Pool](https://github.com/poolsideai/pool) on an NVIDIA DGX Spark with `Qwen/Qwen3.6-35B-A3B-FP8`, showing four teammates coordinating in English through direct messages.

## Features

- **Team creation and leadership** — The current `pool` session becomes `team-lead`. Only one active team is allowed per project.
- **Concurrent member limits** — `team_create.max_members` limits concurrent members, including the leader. The default is four.
- **Parallel teammate execution** — Only the leader can call `team_spawn`. Each teammate runs as an independent interactive `pool` session in the shared workspace, starting with its assigned prompt queued.
- **Single-screen tmux view** — Every team receives a `pool-team-<team-name>` tmux session. The `team` window tiles all teammate panes together, while `team-status` displays shared state.
- **Shared task coordination** — Teammates share tasks, ownership, dependencies, and completion state. Finished or failed teammates free a slot for a replacement.
- **Recoverable teammates** — Each worker records its Pool session ID when available. A stopped worker can resume that session; if it cannot, the team starts a fresh recovery session with its role, outstanding tasks, and unread messages.
- **Direct messaging** — Team members exchange progress updates, questions, and blockers by teammate name. Use `message_kind: fyi` or `ack` for non-actionable information and acknowledgements; they are recorded without interrupting recipients. A response-required lead message automatically revives an unexpectedly stopped teammate before delivery; deliberately shutdown teammates remain queued.
- **User and leader intervention** — Attach to a teammate pane to give its Pool session more instructions or press `Esc` to interrupt its current work. The leader can use `team_interrupt` to interrupt one teammate remotely; teammates cannot interrupt one another.
- **Automatic cleanup** — `team_delete` terminates remaining teammate panes and removes team state. When the leader Pool CLI exits, the tmux session and all teammate work stop as well. A watchdog handles unexpected leader termination.

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

## MCP tools

| Tool | Purpose |
| --- | --- |
| `team_create` | Create a team and configure `max_members` |
| `team_list`, `team_status` | Inspect members, tmux identifiers, task summary, and messages |
| `team_adopt` | Transfer team-lead ownership to a restarted Pool CLI session |
| `team_spawn` | Start an interactive teammate in a pane of the tmux `team` window |
| `team_resume` | Explicitly restart a stopped or failed teammate, preferring its saved Pool session |
| `task_create`, `task_list`, `task_update` | Create, view, assign, and complete shared tasks |
| `message_send`, `message_list` | Send and read teammate messages (`task`/`handoff`/`decision` prompt a response; `fyi`/`ack` do not) |
| `team_interrupt` | Leader-only: interrupt a teammate's current task without closing its Pool session |
| `team_request_shutdown` | Ask one teammate to shut down cooperatively |
| `team_delete` | Stop all teammate panes and remove team resources |

## Runtime files and safety

- Team state: `.poolside/agent-team/state.json`
- Teammate logs: `.poolside/agent-team/logs/`
- tmux launch scripts: `.poolside/agent-team/run/`
- Worker state includes the last Pool session ID, restart count, termination reason, and last error when available.

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
