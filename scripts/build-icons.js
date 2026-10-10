#!/usr/bin/env node
// Generates assets/icon.ico (Windows) and assets/icon.png (512px, for Mac/Linux)
// from assets/logo.svg using @resvg/resvg-js and to-ico.
//
// Usage: node scripts/build-icons.js
const fs = require('fs')
const path = require('path')
const { Resvg } = require('@resvg/resvg-js')
const toIco = require('to-ico')

const root = path.resolve(__dirname, '..')
const svgData = fs.readFileSync(path.join(root, 'assets', 'logo.svg'))

async function main() {
  console.log('Building icons from assets/logo.svg...')

  const icoSizes = [16, 32, 48, 64, 128, 256]
  const pngBuffers = icoSizes.map((size) => {
    const resvg = new Resvg(svgData, { fitTo: { mode: 'width', value: size } })
    return resvg.render().asPng()
  })

  // 512px PNG for macOS / electron-builder
  const resvg512 = new Resvg(svgData, { fitTo: { mode: 'width', value: 512 } })
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), resvg512.render().asPng())
  console.log('  ✓ assets/icon.png (512px)')

  const icoBuffer = await toIco(pngBuffers)
  fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), icoBuffer)
  console.log(`  ✓ assets/icon.ico (${icoSizes.join(', ')}px)`)
}

main().catch((err) => { console.error(err); process.exit(1) })
