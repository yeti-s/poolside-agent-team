import { readFile } from 'node:fs/promises'

const statePath = process.argv[2]
if (!statePath) throw new Error('organization watchdog requires state path')

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopIfLeaderExited(): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      organization?: { leaderPid?: number }
    }
    const leaderPid = state.organization?.leaderPid
    if (!leaderPid || isProcessAlive(leaderPid)) return false
    // Lifecycle belongs exclusively to the main Pool CLI. A departed main
    // process makes this watchdog stop observing; it must never kill tmux or
    // remove state on its own.
    return true
  } catch {
    // A removed state file means the organization has already been cleaned up.
    return true
  }
}

const timer = setInterval(() => {
  void stopIfLeaderExited().then(done => {
    if (done) {
      clearInterval(timer)
      process.exit(0)
    }
  })
}, 2_000)
timer.unref()
