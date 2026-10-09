import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { BusyView } from '../types'

const IDLE: BusyView = { isBusy: false, frame: 0, agents: 0, isAwake: false }
const view = atom({ plugin: 'busy-dancer', key: 'view' } as const, IDLE)

// She dances left and right, notes alternating.
export const FRAMES = ['💃 ♪    ', ' 💃 ♫   ', '  💃 ♪  ', '   💃 ♫ ', '  💃 ♪  ', ' 💃 ♫   ']
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
    isBusy ? { isBusy, frame: tick % FRAMES.length, agents, isAwake: caffeinate !== null } : IDLE,
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
    const who = v.agents > 0 ? ` · ${v.agents} subagent${v.agents === 1 ? '' : 's'}` : ''
    const awake = v.isAwake ? ' · ☕ screen kept awake' : ''

    return (
      <Box>
        <Text color="magenta">{FRAMES[v.frame % FRAMES.length]}</Text>
        <Text dimColor>
          {' '}Claude is working{who}{awake}
        </Text>
      </Box>
    )
  })
}
