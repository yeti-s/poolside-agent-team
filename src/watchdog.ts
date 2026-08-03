import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { LEADER_HEARTBEAT_TIMEOUT_MS } from './store.js'

const execFileAsync = promisify(execFile)
const [statePath, session] = process.argv.slice(2)
if (!statePath || !session) throw new Error('watchdog requires state path and tmux session')
const tmuxCommand = process.env.POOL_AGENT_TEAM_TMUX_COMMAND || 'tmux'

async function sessionExists(): Promise<boolean> {
  try {
    await execFileAsync(tmuxCommand, ['has-session', '-t', session])
    return true
  } catch {
    return false
  }
}

const timer = setInterval(async () => {
  if (!(await sessionExists())) {
    clearInterval(timer)
    return
  }
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      team?: { heartbeatAt?: string }
    }
    const heartbeatAt = Date.parse(state.team?.heartbeatAt ?? '')
    if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > LEADER_HEARTBEAT_TIMEOUT_MS) {
      // A stalled or exited leader is recoverable. Only the main Pool CLI may
      // terminate a team, so preserve the tmux session and shared state.
      clearInterval(timer)
    }
  } catch {
    // Missing or unreadable state must never turn into an implicit team delete.
    clearInterval(timer)
  }
}, 1_000)
