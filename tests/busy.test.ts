import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On, RenderPropsOf } from 'claude-code'

type Spawns = { argv: string[][]; live: number; status: (string | undefined)[] }

// Beneath the plugin, the engine's side: a session, turns, and a fake
// caffeinate that runs until the plugin leaves its loop.
function fakeEngine(on: On, agents: () => AgentInfo[]): Spawns {
  const spawns: Spawns = { argv: [], live: 0, status: [] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: agents() }))
  on('ui.status', (_$, e) => {
    spawns.status.push(e.text)
    return { value: undefined }
  })
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
const BAND_PROPS = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80 } as unknown as RenderPropsOf['AbovePrompt']

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
  expect(await ui.find({ type: 'Text', text: /Claude is working · ☕ screen kept awake/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /💃/ })).toBeDefined()
  await ui.unmount()

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

test('a subagent waiting on its own background work still counts as busy', async ($, on) => {
  const clock = mock.clock(on)
  let agents = [agentRow('a1', 'waiting')]
  const spawns = fakeEngine(on, () => agents)

  await $.session.start(SESSION)
  await clock.advance(1500)
  expect(spawns.live).toBe(1)

  const ui = await $.ui.mount({ plugin: 'busy-dancer', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: /1 subagent/ })).toBeDefined()
  await ui.unmount()

  agents = [agentRow('a1', 'idle')]
  await clock.advance(1500)
  expect(spawns.live).toBe(0)
})

test('with no room for the band, the dancer moves to the status line', async ($, on) => {
  const clock = mock.clock(on)
  let agents = [agentRow('a1', 'running')]
  const spawns = fakeEngine(on, () => agents)

  await $.session.start(SESSION)
  await clock.advance(1500)
  expect(spawns.status.filter(s => s !== undefined)).toEqual([])

  const noRoom = { ...BAND_PROPS, maxRows: 0 } as RenderPropsOf['AbovePrompt']
  const ui = await $.ui.mount({ plugin: 'busy-dancer', surface: 'terminal', component: 'AbovePrompt', props: noRoom })
  await clock.advance(500)
  expect(spawns.status.at(-1)).toMatch(/💃.*Claude is working · 1 subagent/)
  await ui.unmount()

  agents = []
  await clock.advance(1500)
  expect(spawns.status.at(-1)).toBeUndefined()
})

test('a fresh load clears a status line an earlier load of the mod left behind', async ($, on) => {
  // A hot reload mid-turn drops the module's state but not the engine's
  // status line: the new code must clear it, not assume nothing is there.
  const clock = mock.clock(on)
  const spawns = fakeEngine(on, () => [])

  await $.session.start(SESSION)
  await clock.advance(500)
  expect(spawns.status).toContain(undefined)
  expect(spawns.live).toBe(0)
})

test('a subagent turn does not keep the dancer going once the agent is done', async ($, on) => {
  // turn.start fires for subagent turns too (with agentId); only the agent
  // list should speak for them, or a finished subagent dances forever.
  const clock = mock.clock(on)
  let agents = [agentRow('a1', 'running')]
  const spawns = fakeEngine(on, () => agents)

  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 'main' })
  await $.turn.start({ text: 'sub', turnId: 'sub1', agentId: 'a1' })
  await clock.advance(1500)
  expect(spawns.live).toBe(1)

  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 'sub1', agentId: 'a1', reason: 'answer' })
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 'main', reason: 'answer' })
  agents = [agentRow('a1', 'completed')]
  await clock.advance(1500)
  expect(spawns.live).toBe(0)
  expect(spawns.status.at(-1)).toBeUndefined()
})
