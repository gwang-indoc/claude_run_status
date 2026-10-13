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
// `waiting` is a subagent held on background work it owns (a backgrounded
// shell, its own subagents): still working, just not mid-turn.
const BUSY_AGENT = new Set(['pending', 'running', 'waiting'])

type Child = AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>

// Module state; a reload starts it over (and kills the old caffeinate).
// Main-loop turns in flight, by turnId. Subagent runs raise no turn.start.
const mainTurns = new Set<string>()
let agents = 0
let tick = 0
// Rows the band last had. A short terminal with a tall status line leaves it
// none, and the engine then draws nothing: the dancer moves to the status line.
let bandRows = 1
let statusText: string | undefined
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

function label(v: BusyView) {
  const who = v.agents > 0 ? ` · ${v.agents} subagent${v.agents === 1 ? '' : 's'}` : ''
  const awake = v.isAwake ? ' · ☕ screen kept awake' : ''
  return `Claude is working${who}${awake}`
}

function setStatus($: EngineInterface, text: string | undefined) {
  if (text === statusText) return
  statusText = text
  $.ui.status(text)
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
  if (!isBusy && !current.isBusy) return setStatus($, undefined)
  const next = isBusy ? { isBusy, frame: tick % FRAMES.length, agents, isAwake: caffeinate !== null } : IDLE
  await update($, view, () => next)
  setStatus($, isBusy && bandRows < 1 ? `${FRAMES[next.frame]} ${label(next)}` : undefined)
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
    setStatus($, undefined)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    bandRows = e.props.maxRows
    const v = await read($, view)
    if (e.props.hasSurvey || !v.isBusy) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color="magenta">{FRAMES[v.frame % FRAMES.length]}</Text>
        <Text dimColor>
          {' '}{label(v)}
        </Text>
      </Box>
    )
  })
}
