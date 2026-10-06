// 화면 확인용 스크린샷 (Electron, 창 숨김): 서버를 띄워 단계별로 시뮬레이션을 앞당긴 뒤 카메라 자리별로 PNG 저장
// 실행: npx electron tools/shot.cjs <출력폴더> [mode=dark] [초=600] [view=all|zone|cells|mill|cmm|source]
const { app, BrowserWindow } = require('electron');
const path = require('node:path'), fs = require('node:fs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const [out = '/tmp/shots', mode = 'dark', secs = '600', which = 'all'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
setTimeout(() => { console.log('TIMEOUT'); app.exit(1); }, 240000);
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const w = new BrowserWindow({ width: 1600, height: 950, show: false, webPreferences: { backgroundThrottling: false } });
  const errs = []; w.webContents.on('console-message', (e) => { if (e.level === 'error') errs.push(String(e.message).slice(0, 300)); });
  const { startServer } = await import(path.join(__dirname, '..', 'server', 'app-server.mjs'));
  const { port } = await startServer({ port: 0 });
  await w.loadURL(`http://127.0.0.1:${port}`); await wait(4500);
  const js = (c) => w.webContents.executeJavaScript(c);
  await js(`document.querySelector('[data-mode=${mode}]')?.click()`); await wait(3000);
  await js(`(()=>{ const t=window.__twin, s=t.sim; for(let k=0;k<${+secs}*10;k++){ s.step(0.1); t.agent?.update(0.1); } })()`); await wait(1500);
  const views = {
    zone: [[0, 34, 30], [0, 0, 0]], cells: [[-5, 9, 12], [1, 0, 0]], mill: [[-7.5, 4.2, 8.8], [-5, 1, 3]], millrc: [[-7.5, 4.2, -9.5], [-5, 1, -3]],
    deburr: [[9, 4, 9.5], [7, 1, 4.6]], cmm: [[22, 4.5, 6.5], [18, 1, 0]], matid: [[-21.5, 4.5, 6.5], [-18, 1, 0]], source: [[-31, 6, 9], [-28, 0.5, 0]], sink: [[31, 5, 8], [28, 0.5, 0]], turn: [[9.5, 4.2, -9.5], [7, 1, -3]],
  };
  if (process.env.SCROLL_LEFT) await js(`(()=>{ const z=document.getElementById("zcAd"); z?.scrollIntoView({block:"end"}); z?.querySelector("details")?.setAttribute("open",""); })()`);
  const pick = which === 'all' ? Object.keys(views) : which.split(',');
  for (const k of pick) {
    const [p, t] = views[k];
    await js(`(()=>{ const t=window.__twin; t.persp.position.set(${p}); t.ctlP.target.set(${t}); t.ctlP.update(); })()`);
    await wait(1800);
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${mode}-${k}.png`), img.toPNG());
  }
  const info = await js(`(()=>{ const s=window.__twin.sim; return JSON.stringify({ t: s.time, good: s.stats.good, render: window.__twin.RENDER.loaded, err: window.__twin.RENDER.error, states: s.processing.map(x=>x.id+':'+x.state) }); })()`);
  console.log(info); console.log('errors', errs.slice(0, 8).join('\n'));
  app.exit(0);
});
