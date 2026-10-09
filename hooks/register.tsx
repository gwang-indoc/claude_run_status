import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { BusyView } from '../types'

const IDLE: BusyView = { isBusy: false, frame: 0, agents: 0, isAwake: false }
const view = atom({ plugin: 'busy-dancer', key: 'view' } as const, IDLE)

// She dances left and right, notes alternating: the one-row fallback.
export const FRAMES = ['💃 ♪    ', ' 💃 ♫   ', '  💃 ♪  ', '   💃 ♫ ', '  💃 ♪  ', ' 💃 ♫   ']

// The big dancer, seen across the room: arms up, sway left, arms up, sway right.
// ASCII only, so every row is the same width in any terminal or locale.
const ARMS_UP = [' \\  O  / ', '  \\_|_/  ', '    |    ', '   /~\\   ', '  /~~~\\  ', '   | |   ', '  _| |_  '] as const
const SWAY_LEFT = [' \\  O    ', '  \\_|\\   ', '    | \\  ', '   /~\\   ', '  /~~~\\  ', '   |  \\  ', '  _|   \\_']
const SWAY_RIGHT = ['    O  / ', '   /|_/  ', '  / |    ', '   /~\\   ', '  /~~~\\  ', '  /  |   ', '_/   |_  ']
export const POSES = [ARMS_UP, SWAY_LEFT, ARMS_UP, SWAY_RIGHT]
const POSE_WIDTH = ARMS_UP[0].length
// Ticks each pose is held (two poses a second).
const POSE_TICKS = 2
// The text column beside her, and the border plus padding around the band.
const INFO_WIDTH = 24
const CHROME_COLUMNS = 4
const CHROME_ROWS = 2
// The big band needs this many rows; below it the one-row dancer shows.
export const BIG_ROWS = ARMS_UP.length + CHROME_ROWS

export const CAFFEINATE = ['caffeinate', '-d', '-i'] as const

const TICK_MS = 250
// agent.list is polled every Nth tick (once a second).
const AGENT_POLL_EVERY = 4
const BUSY_AGENT = new Set(['pending', 'running'])

type Child = AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>

// Module state; a reload starts it over (and kills the old caffeinate).
// Main-loop turns in flight, by turnId. Subagent runs raise no turn.start.
const mainTurns = new Set<string>()
let agents = 0
let tick = 0
let caffeinate: Child | null = null
let stopTimer: (() => void) | null = null

async function drain($: EngineInterface, child: Child) {
  // The loop is the child's life: drain it until it exits or we return() it.
  try {
    for await (const _ of child) {
      // caffeinate writes nothing
    }
  } catch (err) {
    $.ui.log(`busy-dancer: caffeinate failed: ${String(err)}`, { to: 'debug' })
  } finally {
    if (caffeinate === child) caffeinate = null
  }
}

function startCaffeinate($: EngineInterface) {
  const child: Child = $.process.spawn({ argv: CAFFEINATE })
  caffeinate = child
  void drain($, child)
}

function stopCaffeinate() {
  const child = caffeinate
  caffeinate = null
  void child?.return(undefined as never)
}

async function onTick($: EngineInterface) {
  tick += 1
  if (tick % AGENT_POLL_EVERY === 0) {
    try {
      agents = (await $.agent.list()).filter(a => BUSY_AGENT.has(a.status)).length
    } catch {
      // keep the last count
    }
  }

  const isBusy = mainTurns.size > 0 || agents > 0
  if (isBusy && caffeinate === null) startCaffeinate($)
  if (!isBusy && caffeinate !== null) stopCaffeinate()

  const current = await read($, view)
  if (!isBusy && !current.isBusy) return
  await update($, view, () =>
    isBusy ? { isBusy, frame: tick, agents, isAwake: caffeinate !== null } : IDLE,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    stopTimer?.()
    const timer = $.clock.every(TICK_MS, () => void onTick($))
    stopTimer = () => timer.cancel()
    return started
  })

  on('turn.start', ($, e, next) => {
    mainTurns.add(e.turnId)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) mainTurns.delete(e.turnId)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    mainTurns.clear()
    agents = 0
    stopCaffeinate()
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey || !v.isBusy) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const subagents = v.agents > 0 ? `${v.agents} subagent${v.agents === 1 ? '' : 's'}` : ''
    const lane = e.props.bodyColumns - CHROME_COLUMNS - INFO_WIDTH

    if (e.props.maxRows < BIG_ROWS || lane < POSE_WIDTH) {
      const who = subagents ? ` · ${subagents}` : ''
      const awake = v.isAwake ? ' · ☕ screen kept awake' : ''
      return (
        <Box>
          <Text color="magenta">{FRAMES[v.frame % FRAMES.length]}</Text>
          <Text dimColor>
            {' '}Claude is working{who}{awake}
          </Text>
        </Box>
      )
    }

    // She travels the lane and back, one column a tick.
    const span = lane - POSE_WIDTH
    const step = span === 0 ? 0 : v.frame % (2 * span)
    const offset = step <= span ? step : 2 * span - step
    const pose = POSES[Math.floor(v.frame / POSE_TICKS) % POSES.length] ?? ARMS_UP
    const note = Math.floor(v.frame / POSE_TICKS) % 2 === 0 ? '♪' : '♫'

    return (
      <Box borderStyle="round" borderColor="magenta" paddingX={1}>
        <Box flexDirection="column" width={INFO_WIDTH} justifyContent="center">
          <Text bold color="white" backgroundColor="magenta">
            {` ${note} CLAUDE IS WORKING `}
          </Text>
          {subagents ? <Text color="magenta">🤖 {subagents}</Text> : null}
          {v.isAwake ? <Text dimColor>☕ screen kept awake</Text> : null}
        </Box>
        <Box flexDirection="column" marginLeft={offset}>
          {pose.map((row, i) => (
            <Text key={String(i)} bold color="magenta">
              {row}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
