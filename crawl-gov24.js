// 행정안전부 공공서비스(혜택) 정보 → gov24-data.json 저장
// 시군구 단위 정책자금/이차보전 공고까지 커버 (기업마당 미등록 분 보완)
const fetch = require('node-fetch');
const fs = require('fs');

const KEY = '602232bf3c4efc9b39717b92fc82ee11a3ef22aa1821f1d883a2f16a321821bc';
const BASE = 'https://api.odcloud.kr/api/gov24/v3/serviceList';

// 정책자금/지원사업 강한 매칭 키워드
const INCLUDE_RE = /이차보전|이자보전|이자차액|정책자금|융자|신용보증|특례보증|경영안정자금|창업자금|운영자금|육성기금|육성자금|소상공인.{0,6}(지원|자금|융자|보증)|중소기업.{0,6}(지원|자금|융자|보증|육성)|창업기업.{0,6}(지원|자금)/;

// 정책자금 아닌 노이즈 제외
const EXCLUDE_RE = /학자금|등록금|대학생|임대주택|전세자금|주거안정자금|보증금.{0,4}융자|지역화폐|상품권|방역|소독|방제|도로점용|점용료|손실보상금|자활기업|사회투자|디지털.{0,4}파기|위생해충|장애인.{0,4}활동|영유아|아동수당|어린이집|돌봄|보육|결혼이민|외국인.{0,4}복지/;

async function fetchAll() {
  const all = [];
  let page = 1;
  while (true) {
    const url = `${BASE}?serviceKey=${encodeURIComponent(KEY)}&page=${page}&perPage=1000`;
    const r = await fetch(url, { timeout: 30000 });
    if (!r.ok) throw new Error(`HTTP ${r.status} on page ${page}`);
    const d = await r.json();
    const items = d.data || [];
    all.push(...items);
    console.log(`page ${page}: +${items.length} (누적 ${all.length} / total ${d.totalCount})`);
    if (items.length < 1000 || all.length >= d.totalCount) break;
    page++;
    if (page > 20) break;
  }
  return all;
}

function filterPolicyFund(items) {
  return items.filter(it => {
    const blob = [
      it['서비스명'] || '',
      it['서비스목적요약'] || '',
      it['지원내용'] || '',
      it['지원대상'] || ''
    ].join(' ');
    if (EXCLUDE_RE.test(blob)) return false;
    return INCLUDE_RE.test(blob);
  });
}

// 시도/시군구 추출 (소관기관명 → "서울특별시 종로구" → 시도/시군구 분리)
function parseLocation(orgName) {
  if (!orgName) return { region: '', city: '' };
  const m = orgName.match(/^(\S+(?:특별시|광역시|특별자치시|특별자치도|도))\s*(\S+(?:시|군|구))?/);
  if (m) return { region: m[1], city: m[2] || '' };
  return { region: '', city: '' };
}

// gov24 → bizinfo 포맷으로 normalize
function normalizeGov24(item) {
  const orgName = item['소관기관명'] || '';
  const orgType = item['소관기관유형'] || '';
  const { region, city } = parseLocation(orgName);

  const period = item['신청기한'] || '상시';
  const tagParts = [region, city, item['서비스분야'], orgType].filter(Boolean);

  return {
    pblancNm: item['서비스명'] || '',
    bsnsSumryCn: item['서비스목적요약'] || item['지원내용'] || '',
    jrsdInsttNm: orgName,
    excInsttNm: item['부서명'] || '',
    reqstBeginEndDe: period,
    pblancUrl: item['상세조회URL'] || '#',
    pblancId: 'GOV24_' + (item['서비스ID'] || ''),
    hashtags: tagParts.join(','),
    pldirSportRealmLclasCodeNm: item['서비스분야'] || '',
    trgetNm: item['지원대상'] || '',
    _source: 'gov24',
    _orgType: orgType,
    _region: region,
    _city: city
  };
}

(async () => {
  try {
    console.log('[gov24] 전체 수집 시작...');
    const all = await fetchAll();
    console.log(`\n전체: ${all.length}건`);

    const filtered = filterPolicyFund(all);
    console.log(`정책자금 필터링: ${filtered.length}건`);

    const normalized = filtered.map(normalizeGov24);

    // 시도/시군구 분포
    const sigunguCount = normalized.filter(it => it._orgType === '시군구').length;
    const widerCount = normalized.filter(it => it._orgType === '광역자치단체').length;
    const centralCount = normalized.filter(it => it._orgType === '중앙행정기관').length;
    console.log(`  시군구 ${sigunguCount}건 / 광역 ${widerCount}건 / 중앙 ${centralCount}건`);

    const output = {
      updatedAt: new Date().toISOString(),
      total: normalized.length,
      data: normalized
    };
    fs.writeFileSync('gov24-data.json', JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\ngov24-data.json saved: ${normalized.length}건 (${output.updatedAt})`);
  } catch (err) {
    console.error('[gov24 크롤 오류]', err.message);
    process.exit(1);
  }
})();
