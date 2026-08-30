import {exportTheme, loadUIData, nstructjs, saveUIData} from '../../path.ux/scripts/pathux'
import {UIBase} from '../../path.ux/scripts/core/ui_base'
import {Container} from '../../path.ux/scripts/core/ui'
import {Editor} from '../editor_base'
import {Icons} from '../icon_enum.js'
import addonManager from '../../addon/addon.js'
import {pickAndInstallAddon} from '../../addon/install_ui'
import {FeatureFlags, featureFlagApiName} from '../../core/feature-flag'
import type {ViewContext} from '../../core/context'

export class SettingsEditor extends Editor {
  body!: Container<ViewContext>

  static STRUCT = nstructjs.inlineRegister(
    this,
    `
SettingsEditor {
}
  `
  )

  init(): void {
    super.init()
    this.background = this.getDefault('DefaultPanelBG')

    this.body = this.container.col()

    this.rebuild()
  }

  rebuild(): void {
    const container = this.body

    const uidata = saveUIData(container, 'settings')

    container.clear()

    this.style['overflow'] = 'scroll'

    // The general/addons/feature-flag settings now live in the PropsEditor
    // Settings tab (ImmediateTODOs #4); only theme editing stays here.
    SettingsEditor.buildThemePanel(container as unknown as Container<ViewContext>)

    loadUIData(container, uidata)

    this.flushUpdate()
  }

  /** Theme editing UI (export + the live theme-editor element). */
  static buildThemePanel(tab: Container<ViewContext>): void {
    tab.button('Export Theme', () => {
      let theme = exportTheme()

      theme = theme.replace(/var theme/, 'export const theme')

      theme = 'import {CSSFont, setTheme} from "../path.ux/scripts/core/ui_base.js";\n\n' + theme
      theme =
        `
/*
 * WARNING: AUTO-GENERATED FILE
 *
 * Copy to scripts/editors/theme.js
 */
      `.trim() +
        '\n\n' +
        theme
      theme += '\nsetTheme(theme);\n\n'

      const blob = new Blob([theme], {type: 'application/javascript'})
      const url = URL.createObjectURL(blob)

      window.open(url)
    })

    tab.add(UIBase.createElement('theme-editor-x'))
  }

  /** General (undo + autosave) settings. Reusable by the PropsEditor Settings tab. */
  static buildGeneralSettings(tab: Container<ViewContext>): void {
    tab.useIcons(false)
    tab.prop('settings.limitUndoMem')
    tab.prop('settings.undoMemLimit')

    tab.label('Autosave')
    tab.prop('settings.autosaveEnabled')
    tab.prop('settings.autosaveIntervalMinutes')
    tab.prop('settings.autosaveMaxBackups')
    tab.prop('settings.autosaveToProjectDir')
  }

  /** Addon enable/install/uninstall list. `rebuild` re-runs after install/uninstall. */
  static buildAddonsSettings(tab: Container<ViewContext>, rebuild: () => void): void {
    if (addonManager.storage) {
      tab.button('Install Addon…', () => {
        pickAndInstallAddon()
          .then((result) => {
            if (result) {
              // eslint-disable-next-line no-console
              console.log(`installed addon "${result.manifest.id}"`)
              rebuild()
            }
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('addon install failed:', err)
            window.alert?.(`Addon install failed: ${err.message}`)
          })
      })
    }

    for (const addon of addonManager.addons) {
      const k = addon.manifest?.id ?? addon.key
      const path = `settings.addons['${k}']`

      const row = tab.row()

      row.useIcons(false)
      row.prop(path + '.enabled')
      row.label(addon.name)

      const manifest = addon.manifest
      if (manifest && !addon.builtin) {
        row.button('Uninstall', () => {
          if (!window.confirm?.(`Uninstall "${manifest.name}"?`)) return
          addonManager
            .uninstall(manifest.id)
            .then(() => rebuild())
            // eslint-disable-next-line no-console
            .catch((err) => console.error('uninstall failed:', err))
        })
      }
    }

    // An addon that did not load has no `settings.addons[id]` to bind, so it
    // would otherwise just be missing from this list with no explanation.
    if (addonManager.unloaded.size > 0) {
      tab.label('Not loaded')
      for (const entry of addonManager.unloaded.values()) {
        const row = tab.row()
        row.useIcons(false)
        row.label(entry.name ?? entry.id)
        row.label(entry.message)
      }
    }
  }

  /** Feature-flag toggles. */
  static buildFeatureFlagsSettings(tab: Container<ViewContext>): void {
    tab.useIcons(false)
    for (const flag of FeatureFlags.definitions) {
      tab.prop(`settings.featureFlags.${featureFlagApiName(flag.key)}`)
    }
  }

  static define() {
    return {
      uiname  : 'Theme Editor',
      areaname: 'settings-editor',
      tagname : 'settings-editor-x',
      icon    : Icons.EDITOR_SETTINGS,
    }
  }
}

Editor.register(SettingsEditor)
