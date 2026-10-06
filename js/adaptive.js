// 적응가공 폐루프 (A-2-5 적응가공 통합 OCS · WP7 셀 운영통제) — 렌더링과 분리된 시뮬레이션 모듈.
// 가공 → 진단 → 보정 → 측정 → 판정 → 리워크 (협약 계획서 '가공–측정–판정–보정–재가공 폐루프')
//  · 소재 식별·3D측정셀: 프리폼(주물·압출 소재) 가공여유 편차를 스캔해 소재마다 공구경로 보정값을 만든다
//  · 가공셀(adaptive): 공구 수명·채터·열변위로 치수 편차가 생긴다. 엣지 AI가 소리·진동·스핀들 부하·절삭력으로 채터를 진단(diagMs)하고
//    Feed·Speed override로 보정(ctrlMs)한다 — 최대 3회 자율복구, 실패하면 셀 HOLD 후 상위 보고(공구교체)
//  · 공구 예지보전: 수명 임계 전에 공구교체 출동 (레거시는 마모 알람·파손 뒤 사후 교체)
//  · 초정밀 측정·리워크셀(CMM): 치수 편차를 판정해 합격 / 리워크(잔량 재가공 후 재측정) / 폐기, 측정값을 상류 가공셀 공구 오프셋으로 되먹인다
// 수치는 문서 KPI(진단 <14ms · 제어응답 <20ms(5차년도), <40/<50ms(1차년도), 가공시간 단축 12~20%, 자율복구 3회)와 예시용 가정값이다.

export const TOL_UM = 20;   // 판정 공차 ±20µm (유압블록 홀 위치·리어커버 베어링 보어 — 예시용 가정값)
export const ADAPT_MODES = {
  traditional: {
    label: '고정 NC 프로그램 · 작업자 판단', diagMs: null, ctrlMs: null,
    scan: false, comp: 0, airCut: 0, chatterDetect: false, autoRecover: 0, predictive: false,
    feedback: 'sample', sampleEvery: 24,      // 30분 주기 자주검사(4EA 수기 기록) — 24개마다 한 번 오프셋 수정
    toolLimit: 0, counterN: 30, toolTime: 150, toolWho: '작업자 (공구실 왕복 · 대차 운반)', reworkMul: 1.6,   // 고정 카운터: 실제 마모와 관계없이 30개마다 교체 (가장 빨리 닳는 공구에 맞춘 보수적 주기)
  },
  smart: {
    label: '엣지 AI 진단·보정 (1차년도 KPI)', diagMs: 40, ctrlMs: 50,
    scan: true, comp: 0.65, airCut: 0.12, chatterDetect: true, autoRecover: 0.72, predictive: true,
    feedback: 'each', gain: 0.45, toolLimit: 20, toolTime: 70, toolWho: '작업자 + AMR 공구 배송', reworkMul: 1.0,
  },
  dark: {
    label: 'PA Agent 자율 적응가공 (5차년도 KPI)', diagMs: 14, ctrlMs: 20,
    scan: true, comp: 0.9, airCut: 0.18, chatterDetect: true, autoRecover: 0.86, predictive: true,
    feedback: 'each', gain: 0.65, toolLimit: 22, toolTime: 40, toolWho: '정비 휴머노이드 공구 자동교체 (공구보관 → 셀)', reworkMul: 0.8,
  },
};
// 셀별 공구 (대표 공구 1개로 수명을 본다)
const TOOLS = {
  HB_MILL: 'T07 Ø6 초경 엔드밀 (A6082)', HB_DEBR: 'T12 사선홀 드릴 Ø3.2 + 디버링 툴', RC_MILL: 'T03 Ø63 페이스밀 (ADC12)', RC_TURN: 'T21 보어 바이트 CNMG',
};
const gauss = (r) => { let u = 0; for (let i = 0; i < 6; i++) u += r(); return (u - 3) / Math.sqrt(0.5); };

export class AdaptiveControl {
  constructor(sim) {
    this.sim = sim;
    this.A = ADAPT_MODES[sim.mode.key] ?? ADAPT_MODES.smart;
    this.stats = { scanned: 0, chatter: 0, chatterAuto: 0, chatterEsc: 0, chatterMissed: 0, toolChanges: 0, toolBreaks: 0, measured: 0, ok: 0, rework: 0, scrap: 0, comp: 0, savedS: 0, diagSum: 0, ctrlSum: 0, nDiag: 0 };
    this.events = [];   // 최근 폐루프 이벤트 (OCS 패널)
    this.measures = [];  // 최근 측정 결과 (CMM 판정 이력)
    for (const st of sim.processing) if (st.def.adaptive) this.initCell(st);
  }
  initCell(st) {
    const sim = this.sim;
    {
      st.ad = {
        tool: { name: TOOLS[st.id] ?? 'T01 엔드밀', life: 70 + sim.rand() * 30, base: st.def.type === 'turn' ? 1.9 : 2.2, rate: 0, count: Math.floor(sim.rand() * 12), changes: 0, req: false },
        bias: (sim.rand() - 0.5) * 8,   // 열변위·기계 오차 (µm, 천천히 떠돈다)
        warm: 9 + sim.rand() * 6,        // 웜업 평형 열변위 (µm)
        offset: 0,                       // 공구 오프셋 보정값 (µm)
        ov: 1, ovT: 0,                   // Feed·Speed override (채터 보정 중)
        chatterAt: null, attempts: 0,
        sig: { load: 0, vib: 0, ae: 0, force: 0, temp: 22 },
        last: null, n: 0, sinceSample: 0,
      };
      this.newRate(st);
    }
  }
  get mode() { return this.A; }
  // 공구마다 실제 마모 속도가 다르다 (소재 로트·공구 품질) — 개당 수명 소모 %
  newRate(st) { st.ad.tool.rate = st.ad.tool.base * (0.7 + this.sim.rand() * 0.8); }
  // 교체 대기 중 새 소재를 받지 않는 조건: 적응가공은 실측 수명이 다했을 때, 레거시는 CNC 공구 수명 카운터 알람(개수 도달)일 때
  // — 레거시는 실제 마모를 모르므로 카운터 전에 빨리 닳는 공구는 그대로 가공하다 파손된다
  holdForTool(st) { const t = st.ad?.tool; return !!t && t.req && (this.A.predictive ? t.life < 3 : t.count >= this.A.counterN); }
  wearDev(st) { return (100 - st.ad.tool.life) * 0.12; }   // 공구 마모에 따른 치수 편차 (µm)
  errOf(st) { return st.ad.bias + this.wearDev(st) - st.ad.offset; }   // 지금 가공하면 나올 계통 편차

  log(st, kind, text, extra = {}) {
    this.events.push({ t: this.sim.time, st: st?.id, cell: st?.name, kind, text, ...extra });
    if (this.events.length > 80) this.events.shift();
  }

  // 소재 식별·3D측정: 프리폼 가공여유 편차 (mm) — 레거시는 스캔 없이 소재 ID만 확인
  onScan(st, it) {
    if (!it || it.scrap || it.stock != null) return;
    it.stock = +(gauss(this.sim.rand) * 0.28).toFixed(2);   // ±0.3mm 내외 (다이캐스팅·압출 소재)
    it.scanned = this.A.scan;
    if (this.A.scan) this.stats.scanned++;
  }

  // 가공셀에 소재가 들어올 때: 사이클 결정 (적응 공구경로 → 에어컷 단축), 채터 발생 시점
  onStart(st, it) {
    if (!st.ad || !it || it.scrap) return 1;
    const r = this.sim.rand, A = this.A, ad = st.ad;
    ad.ov = 1; ad.attempts = 0;
    // 채터 확률: 공구 마모 + 큰 가공여유(스캔 없이 고정 프로그램이면 그대로 맞는다) + 속도 오버라이드
    const stock = Math.abs(it.stock ?? 0);
    const p = 0.025 + ((100 - ad.tool.life) / 100) * 0.12 + (A.scan ? stock * 0.03 : stock * 0.12) + ((st.cmd?.override ?? 1) > 1 ? 0.06 : 0);
    ad.chatterAt = r() < p ? 0.25 + r() * 0.5 : null;
    // 가공 신호 (사이클마다 기준값)
    const wear = (100 - ad.tool.life) / 100;
    ad.sig = { load: 48 + wear * 30 + stock * 18 + r() * 6, vib: 0.35 + wear * 0.6 + r() * 0.1, ae: 52 + wear * 14 + r() * 3, force: (st.def.type === 'turn' ? 620 : 410) * (1 + wear * 0.5 + stock * 0.4), temp: 24 + ad.n % 40 * 0.05 + r() };
    if (!A.scan) return 1;
    const save = A.airCut * (0.75 + 0.5 * Math.min(1, Math.max(0, 0.5 - (it.stock ?? 0))));   // 여유가 작을수록 에어컷을 더 줄인다
    this.stats.savedS += save * st.def.cycle;
    return 1 - save;
  }

  // 매 스텝: 채터 발생·진단·보정 (진행률이 발생 시점을 지나면)
  tick(st, dt) {
    const ad = st.ad; if (!ad) return;
    ad.bias += (ad.warm - ad.bias) * dt / 1800 + (this.sim.rand() - 0.5) * 0.12 * dt;   // 열변위: 가동하면 웜업 평형값(약 12µm)으로 30분 시정수로 다가간다
    st.drift = Math.min(1, Math.abs(this.errOf(st)) / 60);         // 기존 SPC·순찰 점검이 보는 드리프트
    if (ad.chatterAt == null || st.state !== 'BUSY' || st.progress < ad.chatterAt) return;
    ad.chatterAt = null;
    const A = this.A, it = st.item, r = this.sim.rand;
    this.stats.chatter++;
    ad.sig.vib *= 2.6; ad.sig.ae += 9; ad.sig.load += 14;
    if (!A.chatterDetect) {   // 레거시: 가공기 내부를 볼 수 없고 진단도 없음 — 떨림이 그대로 가공면에 남는다
      this.stats.chatterMissed++; if (it) { it.chatter = true; it.devAdd = (it.devAdd ?? 0) + 4 + r() * 4; }
      ad.tool.life = Math.max(0, ad.tool.life - 2.5);   // 떨림이 공구 날을 상하게 한다
      this.log(st, 'miss', '채터 발생 — 감지 수단 없음 (가공면 떨림 자국)');
      return;
    }
    const diag = A.diagMs * (0.55 + r() * 0.4), ctrl = A.ctrlMs * (0.55 + r() * 0.4);
    this.stats.diagSum += diag; this.stats.ctrlSum += ctrl; this.stats.nDiag++;
    // 자율복구: Feed −12% · Spindle −8% (시도마다 더 낮춤), 최대 3회
    let ok = false;
    for (let k = 1; k <= 3 && !ok; k++) { ad.attempts = k; ad.ov = 1 - 0.12 * k; ok = r() < A.autoRecover; }
    const sigTxt = `진동 ${ad.sig.vib.toFixed(2)}g · AE ${ad.sig.ae.toFixed(0)}dB · 스핀들 부하 ${ad.sig.load.toFixed(0)}%`;
    if (ok) {
      this.stats.chatterAuto++; ad.ovT = 6;
      if (it) it.devAdd = (it.devAdd ?? 0) + 1.5;
      this.log(st, 'auto', `채터 진단 ${diag.toFixed(1)}ms → Feed·Speed ${Math.round(ad.ov * 100)}% 보정 ${ctrl.toFixed(1)}ms · ${ad.attempts}회 만에 자율복구`, { diag, ctrl, sig: sigTxt });
      if (this.sim.mode.agentActive && ad.attempts > 1) this.sim.log('act', `${st.name} 채터 자율복구 (${ad.attempts}회)`, { obs: `엣지 AI 진단 ${diag.toFixed(1)}ms — ${sigTxt}`, act: `Feed·Speed override ${Math.round(ad.ov * 100)}% (제어응답 ${ctrl.toFixed(1)}ms)` });
      return;
    }
    // 3회 실패: 셀 HOLD → 상위 보고 → 공구교체 (작업물은 잔량 가공 후 CMM에서 판정)
    this.stats.chatterEsc++; ad.ov = 0.7; ad.ovT = 8;
    if (it) it.devAdd = (it.devAdd ?? 0) + 6;
    this.log(st, 'esc', `채터 자율복구 3회 실패 → 셀 HOLD · 상위 보고 · 공구교체 요청`, { diag, ctrl, sig: sigTxt });
    const o = this.sim.orch, inc = o.open('quality', `chatter:${st.id}:${this.stats.chatterEsc}`, `${st.name} 채터 자율복구 실패`, st.name, { where: { x: st.x, z: st.z } });
    o.step(inc, 'field', 'detect', `엣지 AI(${diag.toFixed(1)}ms): ${sigTxt}`);
    o.step(inc, 'cell', 'self', `셀 자체 조치: Feed·Speed 보정 3회 (${ctrl.toFixed(1)}ms) — 채터 지속 → HOLD · 잔량 저속 가공`);
    o.later(0.5, () => o.step(inc, 'cell', 'report', '상위 보고: 공구 상태 이상 의심 · 공구교체 필요'));
    o.later(o.latency, () => { o.step(inc, 'orch', 'decide', `판단(${o.name}): 공구교체 우선 · 해당 소재는 CMM 판정 후 리워크/폐기`); o.step(inc, 'orch', 'command', `명령: ${A.toolWho}`); o.close(inc, '공구교체 출동으로 이관'); });
    this.requestTool(st, '채터 지속');
  }
  speedOf(st, dt) {
    const ad = st.ad; if (!ad) return 1;
    if (ad.ovT > 0) { ad.ovT -= dt; if (ad.ovT <= 0) ad.ov = 1; }
    return ad.ov;
  }

  // 가공 완료: 공구 마모 · 치수 편차 기록 · (스마트·자율) 공구 예지보전
  onComplete(st, it) {
    const ad = st.ad; if (!ad || !it || it.scrap) return;
    const r = this.sim.rand, A = this.A;
    ad.n++; ad.tool.count++;
    ad.tool.life = Math.max(0, ad.tool.life - ad.tool.rate * (0.8 + r() * 0.4) * ((st.cmd?.override ?? 1) > 1 ? 1.5 : 1) * (A.scan ? 0.85 : 1));
    // 소재 편차: 스캔 보정이 남기는 몫만큼 치수에 남는다
    const stockErr = (it.stock ?? 0) * 10 * (1 - A.comp);
    const dev = this.errOf(st) + stockErr + (it.devAdd ?? 0) + gauss(r) * (A.scan ? 2.2 : 3.0) + (100 - st.health) * 0.05;
    it.devs ??= {}; it.devs[st.id] = +dev.toFixed(1); it.devAdd = 0;
    ad.last = { dev, item: it.id };
    if (st.def.type === 'deburr') it.burr = r() < (A.scan ? 0.02 : 0.07) + (100 - ad.tool.life) / 1000;   // 교차홀 버 잔존 (PINN 영역 — 확률로)
    // 공구 파손: 수명 끝 (레거시는 알람 뒤에야 교체)
    if (ad.tool.life <= 0 || (ad.tool.life < 4 && r() < 0.15)) {
      this.stats.toolBreaks++; ad.tool.life = 0; it.devAdd = 0; it.devs[st.id] += 30; it.broken = true;   // 파손 순간의 소재는 눈에 띄는 손상 — 측정 없이도 폐기
      this.log(st, 'break', `공구 파손 — ${ad.tool.name}`);
      this.sim.fail(st, `공구 파손 (${ad.tool.name})`);
      ad.tool.req = true;   // 수리(공구 교체 포함) 후 새 공구
      return;
    }
    if (A.predictive && ad.tool.life < A.toolLimit) this.requestTool(st, `공구 수명 ${ad.tool.life.toFixed(0)}% — 예지보전`);
    else if (!A.predictive && ad.tool.count >= A.counterN) this.requestTool(st, `CNC 공구 수명 카운터 ${A.counterN}개 도달 (고정 주기 교체 · 남은 수명 ${ad.tool.life.toFixed(0)}%)`);
  }

  requestTool(st, why) {
    const ad = st.ad; if (!ad || ad.tool.req) return false;
    const delay = this.A.predictive ? 0 : this.sim.mode.alarmDelay + 5;
    if (!this.sim.requestTech(st, 'tool', delay)) return false;
    ad.tool.req = true;
    this.log(st, 'tool', `공구교체 요청 — ${why} (${this.A.toolWho})`);
    this.sim.log(this.A.predictive ? 'act' : 'warn', `${st.name} 공구교체 요청`, { obs: `${ad.tool.name} · ${why}`, act: this.A.toolWho });
    return true;
  }
  toolChanged(st) {
    const ad = st.ad; if (!ad) return;
    this.stats.lifeLeft = (this.stats.lifeLeft ?? 0) + ad.tool.life;   // 교체 때 남아 있던 수명 (버려진 공구 수명)
    ad.tool.life = 100; ad.tool.count = 0; ad.tool.changes++; ad.tool.req = false; this.stats.toolChanges++; this.newRate(st);
    ad.offset = ad.bias;   // 새 공구 길이·지름 측정(툴 프리세터) → 오프셋 재설정, 더미가공 확인
    this.log(st, 'tool', `공구교체 완료 · 툴 프리셋 · 더미가공 확인 — ${ad.tool.name}`);
  }
  recalibrated(st) { if (st.ad) { st.ad.offset = st.ad.bias + this.wearDev(st); this.log(st, 'comp', '재보정 — 공구 오프셋을 계통 편차에 맞춤'); } }

  // CMM 측정·판정: 'ok' | 'rework' | 'scrap' — 측정값을 상류 가공셀로 되먹인다
  onMeasure(st, it) {
    if (!it || it.scrap) return 'ok';
    const entries = Object.entries(it.devs ?? {});
    const [worstId, dev] = entries.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a), [null, 0]);
    const A = this.A, sim = this.sim;
    this.stats.measured++;
    // 피드백: 상류 가공셀마다 측정 편차만큼 오프셋 보정 (레거시는 자주검사 주기에만)
    for (const [id, d] of entries) {
      const up = sim.processing.find((x) => x.id === id); if (!up?.ad) continue;
      up.ad.sinceSample++;
      if (A.feedback === 'each') { up.ad.offset += d * A.gain; this.stats.comp++; }
      else if (up.ad.sinceSample >= A.sampleEvery) { up.ad.offset += d * 0.8; up.ad.sinceSample = 0; this.stats.comp++; this.log(up, 'comp', `자주검사(수기 기록) 반영 — 오프셋 ${(d * 0.8).toFixed(1)}µm 수정`); }
    }
    let res = 'ok';
    if (it.broken) res = 'scrap';
    else if (it.reworked) res = Math.abs(dev) > TOL_UM * 1.5 ? 'scrap' : 'ok';
    else if (it.burr) res = 'rework';
    else if (dev > TOL_UM) res = 'rework';          // 잔량(오버사이즈) → 재가공 가능
    else if (dev < -TOL_UM) res = 'scrap';          // 과삭(언더사이즈) → 폐기
    this.stats[res === 'ok' ? 'ok' : res]++;
    it.measured = true; it.dev = +dev.toFixed(1);
    this.measures.push({ t: sim.time, item: it.id, product: it.product, dev: it.dev, by: worstId, res, reworked: !!it.reworked, burr: !!it.burr });
    if (this.measures.length > 60) this.measures.shift();
    if (res !== 'ok') this.log(sim.processing.find((x) => x.id === worstId) ?? st, res, `${res === 'rework' ? '리워크' : '폐기'} 판정 #${it.id} — ${it.burr ? '버 잔존' : `편차 ${it.dev > 0 ? '+' : ''}${it.dev}µm (공차 ±${TOL_UM})`}`);
    return res;
  }

  status() {
    const S = this.stats, cells = this.sim.processing.filter((st) => st.ad);
    return {
      mode: this.A, stats: S,
      diagAvg: S.nDiag ? S.diagSum / S.nDiag : null, ctrlAvg: S.nDiag ? S.ctrlSum / S.nDiag : null,
      yield1: S.measured ? S.ok / S.measured : null,
      autoRate: S.chatter ? S.chatterAuto / S.chatter : null,
      cells: cells.map((st) => ({ id: st.id, name: st.name, tool: st.ad.tool, err: this.errOf(st), offset: st.ad.offset, ov: st.ad.ov, sig: st.ad.sig, last: st.ad.last })),
    };
  }
}
