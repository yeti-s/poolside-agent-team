---
name: agent-team
description: Coordinate a Pool CLI team when a task benefits from parallel research, implementation, or testing. Use for creating a team, assigning shared tasks, communicating with teammates, and closing a team.
---

# Pool agent team

Use the `agent-team` MCP tools to coordinate parallel Pool workers. Create a
team only when the work has independent parts that benefit from concurrent
execution.

## Organization workflow

Use an Organization when multiple independent teams must coordinate. An
Organization is expensive because it starts a separate tmux session and Pool
agents for every planned team.

1. Call `organization_plan` with the complete team list. Every team must have
   exactly one `leader` with a name and concrete prompt; include any initial
   teammates in that team's list.
2. Present the returned `plan_id`, team names, team leads, estimated Pool
   session count, and `required_user_approval` statement to the user. Stop
   there; do not call `organization_approve` in the same turn.
3. Only after a later user message contains the exact
   `required_user_approval` statement, call `organization_approve` with the
   plan ID and a verbatim copy of that statement. Never infer, paraphrase,
   generate, or claim approval on the user's behalf. This starts one tmux
   session per team.
4. A teammate may use tasks and `message_send` only within its own team. Never
   attempt to name, inspect, or contact a member in another team.
5. A team lead may use `organization_message_send` only to share an opinion
   with another team lead. Do not use it to contact another team's teammate.
6. Use `organization_status` for organization-level status and
   `organization_delete` only when the organization lead should stop every
   team.

## Workflow

1. Call `team_create` once with a concise name, purpose, required
   `leader_name: "team-lead"`, and optional `max_members`. The default is 4
   concurrent members and the limit includes `team-lead`.
2. Break the work into small shared tasks with `task_create`; add blocking
   task IDs when order matters.
   If the leader Pool CLI was restarted while preserving an existing team, call
   `team_adopt` first. Use `force: true` only to deliberately replace a still
   running previous leader.
3. Start one teammate per independent workstream with `team_spawn`. Give each
   teammate a precise outcome and name it by role, such as `researcher` or
   `tester`.
4. Assign each task with `task_update`. Use teammate names, never internal IDs.
5. After a task, update its status and check `task_list` plus `message_list`
   before claiming more work. An idle teammate can receive a new task and is
   not necessarily finished.
6. Use `message_send` with `message_kind: task`, `handoff`, or `decision` for
   decisions, blockers, and handoffs; these deliver a follow-up prompt to a
   live teammate. Use `message_kind: fyi` for information and `ack` for a
   short acknowledgement: they are recorded for `message_list` but do not
   interrupt or restart recipients, so never reply to a closing greeting with
   another `message_send`. If the team lead sends a response-required message
   to a worker whose pane stopped unexpectedly, agent-team restores that worker
   first and then delivers the message. A deliberately shutdown worker stays
   queued.
7. Call `team_status` before a critical handoff. Use `team_resume` when you
   need to explicitly revive a stopped worker; it resumes the worker's saved
   Pool session when available and otherwise starts a fresh recovery session.
8. Use `tmux attach -t pool-team-<team-name>` to inspect live teammates. The
   `team` window shows all teammate panes together; `team-status` shows shared
   state. You can select a pane to give its Pool session an additional prompt,
   or press `Esc` there to interrupt its current work.
9. Only the lead can interrupt another teammate through `team_interrupt`; a
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
