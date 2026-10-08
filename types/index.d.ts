export type BusyView = {
  isBusy: boolean
  frame: number
  agents: number
  isAwake: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'busy-dancer': { view: BusyView }
  }
}
