import {expect, test} from '@playwright/test'

/**
 * Boots the real app, opens the Settings editor via `CTX.debug.showEditor`,
 * and asserts the editor builds its tabs: the Feature Flags tab binds each
 * flag through `settings.featureFlags.*` and the Addons tab binds each addon
 * row through `settings.addons[...]`. Toggling a flag path round-trips
 * through the FeatureFlagManager singleton.
 */

test('settings editor opens and binds feature flags', async ({page}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await page.goto('/?renderer=webgpu')

  await page.waitForFunction(() => !!(window as any)._appstate?.screen, undefined, {timeout: 60_000})

  // showEditor needs a laid-out screen.
  await page.setViewportSize({width: 1280, height: 800})

  const opened = await page.evaluate(() => {
    const w = window as any
    const result = w.CTX.debug.showEditor({editorType: 'settings-editor', minVisibleWidth: 500})
    w.__settingsEd = result.editor
    return {action: result.action, tag: result.editor?.tagName?.toLowerCase()}
  })
  expect(opened.tag).toBe('settings-editor-x')

  // Editor init is deferred to the screen's update tick — wait until the tab
  // container exists, then activate each tab (only the active tab's page is
  // attached to the DOM). path.ux widgets nest shadow roots, so walk them.
  await page.waitForFunction(() => !!((window as any).__settingsEd as any)?.tabs, undefined, {timeout: 30_000})

  const collectTabBindings = (tabName: string) =>
    page.evaluate(async (name) => {
      const ed = (window as any).__settingsEd as any
      // getTab matches container.name, which tab() never sets — find the page
      // through its TabItem label instead.
      let target
      for (const k in ed.tabs.tabs) {
        if (ed.tabs.tabs[k]._tab?.name === name) target = ed.tabs.tabs[k]
      }
      if (!target) throw new Error(`tab not found: ${name}`)
      ed.tabs.setActive(target)
      // let the tab swap + widget updates flush
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => requestAnimationFrame(r))
      }
      const paths: string[] = []
      const walk = (root: Element | ShadowRoot) => {
        for (const el of root.querySelectorAll('*')) {
          const dp = el.getAttribute?.('datapath')
          if (dp) paths.push(dp)
          if (el.shadowRoot) walk(el.shadowRoot)
        }
      }
      walk(ed.shadowRoot ?? ed)
      return paths
    }, tabName)

  const flagBindings = await collectTabBindings('Feature Flags')
  const addonBindings = await collectTabBindings('Addons')
  const bindings = [...flagBindings, ...addonBindings]

  expect(bindings).toContain('settings.featureFlags.sculptcore_quad_remesher')
  expect(bindings.some((p) => p.startsWith('settings.addons['))).toBe(true)

  // The bound path round-trips through the FeatureFlagManager singleton.
  const roundtrip = await page.evaluate(() => {
    const w = window as any
    const path = 'settings.featureFlags.sculptcore_quad_remesher'
    const initial = w.CTX.api.getValue(w.CTX, path)
    w.CTX.api.setValue(w.CTX, path, !initial)
    const flipped = w.FeatureFlags.get('sculptcore.quad_remesher')
    w.FeatureFlags.reset('sculptcore.quad_remesher')
    const restored = w.CTX.api.getValue(w.CTX, path)
    return {initial, flipped, restored}
  })

  expect(roundtrip.flipped).toBe(!roundtrip.initial)
  expect(roundtrip.restored).toBe(true)

  expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([])
})
