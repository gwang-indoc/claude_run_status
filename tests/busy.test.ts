import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On, RenderPropsOf } from 'claude-code'

type Spawns = { argv: string[][]; live: number }

// Beneath the plugin, the engine's side: a session, turns, and a fake
// caffeinate that runs until the plugin leaves its loop.
function fakeEngine(on: On, agents: () => AgentInfo[]): Spawns {
  const spawns: Spawns = { argv: [], live: 0 }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: agents() }))
  on('process.spawn', async function* (_$, e, next) {
    spawns.argv.push([...e.argv])
    spawns.live += 1
    try {
      await new Promise<void>(resolve => {
        if (next.signal.aborted) resolve()
        else next.signal.addEventListener('abort', () => resolve())
      })
    } finally {
      spawns.live -= 1
    }
    return { value: { code: null, signal: 'SIGTERM' } }
  })
  return spawns
}

function agentRow(id: string, status: AgentInfo['status']): AgentInfo {
  return { id, description: 'work', type: 'general-purpose', status } as AgentInfo
}

const SESSION = { cwd: '/tmp', surface: 'terminal' as const, isInteractive: true }
const BAND_PROPS = { hasSurvey: false, isWorking: true, maxRows: 2, bodyColumns: 80 } as unknown as RenderPropsOf['AbovePrompt']

test('a main turn dances and keeps the screen awake until it completes', async ($, on) => {
  const clock = mock.clock(on)
  const spawns = fakeEngine(on, () => [])

  await $.session.start(SESSION)
  await clock.advance(1000)
  expect(spawns.argv.length).toBe(0)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(500)
  expect(spawns.argv).toEqual([['caffeinate', '-d', '-i']])
  expect(spawns.live).toBe(1)

  const ui = await $.ui.mount({ plugin: 'busy-dancer', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: /CLAUDE IS WORKING/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /☕ screen kept awake/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /O/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /💃/ })).toBeUndefined()
  await ui.unmount()

  // Only one row free: the one-row bar instead.
  const small = await $.ui.mount({
    plugin: 'busy-dancer',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND_PROPS, maxRows: 1 },
  })
  expect(await small.find({ type: 'Text', text: /💃/ })).toBeDefined()
  expect(await small.find({ type: 'Text', text: /CLAUDE IS WORKING · ☕ screen kept awake/ })).toBeDefined()
  await small.unmount()

  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(500)
  expect(spawns.live).toBe(0)
})

test('a running subagent keeps it going after the main turn ends', async ($, on) => {
  const clock = mock.clock(on)
  let agents = [agentRow('a1', 'running')]
  const spawns = fakeEngine(on, () => agents)

  await $.session.start(SESSION)
  await clock.advance(1500)
  expect(spawns.live).toBe(1)

  const ui = await $.ui.mount({ plugin: 'busy-dancer', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: /1 subagent/ })).toBeDefined()
  await ui.unmount()

  agents = [agentRow('a1', 'completed')]
  await clock.advance(1500)
  expect(spawns.live).toBe(0)
  expect(spawns.argv.length).toBe(1)
})
