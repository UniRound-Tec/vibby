#!/usr/bin/env node
// Regenerates every app icon from the Vibby logo glyphs in app/assets/.
// Outputs are committed; rerun after swapping the source artwork:
//   node scripts/build-icons.mjs
import * as fs from 'fs'
import * as path from 'path'
import * as url from 'url'
import sharp from 'sharp'
import png2icons from 'png2icons'

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))

const WHITE_GLYPH = path.join(root, 'app/assets/vibby-logo-white.png')
const BLACK_GLYPH = path.join(root, 'app/assets/vibby-logo-black.png')

// Tile aesthetics — tune here and rerun
const TILE_COLOR = '#15181d'
const TILE_RADIUS_FRACTION = 0.22
const GLYPH_FRACTION = 0.70
// macOS HIG: the tile floats inside the canvas with a transparent margin
const MACOS_TILE_FRACTION = 0.82

const SIZE = 1024

async function makeTile (canvas, tileFraction) {
    const tile = Math.round(canvas * tileFraction)
    const radius = Math.round(tile * TILE_RADIUS_FRACTION)
    const glyphSize = Math.round(tile * GLYPH_FRACTION)
    const background = Buffer.from(
        `<svg width="${canvas}" height="${canvas}">` +
        `<rect x="${(canvas - tile) / 2}" y="${(canvas - tile) / 2}" width="${tile}" height="${tile}" rx="${radius}" fill="${TILE_COLOR}"/>` +
        '</svg>',
    )
    const glyph = await sharp(WHITE_GLYPH).resize(glyphSize, glyphSize, { fit: 'contain' }).png().toBuffer()
    return sharp(background)
        .composite([{ input: glyph, gravity: 'center' }])
        .png()
        .toBuffer()
}

async function writeResized (buffer, size, file) {
    await sharp(buffer).resize(size, size).png().toFile(path.join(root, file))
    console.log(`  ${file} (${size}px)`)
}

const master = await makeTile(SIZE, 1)
const macMaster = await makeTile(SIZE, MACOS_TILE_FRACTION)

console.log('build/icons:')
for (const size of [16, 32, 64, 128, 256, 512]) {
    await writeResized(master, size, `build/icons/${size}x${size}.png`)
}
await writeResized(macMaster, 1024, 'build/icons/Icon-MacOS-512x512@2x.png')

// The scalable Linux icon: the tile with the glyph embedded as base64
{
    const tile = SIZE
    const radius = Math.round(tile * TILE_RADIUS_FRACTION)
    const glyphSize = Math.round(tile * GLYPH_FRACTION)
    const inset = Math.round((tile - glyphSize) / 2)
    const glyphB64 = fs.readFileSync(WHITE_GLYPH).toString('base64')
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${tile}" viewBox="0 0 ${tile} ${tile}">\n` +
        `  <rect width="${tile}" height="${tile}" rx="${radius}" fill="${TILE_COLOR}"/>\n` +
        `  <image x="${inset}" y="${inset}" width="${glyphSize}" height="${glyphSize}" href="data:image/png;base64,${glyphB64}"/>\n` +
        '</svg>\n'
    fs.writeFileSync(path.join(root, 'build/icons/icon.svg'), svg)
    console.log('  build/icons/icon.svg')
}

console.log('platform icons:')
fs.writeFileSync(path.join(root, 'build/windows/icon.ico'), png2icons.createICO(master, png2icons.BICUBIC, 0, false))
console.log('  build/windows/icon.ico')
fs.writeFileSync(path.join(root, 'build/mac/icon.icns'), png2icons.createICNS(macMaster, png2icons.BICUBIC, 0))
console.log('  build/mac/icon.icns')

console.log('tray icons:')
await writeResized(master, 32, 'app/assets/tray.png')
// macOS template images: black + alpha only, no background tile
const blackGlyph = fs.readFileSync(BLACK_GLYPH)
await writeResized(blackGlyph, 16, 'app/assets/tray-darwinTemplate.png')
await writeResized(blackGlyph, 32, 'app/assets/tray-darwinTemplate@2x.png')
await writeResized(blackGlyph, 16, 'app/assets/tray-darwinHighlightTemplate.png')
await writeResized(blackGlyph, 32, 'app/assets/tray-darwinHighlightTemplate@2x.png')

console.log('done')
