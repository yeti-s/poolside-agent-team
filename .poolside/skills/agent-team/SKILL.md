---
name: agent-team
description: Coordinate a Pool CLI team when a task benefits from parallel research, implementation, or testing. Use for creating a team, assigning shared tasks, communicating with teammates, and closing a team.
---

# Pool agent team

Use the `agent-team` MCP tools to coordinate parallel Pool workers. Create a
team only when the work has independent parts that benefit from concurrent
execution.

## Workflow

1. Call `team_create` once with a concise name, purpose, and optional
   `max_members`. The default is 4 concurrent members and the limit includes
   `team-lead`.
2. Break the work into small shared tasks with `task_create`; add blocking
   task IDs when order matters.
3. Start one teammate per independent workstream with `team_spawn`. Give each
   teammate a precise outcome and name it by role, such as `researcher` or
   `tester`.
4. Assign each task with `task_update`. Use teammate names, never internal IDs.
5. After a task, update its status and check `task_list` plus `message_list`
   before claiming more work. An idle teammate can receive a new task and is
   not necessarily finished.
6. Use `message_send` for decisions, blockers, and handoffs. Messages are
   addressed by teammate name.
7. Use `tmux attach -t pool-team-<team-name>` to inspect live teammates. The
   `team` window shows all teammate panes together; `team-status` shows shared
   state. You can select a pane to give its Pool session an additional prompt,
   or press `Esc` there to interrupt its current work.
8. Only the lead can interrupt another teammate through `team_interrupt`; a
   teammate must never attempt to interrupt another teammate. Ask finished
   teammates to stop with `team_request_shutdown`. `team_delete` terminates
   remaining teammate panes and removes team state.

## Safety and ownership

- The team lead creates and removes teams and starts teammates. A teammate must
  not call `team_spawn` or `team_delete`.
- Keep tasks narrow enough that two teammates do not edit the same files at the
  same time. This implementation uses one shared workspace, not Git worktrees.
- Workers run as interactive Pool sessions in Always Allow mode. Only create a
  team in a trusted project and never ask a teammate to expose credentials or
  modify systems outside the requested work.
- A shutdown request is cooperative: finish or safely stop current work, read
  the shutdown message, then exit. The leader Pool CLI owns the tmux session;
  exiting the leader CLI terminates every teammate window automatically.
