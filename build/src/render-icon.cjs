// 앱 아이콘 렌더: build/src/icon.svg → build/icon.png(1024) · build/icon.icns   실행: npx electron build/src/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path'), fs = require('node:fs'), { execFileSync } = require('node:child_process');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 800));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = path.join(__dirname, '..');
  fs.writeFileSync(path.join(out, 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  const set = path.join(out, 'icon.iconset'); fs.rmSync(set, { recursive: true, force: true }); fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) for (const k of [1, 2]) fs.writeFileSync(path.join(set, `icon_${s}x${s}${k === 2 ? '@2x' : ''}.png`), img.resize({ width: s * k, height: s * k, quality: 'best' }).toPNG());
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(out, 'icon.icns')]); fs.rmSync(set, { recursive: true });
  console.log('icon ok'); app.exit(0);
});
