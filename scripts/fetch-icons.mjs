// One-off: pull candidate toolbar icon sets from unpkg into a JSON blob that
// docs/mockups/toolbar-icons.html is generated from. Not part of any build.
import fs from 'fs/promises'

const SETS = {
    lucide: {
        label: 'Lucide',
        note: '线性 2px · ISC · Feather 的继任者，最主流的一套',
        base: 'lucide-static@0.545.0/icons/',
        icons: { home: 'house.svg', rail: 'panel-left.svg', profiles: 'plus.svg', settings: 'settings.svg' },
    },
    'phosphor-regular': {
        label: 'Phosphor Regular',
        note: '线性 · MIT · 圆头线条，笔画比 Lucide 细一点',
        base: '@phosphor-icons/core@2.1.1/assets/regular/',
        icons: { home: 'house.svg', rail: 'sidebar-simple.svg', profiles: 'plus.svg', settings: 'gear-six.svg' },
    },
    'phosphor-fill': {
        label: 'Phosphor Fill',
        note: '实心 · MIT · 和上面同一套，实心版',
        base: '@phosphor-icons/core@2.1.1/assets/fill/',
        icons: { home: 'house-fill.svg', rail: 'sidebar-simple-fill.svg', profiles: 'plus-fill.svg', settings: 'gear-six-fill.svg' },
    },
    tabler: {
        label: 'Tabler',
        note: '线性 2px · MIT · 网格严格，偏工程感',
        base: '@tabler/icons@3.35.0/icons/outline/',
        icons: { home: 'home.svg', rail: 'layout-sidebar.svg', profiles: 'plus.svg', settings: 'settings.svg' },
    },
    'heroicons-solid': {
        label: 'Heroicons Solid',
        note: '实心 · MIT · Tailwind 出品，块面大、辨识度高',
        base: 'heroicons@2.2.0/24/solid/',
        icons: { home: 'home.svg', rail: 'view-columns.svg', profiles: 'plus.svg', settings: 'cog-6-tooth.svg' },
    },
    'material-rounded': {
        label: 'Material Symbols Rounded',
        note: '实心圆角 · Apache 2.0 · Google 出品，最“系统感”',
        base: '@material-symbols/svg-400@0.36.0/rounded/',
        icons: { home: 'home-fill.svg', rail: 'left_panel_close-fill.svg', profiles: 'add-fill.svg', settings: 'settings-fill.svg' },
    },
}

const out = {}
for (const [id, set] of Object.entries(SETS)) {
    out[id] = { label: set.label, note: set.note, icons: {} }
    for (const [slot, file] of Object.entries(set.icons)) {
        const url = `https://unpkg.com/${set.base}${file}`
        const res = await fetch(url)
        if (!res.ok) {
            console.error(`MISS ${res.status} ${url}`)
            continue
        }
        out[id].icons[slot] = (await res.text()).trim()
        console.log(`ok   ${id}/${slot}`)
    }
}
await fs.writeFile('scripts/.icons.json', JSON.stringify(out, null, 1))
console.log('wrote scripts/.icons.json')
