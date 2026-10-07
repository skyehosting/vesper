/**
 * Web client icons in src/web/public from build/icons/512x512.png (render that first with scripts/render-icon.cjs):
 * favicon-32.png, apple-touch-icon.png (180), icon-192.png, icon-512.png. favicon.svg is a copy of build/icon.svg.
 * Run with Electron:  npx electron scripts/render-web-icons.cjs
 */
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const src = nativeImage.createFromPath(path.join(root, 'build', 'icons', '512x512.png'))
const out = path.join(root, 'src', 'web', 'public')

app.whenReady().then(() => {
  fs.mkdirSync(out, { recursive: true })
  for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    const img = size === 512 ? src : src.resize({ width: size, height: size, quality: 'best' })
    fs.writeFileSync(path.join(out, name), img.toPNG())
  }
  fs.copyFileSync(path.join(root, 'build', 'icon.svg'), path.join(out, 'favicon.svg'))
  console.log('wrote', fs.readdirSync(out).join(', '))
  app.quit()
})
