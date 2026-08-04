---
name: agent-team
description: Coordinate a Pool CLI team for independent research, implementation, or testing work.
---

# Pool agent team

Use this only when work has independent parts that benefit from parallel Pool
workers. All teammates share one workspace, so avoid overlapping file edits.

## Team workflow

1. The lead calls `team_create` once (`leader_name: "team-lead"`; default
   `max_members` is 4 including the lead), then creates narrow tasks.
2. Set `owner` when creating or updating a task. This immediately prompts a
   live teammate. Use `depends_on` for prerequisites; `blocks` is legacy and
   has the inverse meaning.
3. Start independent workers with `team_spawn`, then use `task_update` and
   `message_send` for assignments, decisions, and blockers. `fyi` and `ack`
   messages do not interrupt a worker.
4. Workers record material results or blockers with
   `task_update.progress_note`, complete their task, report to the lead, and
   remain available. `team_status` distinguishes a live pane from assigned
   work and lists unassigned tasks.
5. The lead watchdog checks unchanged in-progress work every 5 minutes by
   default. After two unchanged checks it interrupts the turn and requires
   2–4 smaller, verifiable steps. Configure this only when needed with
   `progress_check_interval_minutes` and `stalled_check_limit`.
6. Use `team_resume` for a stopped worker, `team_interrupt` only as the lead,
   `team_request_shutdown` for cooperative exit, and `team_delete` to stop a
   team. After restarting the lead CLI, call `team_adopt` before coordination.

## Organization workflow

Use an organization only for multiple independent teams. Call
`organization_plan`, show the complete plan and exact approval phrase to the
user, then call `organization_approve` only after a later verbatim approval.
Team members communicate only within their team; team leads use
`organization_message_send` for cross-team coordination.

## Safety

Only the lead creates/removes teams and spawns workers. Workers run with
`pool --mode always-allow`; use only in trusted projects and never request
credentials or out-of-scope system changes.
