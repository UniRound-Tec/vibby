// One-off: renders scripts/.icons.json (see fetch-icons.mjs) plus the icons
// vibby ships today into docs/mockups/toolbar-icons.html, so the four side-rail
// toolbar icons can be compared at their real size before one set is adopted.
import fs from 'fs/promises'

const sets = JSON.parse(await fs.readFile('scripts/.icons.json', 'utf8'))

const current = {
    label: '现状',
    note: '混搭：主页是 Font Awesome 实心，折叠是手写实心，另外两个是 tabby 自带 — 粗细和风格都不统一',
    icons: {
        home: await fs.readFile('tabby-ai/src/icons/home.svg', 'utf8'),
        rail: await fs.readFile('tabby-ai/src/icons/rail.svg', 'utf8'),
        profiles: await fs.readFile('tabby-local/src/icons/plus.svg', 'utf8'),
        settings: await fs.readFile('tabby-settings/src/icons/cog.svg', 'utf8'),
    },
}

const SLOTS = [
    ['home', '主页'],
    ['rail', '折叠侧边栏'],
    ['profiles', '配置和连接'],
    ['settings', '设置'],
]

/**
 * Strip the licence comment and the root's fixed size so CSS controls the box.
 * The size strip has to be anchored to the opening <svg> tag: several families
 * draw with <rect width= height=>, and a global replace erases those too —
 * Lucide's panel-left collapses to a bare vertical line.
 */
const clean = (svg) => svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg\b[^>]*>/, tag => tag.replace(/\s(width|height)="[^"]*"/g, ''))
    .trim()

const strip = (id, slot) => {
    const svg = clean(id === 'current' ? current.icons[slot] : sets[id].icons[slot])
    // stroke families declare fill="none"; tabby's global `svg { fill }` would
    // flood them, so the mockup marks them and the CSS below protects them
    const stroked = /stroke="currentColor"/.test(svg)
    return `<span class="ico${stroked ? ' stroked' : ''}">${svg}</span>`
}

const railFor = (id) => `
      <div class="rail">
        <div class="tabcard"></div>
        <div class="tabcard"></div>
        <div class="divider"></div>
        <div class="num">3</div>
        <div class="num">4</div>
        <div class="spacer"></div>
        <div class="toolbar">
          <button class="tb accent">${strip(id, 'home')}</button>
          <button class="tb">${strip(id, 'rail')}</button>
          <button class="tb">${strip(id, 'profiles')}</button>
          <button class="tb">${strip(id, 'settings')}</button>
        </div>
      </div>`

const cardFor = (id, meta) => `
    <section class="card" id="set-${id}">
      <header>
        <h2>${meta.label}</h2>
        <code>${id}</code>
      </header>
      <p class="note">${meta.note}</p>
      <div class="body">
        ${railFor(id)}
        <div class="detail">
          <div class="row actual">
            ${SLOTS.map(([slot, name]) => `<div class="cell"><span class="at17">${strip(id, slot)}</span><span class="cap">${name}</span></div>`).join('')}
          </div>
          <div class="row blown">
            ${SLOTS.map(([slot]) => `<div class="cell"><span class="at48">${strip(id, slot)}</span></div>`).join('')}
          </div>
        </div>
      </div>
    </section>`

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>vibby · 侧边栏工具栏图标候选</title>
<style>
  :root {
    --accent: #ff4500;
    --bg: #16181c;
    --rail-bg: #1c1f24;
    --fg: #e7e3df;
    --line: rgba(128,128,128,.22);
    --muted: rgba(231,227,223,.55);
  }
  body.light {
    --bg: #efeae0;
    --rail-bg: #fbf9f5;
    --fg: #45373c;
    --line: rgba(0,0,0,.14);
    --muted: rgba(69,55,60,.6);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 32px 60px;
    background: var(--bg); color: var(--fg);
    font: 14px/1.6 "Source Sans Pro", -apple-system, "Segoe UI", sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h1::before {
    content: ''; display: inline-block; width: 4px; height: 17px;
    border-radius: 2px; background: var(--accent);
    margin-right: 10px; transform: translateY(2px);
  }
  .lede { color: var(--muted); margin: 0 0 22px; max-width: 70ch; }
  .lede b { color: var(--fg); font-weight: 600; }
  button.toggle {
    position: fixed; top: 20px; right: 28px; z-index: 5;
    background: var(--rail-bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 9px;
    padding: 7px 14px; cursor: pointer; font: inherit;
  }
  .card {
    border: 1px solid var(--line); border-radius: 14px;
    background: var(--rail-bg); padding: 18px 20px; margin-bottom: 16px;
  }
  .card header { display: flex; align-items: baseline; gap: 10px; }
  .card h2 { font-size: 16px; margin: 0; }
  .card code { color: var(--muted); font-size: 12px; }
  .note { color: var(--muted); margin: 2px 0 16px; font-size: 13px; }
  .body { display: flex; gap: 34px; align-items: flex-start; }

  /* the rail, at the real collapsed width */
  .rail {
    flex: none; width: 58px; height: 300px;
    background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
    display: flex; flex-direction: column; align-items: center;
    padding: 8px 0; gap: 4px;
  }
  .tabcard {
    width: 42px; height: 38px; border-radius: 8px;
    background: rgba(128,128,128,.10); border: 1px solid var(--line);
  }
  .divider { width: 32px; height: 1px; background: var(--line); margin: 11px 0 7px; }
  .num { height: 30px; line-height: 30px; font-weight: 700; font-size: 11px; opacity: .72; }
  .spacer { flex: 1; }
  .toolbar {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    border-top: 1px solid var(--line); padding-top: 8px; width: 40px;
  }
  .tb {
    width: 40px; height: 36px; border: 0; border-radius: 9px;
    background: transparent; color: var(--fg); opacity: .9;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .tb:hover { background: rgba(128,128,128,.16); }
  .tb.accent { color: var(--accent); background: color-mix(in srgb, var(--accent) 13%, transparent); opacity: 1; }

  /* icon boxes — 17px is what the app renders today */
  .ico { display: inline-flex; }
  .ico svg { width: 17px; height: 17px; display: block; fill: currentColor; }
  .ico.stroked svg { fill: none; stroke: currentColor; }
  .at48 .ico svg { width: 48px; height: 48px; }

  .detail { display: flex; flex-direction: column; gap: 18px; padding-top: 6px; }
  .row { display: flex; gap: 26px; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 7px; }
  .cap { font-size: 11px; color: var(--muted); }
  .row.blown .cell { opacity: .92; }
</style>
</head>
<body>
<button class="toggle" onclick="document.body.classList.toggle('light')">明 / 暗</button>
<!-- #light opens straight in the light theme, so a screenshot can capture it -->
<script>if (location.hash === '#light') { document.body.classList.add('light') }</script>

<h1>侧边栏工具栏图标候选</h1>
<p class="lede">
  四个槽位：<b>主页 / 折叠侧边栏 / 配置和连接 / 设置</b>。每组左边是真实尺寸的收缩态侧边栏（58px 宽、图标 17px），
  右边一行是实际大小、一行放大到 48px 看细节。右上角可切明暗底。
  选定一组告诉我编号，我把 SVG 落到仓库里再截图验证。
</p>

${cardFor('current', current)}
${Object.entries(sets).map(([id, meta]) => cardFor(id, meta)).join('\n')}

</body>
</html>
`

await fs.writeFile('docs/mockups/toolbar-icons.html', html)
console.log('wrote docs/mockups/toolbar-icons.html')
