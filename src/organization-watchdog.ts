import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const statePath = process.argv[2]
if (!statePath) throw new Error('organization watchdog requires state path')

const execFileAsync = promisify(execFile)
const tmuxCommand = process.env.POOL_AGENT_TEAM_TMUX_COMMAND || 'tmux'

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function cleanUpIfLeaderExited(): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      organization?: { leaderPid?: number }
      teams?: Array<{ tmuxSession?: string }>
    }
    const leaderPid = state.organization?.leaderPid
    if (!leaderPid || isProcessAlive(leaderPid)) return false
    await Promise.all((state.teams ?? [])
      .map(team => team.tmuxSession)
      .filter((session): session is string => Boolean(session))
      .map(session => execFileAsync(tmuxCommand, ['kill-session', '-t', session]).catch(() => undefined)))
    return true
  } catch {
    // A removed state file means the organization has already been cleaned up.
    return true
  }
}

const timer = setInterval(() => {
  void cleanUpIfLeaderExited().then(done => {
    if (done) {
      clearInterval(timer)
      process.exit(0)
    }
  })
}, 2_000)
timer.unref()
