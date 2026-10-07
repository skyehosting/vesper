/**
 * Render build/icon.svg to PNGs (16..1024) and pack build/icon.ico (PNG-compressed entries).
 * Run with Electron (it provides a Chromium renderer):  npx electron scripts/render-icon.cjs
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const svgPath = path.join(root, 'build', 'icon.svg')
const outDir = path.join(root, 'build', 'icons')
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512]
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

function packIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true })
  const svg = fs.readFileSync(svgPath, 'utf8')
  const pngs = []
  const tmpHtml = path.join(app.getPath('temp'), 'vesper-icon-render.html')
  fs.writeFileSync(tmpHtml, `<html><head><style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}svg{display:block;width:100vw;height:100vh}</style></head><body>${svg}</body></html>`)
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true, zoomFactor: 1 } })
  await win.loadFile(tmpHtml)
  await new Promise((r) => setTimeout(r, 400))
  const captured = await win.webContents.capturePage()
  console.log('captured', captured.getSize())
  const side = Math.min(captured.getSize().width, captured.getSize().height)
  const master = captured.crop({ x: 0, y: 0, width: side, height: side })
  win.destroy()
  for (const size of SIZES) {
    const png = (size === side ? master : master.resize({ width: size, height: size, quality: 'best' })).toPNG()
    fs.writeFileSync(path.join(outDir, `${size}x${size}.png`), png)
    if (ICO_SIZES.includes(size)) pngs.push({ size, data: png })
  }
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), packIco(pngs))
  fs.copyFileSync(path.join(outDir, '512x512.png'), path.join(root, 'build', 'icon.png'))
  console.log(`icon written: ${pngs.length} ico entries, pngs in ${outDir}`)
  app.quit()
})
