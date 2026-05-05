#!/usr/bin/env node
/**
 * test-matching.js
 *
 * Phase 4 회귀 테스트 — 사용자 프로필 ↔ 자금 자격 매칭 정확성 검증
 *
 * 사용법:
 *   node test-matching.js                        # parsed-funds.json 사용
 *   node test-matching.js parsed-funds.new.json  # 다른 파일 지정
 *
 * 검증 항목:
 *  1. 통계 — 각 프로필 케이스별 ✅/⚠️/❌/info 건수
 *  2. 신뢰도 분포 — HIGH/MEDIUM/LOW (LLM 분류 완성도)
 *  3. 핵심 케이스 — 사양에 명시된 3가지 시나리오
 */
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || 'parsed-funds.json';
const FULL = path.join(__dirname, FILE);
console.log(`▶ ${FILE} 로드`);
const obj = JSON.parse(fs.readFileSync(FULL, 'utf8'));
const items = Object.values(obj.items || {});
console.log(`  총 ${items.length}건`);

// ── index.html의 매칭 함수 사본 ──────────────────────────────────
const userAgeRange = g => ({'20s':[20,29],'30s':[30,39],'40s':[40,49],'50s':[50,59],'60plus':[60,100]})[g] || null;
const userBizAgeRange = b => ({'under1':[0,1],'1to3':[1,3],'3to5':[3,5],'5to10':[5,10],'over10':[10,100]})[b] || null;
const userSalesRange = s => ({'under1':[0,1],'1to5':[1,5],'5to10':[5,10],'over10':[10,10000]})[s] || null;

function parseAgeRangeLLM(t){if(!t)return null;t=String(t);const ns=[...t.matchAll(/(\d+)\s*세/g)].map(m=>+m[1]);if(!ns.length)return null;const lo=/이하|미만|이내/.test(t),up=/이상|초과|넘는/.test(t);if(ns.length>=2)return{min:Math.min(...ns),max:Math.max(...ns)};if(lo)return{min:0,max:ns[0]};if(up)return{min:ns[0],max:100};return{min:0,max:ns[0]};}
function parseBizAgeRangeLLM(t){if(!t)return null;t=String(t);const y=[...t.matchAll(/(\d+)\s*년/g)].map(m=>+m[1]);const mo=[...t.matchAll(/(\d+)\s*개월/g)].map(m=>+m[1]/12);const ns=[...y,...mo];if(!ns.length)return null;const lo=/이하|미만|이내/.test(t),up=/이상|초과|경과/.test(t);if(ns.length>=2)return{min:Math.min(...ns),max:Math.max(...ns)};if(lo)return{min:0,max:ns[0]};if(up)return{min:ns[0],max:100};return{min:0,max:ns[0]};}
function parseSalesLimitLLM(t){if(!t)return null;t=String(t);const e=[...t.matchAll(/(\d+(?:\.\d+)?)\s*억/g)].map(m=>+m[1]);const m2=[...t.matchAll(/(\d+(?:,\d{3})*)\s*만/g)].map(m=>parseFloat(m[1].replace(/,/g,''))/10000);const ns=[...e,...m2];if(!ns.length)return null;const lo=/이하|미만|이내/.test(t),up=/이상|초과/.test(t);if(ns.length>=2)return{min:Math.min(...ns),max:Math.max(...ns)};if(lo)return{min:0,max:ns[0]};if(up)return{min:ns[0],max:1e6};return{min:0,max:ns[0]};}
const overlap = (a, f) => a[0] <= f.max && a[1] >= f.min;

// 사용자 체크박스 옵션 (index.html SPECIAL_GROUP_OPTIONS 사본)
const SPECIAL_GROUP_OPTIONS = [
  '청년', '여성', '예비창업자', '기존사업자',
  '재해피해', '저신용', '저소득', '장애인',
  '사회적기업', '재창업', '한부모', '고령자',
  '신혼부부', '북한이탈주민', '다문화'
];

function evaluateMatch(item, profile) {
  if (!profile) return { status: 'unrated', details: [], prefCount: 0 };
  const llm = item; // parsed-funds 항목 자체가 LLM 메타
  if (!llm) return { status: 'check', details: [{type:'unknown'}], prefCount: 0 };

  const req = (llm.requirement && typeof llm.requirement === 'object') ? llm.requirement : {};
  const details = [];
  let hasFail = false, hasUnknown = false, prefCount = 0;

  const handleMiss = (reqType, label, detail) => {
    if (reqType === 'required') { hasFail = true; details.push({type:'fail', text:`[필수] ${label} 미충족 — ${detail}`}); }
    else if (reqType === 'preference') { details.push({type:'info', text:`${label} 우대 미해당`}); }
    else if (reqType === 'conditional') { hasUnknown = true; details.push({type:'unknown', text:`${label} 트랙 한정 — 확인`}); }
    else { hasUnknown = true; details.push({type:'unknown', text:`${label} 분류 불명 — 확인`}); }
  };

  // 업력
  if (profile.bizAge && llm.businessAgeRange) {
    const u = userBizAgeRange(profile.bizAge), f = parseBizAgeRangeLLM(llm.businessAgeRange);
    const r = req.businessAgeRange;
    if (f) {
      if (overlap(u, f)) {
        if (r === 'preference') { prefCount++; details.push({type:'pref', text:`업력 우대 매칭`}); }
        else details.push({type:'pass', text:`업력 적합`});
      } else handleMiss(r, '업력', `필요 ${llm.businessAgeRange}`);
    } else { hasUnknown = true; details.push({type:'unknown', text:'업력 해석불가'}); }
  }
  // 매출
  if (profile.salesRange && llm.salesLimit) {
    const u = userSalesRange(profile.salesRange), f = parseSalesLimitLLM(llm.salesLimit);
    const r = req.salesLimit;
    if (f) {
      if (overlap(u, f)) {
        if (r === 'preference') { prefCount++; details.push({type:'pref', text:`매출 우대 매칭`}); }
        else details.push({type:'pass', text:`매출 적합`});
      } else handleMiss(r, '매출', `필요 ${llm.salesLimit}`);
    } else { hasUnknown = true; details.push({type:'unknown', text:'매출 해석불가'}); }
  }
  // 연령
  if (profile.ageGroup && llm.ageRange) {
    const u = userAgeRange(profile.ageGroup), f = parseAgeRangeLLM(llm.ageRange);
    const r = req.ageRange;
    if (f) {
      if (overlap(u, f)) {
        if (r === 'preference') { prefCount++; details.push({type:'pref', text:`연령 우대 매칭`}); }
        else details.push({type:'pass', text:`연령 적합`});
      } else handleMiss(r, '연령', `필요 ${llm.ageRange}`);
    } else { hasUnknown = true; details.push({type:'unknown', text:'연령 해석불가'}); }
  }
  // 사업자 규모
  if (profile.bizSize && Array.isArray(llm.businessSize) && llm.businessSize.length > 0
      && !llm.businessSize.includes('제한없음')) {
    const r = req.businessSize;
    if (llm.businessSize.includes(profile.bizSize)) {
      if (r === 'preference') { prefCount++; details.push({type:'pref', text:`규모 우대 매칭`}); }
      else details.push({type:'pass', text:`규모 적합`});
    } else handleMiss(r, '사업자규모', `대상 ${llm.businessSize.join('/')}`);
  }
  // 특수자격
  if (Array.isArray(llm.specialGroups) && llm.specialGroups.length > 0) {
    const sg = (req.specialGroups && typeof req.specialGroups === 'object') ? req.specialGroups : {};
    const userG = profile.specialGroups || [];
    for (const g of llm.specialGroups) {
      const r = sg[g] || null;
      if (userG.includes(g)) {
        if (r === 'preference') { prefCount++; details.push({type:'pref', text:`${g} 우대 매칭`}); }
        else details.push({type:'pass', text:`${g} 자격 충족`});
      } else {
        const userCheckable = SPECIAL_GROUP_OPTIONS.includes(g);
        if (r === 'required') {
          if (userCheckable) { hasFail = true; details.push({type:'fail', text:`[필수] ${g} 미해당`}); }
          else { hasUnknown = true; details.push({type:'unknown', text:`${g} 체크박스 외 — 본문 확인`}); }
        }
        else if (r === 'conditional') { hasUnknown = true; details.push({type:'unknown', text:`${g} 트랙 한정 — 확인`}); }
        else if (r === 'preference') { /* 영향 없음 */ }
        else { hasUnknown = true; details.push({type:'unknown', text:`${g} 분류 불명 — 확인`}); }
      }
    }
  }

  let status;
  if (hasFail) status = 'ineligible';
  else if (details.length === 0) { status = 'eligible'; details.push({type:'pass', text:'일반 자금'}); }
  else if (hasUnknown) status = 'check';
  else status = 'eligible';
  return { status, details, prefCount };
}

// ── 신뢰도 분류 ──
function confidence(item) {
  const r = item.requirement || {};
  const checkable = ['ageRange','businessAgeRange','salesLimit'].filter(k => item[k] != null);
  const classified = checkable.filter(k => r[k] != null);
  const sgArr = item.specialGroups || [];
  const sgReq = r.specialGroups || {};
  const sgClassified = sgArr.filter(g => sgReq[g] != null);

  // HIGH: 모든 명시된 필드가 분류되어 있고 자격 정보 풍부
  if (checkable.length >= 1 && classified.length === checkable.length &&
      sgArr.length === sgClassified.length && r.businessSize != null) {
    return 'HIGH';
  }
  // LOW: 자격 정보가 거의 없음
  if (checkable.length === 0 && sgArr.length === 0 && r.businessSize == null) {
    return 'LOW';
  }
  // 그 외 — MEDIUM
  return 'MEDIUM';
}

// ── 핵심 회귀 테스트 케이스 ──
const CASES = [
  {
    name: '회귀 1: 35세 청년, 5년차 (창업 3년 한정 자금 ❌ 검증)',
    profile: { ageGroup:'30s', bizAge:'5to10', salesRange:'1to5', bizSize:'중소기업', specialGroups:['청년'] },
  },
  {
    name: '회귀 2: 35세 청년, 1년차 (창업 3년 한정 자금 ✅ 검증)',
    profile: { ageGroup:'30s', bizAge:'under1', salesRange:'1to5', bizSize:'중소기업', specialGroups:['청년'] },
  },
  {
    name: '회귀 3: 50세, 1년차 (청년 한정 ❌ / 청년 우대 ✅ 검증)',
    profile: { ageGroup:'50s', bizAge:'under1', salesRange:'1to5', bizSize:'중소기업', specialGroups:[] },
  },
];

console.log('\n══════════ 신뢰도 분포 ══════════');
const conf = { HIGH: 0, MEDIUM: 0, LOW: 0 };
for (const it of items) conf[confidence(it)]++;
console.log(`  HIGH:   ${conf.HIGH}건  (자격 정보 풍부 + 모두 분류됨)`);
console.log(`  MEDIUM: ${conf.MEDIUM}건  (일부 자격 명시, 일부 분류)`);
console.log(`  LOW:    ${conf.LOW}건  (자격 한정 없는 일반 자금)`);

console.log('\n══════════ 회귀 테스트 ══════════');
for (const c of CASES) {
  console.log(`\n▶ ${c.name}`);
  console.log(`  profile:`, JSON.stringify(c.profile));
  const stats = { eligible: 0, check: 0, ineligible: 0 };
  const failByCondition = [];
  const eligibleSamples = [];
  const ineligibleSamples = [];
  for (const it of items) {
    const m = evaluateMatch(it, c.profile);
    stats[m.status]++;
    if (m.status === 'eligible' && eligibleSamples.length < 2 && m.prefCount > 0) {
      eligibleSamples.push({ id: it.pblancId, name: it.summary, pref: m.prefCount, why: m.details.filter(d=>d.type==='pref').map(d=>d.text).join(' | ') });
    }
    if (m.status === 'ineligible' && ineligibleSamples.length < 3) {
      const fails = m.details.filter(d => d.type === 'fail').map(d => d.text);
      ineligibleSamples.push({ id: it.pblancId, name: it.summary, fails });
    }
  }
  console.log(`  결과: ✅ ${stats.eligible} / ⚠️ ${stats.check} / ❌ ${stats.ineligible}`);
  if (eligibleSamples.length > 0) {
    console.log(`  [✅ 우대 매칭 샘플]`);
    for (const s of eligibleSamples) console.log(`    +${s.pref}  ${s.id}  ${(s.name||'').slice(0,55)}\n         ${s.why}`);
  }
  if (ineligibleSamples.length > 0) {
    console.log(`  [❌ 자격 미달 샘플]`);
    for (const s of ineligibleSamples) console.log(`    ${s.id}  ${(s.name||'').slice(0,55)}\n         사유: ${s.fails.join(' / ')}`);
  }
}

// 사양 명시 회귀 검증: 청년전용창업자금(GOV24_142000000099) — "창업 3년 한정"
console.log('\n══════════ 핵심 자금별 회귀 검증 (사양 명시) ══════════');
const targetIds = [
  { id: 'GOV24_142000000099', label: '청년전용창업자금 (만 39세 + 창업 3년 미만 한정)' },
  { id: 'GOV24_383000000151', label: '안양시 청년창업 (만 19~39세 + 사업경력 5년 이하 한정)' },
  { id: 'KOSMES_SHSBI004M0', label: '중진공 혁신창업사업화자금 (다중 트랙 — 청년전용 conditional)' },
  { id: 'SHINBO_대구_1', label: '재해특례보증 (재해피해 한정)' },
];
for (const t of targetIds) {
  const it = items.find(x => x.pblancId === t.id);
  if (!it) { console.log(`  ${t.id}: 데이터 없음`); continue; }
  console.log(`\n[${t.id}] ${t.label}`);
  console.log(`  ageRange: ${it.ageRange} (req=${(it.requirement||{}).ageRange})`);
  console.log(`  businessAgeRange: ${it.businessAgeRange} (req=${(it.requirement||{}).businessAgeRange})`);
  console.log(`  specialGroups: ${JSON.stringify(it.specialGroups)} (req=${JSON.stringify((it.requirement||{}).specialGroups)})`);
  if (it.scopeNote) console.log(`  scopeNote: ${it.scopeNote}`);
  for (const c of CASES) {
    const m = evaluateMatch(it, c.profile);
    const icon = ({eligible:'✅', check:'⚠️', ineligible:'❌'})[m.status];
    console.log(`  → ${icon} (${c.name.slice(0, 28)}...)`);
  }
}
