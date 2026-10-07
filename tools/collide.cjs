// 로봇·설비·이동체 간섭 검사 (Electron, 창 숨김): 실제 3D 화면의 메시마다 회전 상자(OBB)를 씌우고 분리축(SAT)으로 겹침 깊이를 잰다
// 시뮬레이션을 돌리면서 표본마다 ① 셀 로봇 ↔ 같은 셀 설비 · 셀 로봇끼리 ② 이동 로봇 ↔ 건물·창고·셀 설비 ③ 이동 로봇끼리를 본다
// 실행: npx electron tools/collide.cjs [단계=all|traditional|smart|dark] [초=3600] [표본 간격 초=0.5] [--json 결과.json]
// 간섭이 하나라도 있으면 종료 코드 1 — 배치·동선을 바꾼 뒤 이것으로 다시 확인한다
const { app, BrowserWindow } = require('electron');
const path = require('node:path'), fs = require('node:fs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2), jsonAt = argv.indexOf('--json'), jsonOut = jsonAt >= 0 ? argv[jsonAt + 1] : null;
const [which = 'all', secs = '3600', every = '0.5'] = argv.filter((a, i) => !a.startsWith('--') && !(jsonAt >= 0 && i === jsonAt + 1));
const MODES = which === 'all' ? ['traditional', 'smart', 'dark'] : which.split(',');
const TH = 0.015;   // 1.5cm 넘게 파고들면 간섭 (맞닿음·Blender 모서리 둥글림 오차 제외)
setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 3600000);

// 페이지 안에서 도는 검사 — three 모듈을 꺼내지 않고 Matrix4.elements(열 우선)로 직접 계산한다
const PAGE = String.raw`(async (SECS, EVERY, TH) => {
  const T = window.__twin, view = T.view, sim = T.sim;
  const obbOf = (o) => {
    const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox, e = o.matrixWorld.elements;
    const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
    const ax = [], h = [];
    for (const [k, hh] of [[0, (b.max.x - b.min.x) / 2], [4, (b.max.y - b.min.y) / 2], [8, (b.max.z - b.min.z) / 2]]) { const v = [e[k], e[k + 1], e[k + 2]], L = Math.hypot(...v) || 1; ax.push(v.map((q) => q / L)); h.push(hh * L); }
    const c = [e[0] * cx + e[4] * cy + e[8] * cz + e[12], e[1] * cx + e[5] * cy + e[9] * cz + e[13], e[2] * cx + e[6] * cy + e[10] * cz + e[14]];
    const ext = [0, 1, 2].map((i) => Math.abs(ax[0][i]) * h[0] + Math.abs(ax[1][i]) * h[1] + Math.abs(ax[2][i]) * h[2]);
    return { c, ax, h, min: c.map((q, i) => q - ext[i]), max: c.map((q, i) => q + ext[i]) };
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const depth = (A, B) => {   // 겹치면 최소 겹침 깊이(m), 떨어져 있으면 -1
    const d = [B.c[0] - A.c[0], B.c[1] - A.c[1], B.c[2] - A.c[2]], axes = [...A.ax, ...B.ax];
    for (const a of A.ax) for (const b of B.ax) { const x = cross(a, b), L = Math.hypot(...x); if (L > 1e-6) axes.push(x.map((q) => q / L)); }
    let best = Infinity;
    for (const n of axes) {
      const ra = A.h[0] * Math.abs(dot(A.ax[0], n)) + A.h[1] * Math.abs(dot(A.ax[1], n)) + A.h[2] * Math.abs(dot(A.ax[2], n));
      const rb = B.h[0] * Math.abs(dot(B.ax[0], n)) + B.h[1] * Math.abs(dot(B.ax[1], n)) + B.h[2] * Math.abs(dot(B.ax[2], n));
      const ov = ra + rb - Math.abs(dot(d, n));
      if (ov < 0) return -1; if (ov < best) best = ov;
    }
    return best;
  };
  const aabbHit = (A, B) => A.min[0] <= B.max[0] && A.max[0] >= B.min[0] && A.min[1] <= B.max[1] && A.max[1] >= B.min[1] && A.min[2] <= B.max[2] && A.max[2] >= B.min[2];
  // 보이는 실체만: 스프라이트·파티클·가산 블렌딩·깊이 미기록 효과(빛줄기·링)는 빼고, 운반 중인 대상물도 뺀다
  const solid = (o) => o.isMesh && !o.isSprite && !o.isInstancedMesh && o.geometry?.attributes?.position && [].concat(o.material).every((m) => m && m.blending !== 2 && m.depthWrite !== false);
  const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  const meshesUnder = (root, skip) => { const out = []; root.traverse((o) => { if (solid(o) && shown(o)) out.push(o); }); return skip ? out.filter((o) => { for (let p = o; p && p !== root; p = p.parent) if (skip.has(p)) return false; return true; }) : out; };
  const items = new Set(); const refreshItems = () => { items.clear(); for (const m of view.itemMeshes.values()) m.traverse((o) => items.add(o)); };
  const boxes = (list) => list.filter((o) => !items.has(o)).map((o) => ({ o, b: obbOf(o) }));
  const gdesc = (o) => { const p = o.geometry.parameters ?? {}, k = Object.keys(p).filter((q) => typeof p[q] === 'number').slice(0, 3); return o.geometry.type.replace('Geometry', '') + (k.length ? '(' + k.map((q) => +p[q].toFixed(2)).join(',') + ')' : ''); };
  const at = (o, frame) => { const v = o.getWorldPosition(new o.position.constructor()); frame.worldToLocal(v); return [v.x, v.y, v.z].map((q) => q.toFixed(2)).join(','); };
  const under = (o, groups) => { for (let p = o; p; p = p.parent) if (groups.has(p)) return true; return false; };

  const hits = new Map();
  const note = (kind, key, dp, info) => { const h = hits.get(key); if (!h) hits.set(key, { kind, key, max: dp, n: 1, t0: +sim.time.toFixed(1), info }); else { h.n++; if (dp > h.max) { h.max = dp; h.info = info; } } };
  let statics = null, n = 0;
  const check = () => {
    view.root.updateMatrixWorld(true); view.dyn.updateMatrixWorld(true); refreshItems();
    // ① 셀 로봇 ↔ 같은 셀 설비 · 셀 로봇끼리 (AMMR이 부품 선반 통에서 부품을 집는 것은 의도된 접촉)
    for (const sv of view.stationViews) {
      const robots = [...(sv.parts.robots ?? []).map((r, i) => ({ root: r.root, ammr: r.kind === 'ammr', id: (sv.st.robotUids?.[i] ?? sv.st.id + '#' + (i + 1)) + ' ' + r.kind })),
        ...Object.entries(sv.parts.arms ?? {}).map(([k, A], i) => ({ root: A.arm.root, id: (sv.st.id === 'SINK' ? sim.sinkRobotUids?.[i] : null) ?? sv.st.id + ' 적재 ' + k }))];
      if (!robots.length || !shown(robots[0].root)) continue;
      const racks = new Set((sv.parts.racks ?? []).map((r) => r.group));
      const eq = boxes(meshesUnder(sv.group, new Set(robots.map((x) => x.root)))).filter((x) => x.b.max[1] > 0.085);   // 셀 바닥 판·표시선 제외
      const rb = robots.map((x) => ({ ...x, ms: boxes(meshesUnder(x.root)) }));
      for (const R of rb) for (const e of eq) {
        if (R.ammr && under(e.o, racks) && !/Box/.test(e.o.geometry.type)) continue;   // 선반 통 속 부품 집기
        let dm = -1, mm = null; for (const m of R.ms) if (aabbHit(m.b, e.b)) { const d = depth(m.b, e.b); if (d > dm) { dm = d; mm = m; } }
        if (dm > TH) note('로봇×설비', sv.st.id + ' · ' + R.id + ' × ' + gdesc(e.o) + ' @' + at(e.o, sv.group), dm, { 상태: sv.st.state, 진행률: +(sv.st.progress ?? 0).toFixed(2), 로봇부위: gdesc(mm.o) + ' @' + at(mm.o, sv.group) });
      }
      for (let i = 0; i < rb.length; i++) for (let j = i + 1; j < rb.length; j++) {
        let dm = -1; for (const a of rb[i].ms) for (const b of rb[j].ms) if (aabbHit(a.b, b.b)) dm = Math.max(dm, depth(a.b, b.b));
        if (dm > TH) note('로봇×로봇', sv.st.id + ' · ' + rb[i].id + ' × ' + rb[j].id, dm, { 상태: sv.st.state, 진행률: +(sv.st.progress ?? 0).toFixed(2) });
      }
    }
    // ② 이동 로봇 ↔ 고정물 (건물·창고·셀 설비·셀 로봇·휴머노이드 충전 도크) — 고정물 목록은 20표본마다 다시 모으고 위치는 매번 갱신
    if (!statics || n++ % 20 === 0) {
      statics = meshesUnder(view.root, new Set([view.dyn, view.iot])).filter((o) => !items.has(o)).filter((o) => { const b = obbOf(o); return b.max[1] > 0.09 && b.min[1] < 2.2 && b.max[0] - b.min[0] < 30 && b.max[2] - b.min[2] < 30; });
      for (const { d } of view.humanoidDocks ?? []) statics.push(...meshesUnder(d).filter((o) => obbOf(o).max[1] > 0.09));
    }
    const st = statics.map((o) => ({ o, b: obbOf(o) }));
    const owner = (o) => { for (let p = o; p; p = p.parent) { if (p.userData?.stationId) return p.userData.stationId; if (view.humanoidDocks?.some((x) => x.d === p)) return '충전 도크'; } return '건물'; };
    const pallet = (o) => { const b = o.geometry.boundingBox; return Math.abs(b.max.x - b.min.x - 3.0) < 0.15 && Math.abs(b.max.y - b.min.y - 0.12) < 0.04; };   // 구분 적재장 팔레트: 포크가 들어가는 것은 의도된 접촉
    const mv = [...view.vehicleViews, ...view.carrierViews, ...view.techViews, ...view.helperViews, ...view.quadViews].filter((v) => shown(v.g) && v.v.state !== 'line').map((v) => {
      const ms = boxes(meshesUnder(v.g));
      return { v: v.v, ms, b: { min: [0, 1, 2].map((i) => Math.min(...ms.map((m) => m.b.min[i]))), max: [0, 1, 2].map((i) => Math.max(...ms.map((m) => m.b.max[i]))) } };
    });
    for (const M of mv) for (const s of st) {
      if (!aabbHit(M.b, s.b) || (M.v.kind === 'forklift' && pallet(s.o))) continue;
      let dm = -1, mm = null; for (const m of M.ms) if (aabbHit(m.b, s.b)) { const d = depth(m.b, s.b); if (d > dm) { dm = d; mm = m; } }
      if (dm > TH) { const own = owner(s.o), sv = view.stationViews.find((x) => x.st.id === own);
        note('이동체×고정물', M.v.id + ' × ' + own + ' ' + gdesc(s.o) + ' @' + at(s.o, sv?.group ?? view.root), dm, { 작업: M.v.task, 위치: [M.v.x, M.v.z].map((q) => +q.toFixed(2)), 높이: mm.b.min[1].toFixed(2) + '~' + mm.b.max[1].toFixed(2) + 'm' }); }
    }
    // ③ 이동 로봇끼리
    const ctx = (m) => ({ 위치: [m.x, m.z].map((q) => +q.toFixed(2)), 이동: !!m.moving, 막힘: m.blockedOn?.id ?? null, 작업: m.task });
    for (let i = 0; i < mv.length; i++) for (let j = i + 1; j < mv.length; j++) {
      const A = mv[i], B = mv[j]; if (!aabbHit(A.b, B.b)) continue;
      let dm = -1; for (const a of A.ms) for (const b of B.ms) if (aabbHit(a.b, b.b)) dm = Math.max(dm, depth(a.b, b.b));
      if (dm > TH) note('이동체×이동체', A.v.id + ' × ' + B.v.id, dm, { 시각: +sim.time.toFixed(1), [A.v.id]: ctx(A.v), [B.v.id]: ctx(B.v) });
    }
  };

  const STEPS = Math.round(SECS / 0.1), K = Math.max(1, Math.round(EVERY / 0.1));
  let samples = 0;
  for (let k = 0; k < STEPS; k++) {
    sim.step(0.1); T.agent?.update(0.1); view.update(0.1, true, 1);
    if (k % K === 0) { check(); samples++; }
    if (k % 600 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return JSON.stringify({ mode: sim.mode.key, simT: +sim.time.toFixed(0), samples, good: sim.stats.good, rendered: T.RENDER.loaded, hits: [...hits.values()].sort((a, b) => b.max - a.max) });
})`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const errs = []; w.webContents.on('console-message', (e) => { if (e.level === 'error') errs.push(String(e.message).slice(0, 300)); });
  const { startServer } = await import(path.join(__dirname, '..', 'server', 'app-server.mjs'));
  const { port } = await startServer({ port: 0 });
  await w.loadURL(`http://127.0.0.1:${port}`); await wait(5000);
  const js = (c) => w.webContents.executeJavaScript(c);
  const label = { traditional: '레거시', smart: '자동화', dark: '피지컬AI' }, out = [];
  let total = 0;
  for (const mode of MODES) {
    await js(`document.querySelector('[data-mode=${mode}]')?.click()`); await wait(3000);
    const r = JSON.parse(await js(`${PAGE}(${+secs}, ${+every}, ${TH})`)); out.push(r);
    console.log(`\n== ${label[mode] ?? mode}: 시뮬레이션 ${r.simT}초 · 표본 ${r.samples}개 · 간섭 ${r.hits.length}건${r.rendered ? '' : ' (Blender 모델 미로드 — 기본 도형으로 검사)'}`);
    for (const h of r.hits) console.log(`  ${(h.max * 100).toFixed(1).padStart(5)}cm  ${String(h.n).padStart(4)}회  ${h.t0}초~  [${h.kind}] ${h.key}  ${JSON.stringify(h.info)}`);
    total += r.hits.length;
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
  if (errs.length) console.log('\n페이지 오류:\n' + errs.slice(0, 6).join('\n'));
  console.log(`\n결과: 간섭 ${total}건 (${TH * 100}cm 초과)`);
  app.exit(total ? 1 : 0);
});
