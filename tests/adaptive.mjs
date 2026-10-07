// 적응가공 폐루프 검증 — 가공 → 진단 → 보정 → 측정 → 판정 → 리워크, 공구 예지보전, 오프셋 환류, 단계별 차이. 실행: npm test
import { zoneLine, ZONE_CELLS, ZONE_ROUTES } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { ADAPT_MODES, TOL_UM } from '../js/adaptive.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const runMode = (mode, sec, seed = 4) => {
  const s = new Simulation(mode, seed, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
  const cmm = s.processing.find((x) => x.id === 'CMM');
  for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); if (/합격|리워크|폐기/.test(cmm?.gate?.text ?? '')) s.gateVerdict = cmm.gate.text; }   // 표시판 판정 문구 (끝나는 순간은 측정 중일 수 있어 실행 중에 본다)
  return s;
};

console.log('== Zone 구성');
check('6셀 · 협약 셀 코드(A-2-1~A-2-5) · 제품별 경로(소재 식별 → 가공 2셀 → CMM)', Object.keys(ZONE_CELLS).length === 6 && Object.values(ZONE_CELLS).every((c) => /^A-2-[1-5]$/.test(c.code))
  && ZONE_ROUTES.hblock.join() === 'MATL,HB_MILL,HB_DEBR,CMM' && ZONE_ROUTES.rcover.join() === 'MATL,RC_MILL,RC_TURN,CMM');

const R = Object.fromEntries(['traditional', 'smart', 'dark'].map((m) => [m, runMode(m, 7200)]));
const st = (s) => s.adaptive.status();

console.log('== 진단·보정 지연 (KPI)');
{ const A = st(R.dark); check(`피지컬AI: 채터 진단 평균 < ${ADAPT_MODES.dark.diagMs}ms · 제어응답 < ${ADAPT_MODES.dark.ctrlMs}ms (5차년도 KPI)`, A.diagAvg < 14 && A.ctrlAvg < 20, `${A.diagAvg?.toFixed(1)} / ${A.ctrlAvg?.toFixed(1)}ms · 채터 ${A.stats.chatter}건`); }
{ const A = st(R.smart); check(`자동화: 진단 < ${ADAPT_MODES.smart.diagMs}ms · 제어응답 < ${ADAPT_MODES.smart.ctrlMs}ms (1차년도 KPI)`, A.diagAvg < 40 && A.ctrlAvg < 50, `${A.diagAvg?.toFixed(1)} / ${A.ctrlAvg?.toFixed(1)}ms`); }
{ const A = st(R.traditional); check('레거시: 채터 감지 수단 없음 (전부 미감지 · 진단 지연 없음)', A.stats.chatter > 0 && A.stats.chatterMissed === A.stats.chatter && A.diagAvg == null, `채터 ${A.stats.chatter}건 미감지`); }

console.log('== 자율복구 · 공구 예지보전');
{ const A = st(R.dark); check('피지컬AI: 채터 자율복구율 95% 이상 (3회 시도 안)', A.autoRate >= 0.95, `${(A.autoRate * 100).toFixed(1)}% · 상위 보고 ${A.stats.chatterEsc}건`); }
check('피지컬AI: 공구 파손 0 (실측 마모 기반 교체)', st(R.dark).stats.toolBreaks === 0 && st(R.dark).stats.toolChanges > 0, `교체 ${st(R.dark).stats.toolChanges}회`);
check('레거시: 고정 카운터 교체라 빨리 닳는 공구는 파손', st(R.traditional).stats.toolBreaks > st(R.dark).stats.toolBreaks, `파손 ${st(R.traditional).stats.toolBreaks}회`);
{ const hit = R.dark.erp?.db.mr.some((m) => /공구교체/.test(m.name)); check('공구교체 → 정비 출동 · ERP 정비요청 기록', hit); }

console.log('== 측정 · 판정 · 리워크 · 환류');
{ const A = st(R.dark), M = R.dark.adaptive.measures;
  check(`CMM 판정: 공차 ±${TOL_UM}µm 안이면 합격, 잔량은 리워크 후 재측정`, M.every((m) => m.res !== 'ok' || Math.abs(m.dev) <= TOL_UM * 1.5) && A.stats.rework > 0 && M.some((m) => m.reworked && m.res === 'ok'), `측정 ${A.stats.measured} · 리워크 ${A.stats.rework} · 폐기 ${A.stats.scrap}`); }
{ const errs = st(R.dark).cells.map((c) => Math.abs(c.err)); check('오프셋 환류: 가공셀 계통 편차가 공차의 절반 안에 머문다', errs.every((e) => e < TOL_UM / 2), errs.map((e) => e.toFixed(1)).join(' · ') + 'µm'); }
check('레거시: 샘플 검사라 편차 소재가 유출 · 피지컬AI는 유출 0', R.traditional.stats.escaped > 0 && R.dark.stats.escaped === 0, `유출 ${R.traditional.stats.escaped} → ${R.dark.stats.escaped}`);
check('CMM 게이트 표시판에 판정 결과', !!R.dark.gateVerdict, R.dark.gateVerdict);
{ const m = R.dark.processing.find((x) => x.id === 'MATL'); check('소재 식별 게이트: 제품 라인 분기 · 가공여유 3D 스캔', /라인 · 가공여유 3D 스캔/.test(m.gateLog?.at(-1)?.text ?? ''), m.gateLog?.at(-1)?.text); }

console.log('== 단계별 성과 (2시간)');
{ const g = ['traditional', 'smart', 'dark'].map((m) => R[m].stats.good); check('양품: 레거시 < 자동화 < 피지컬AI', g[0] < g[1] && g[1] < g[2], g.join(' → ')); }
check('적응 공구경로: 스캔한 가공여유로 에어컷 단축 (자동화·피지컬AI)', st(R.smart).stats.savedS > 0 && st(R.dark).stats.savedS > st(R.smart).stats.savedS * 0.9 && st(R.traditional).stats.savedS === 0, `${(st(R.smart).stats.savedS / 60).toFixed(0)}분 · ${(st(R.dark).stats.savedS / 60).toFixed(0)}분`);

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
