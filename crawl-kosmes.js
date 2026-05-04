// 중소벤처기업진흥공단(중진공) 정책자금 크롤링 → kosmes-data.json
//
// 7개 정책자금 페이지(SBI 경로)를 fetch → 본문(신청대상·융자조건·상담처) 추출
// → bizinfo 형식으로 정규화하여 저장
//
// robots.txt 확인됨: 일반 크롤러 허용 (Googlebot에만 일부 PTS 페이지 disallow)
// 우리는 SBI 경로만 사용하므로 영향 없음
const fetch = require('node-fetch');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (PolicyFund-Research)';
const DELAY_MS = 800;
const TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 7개 정책자금 (사이드바 메뉴에서 추출한 정확한 라인업)
const FUNDS = [
  { code: 'SHSBI004M0', name: '혁신창업사업화자금',     stage: '창업기',     summary: '창업 7년 미만 중소기업 대상 창업기반지원·개발기술사업화 자금' },
  { code: 'SHSBI005M0', name: '투융자복합금융',          stage: '창업기',     summary: '성장잠재력 있는 중소기업에 융자와 투자를 결합한 자금 지원' },
  { code: 'SHSBI006M0', name: '신시장진출지원자금',     stage: '성장기',     summary: '수출·내수시장 진출 중소기업에 융자 지원' },
  { code: 'SHSBI007M0', name: '신성장기반자금',          stage: '성장기',     summary: '업력 7년 이상 중소기업의 성장 기반 마련 융자' },
  { code: 'SHSBI008M0', name: '재도약지원자금',          stage: '재도약기',   summary: '사업전환·구조개선·재창업 중소기업 융자' },
  { code: 'SHSBI012M0', name: '긴급경영안정자금',        stage: '모든단계',   summary: '재해·환율·원자재 등 외부 충격 입은 중소기업 긴급 융자' },
  { code: 'SHSBI115M0', name: '통상리스크대응긴급자금',  stage: '모든단계',   summary: '관세·통상마찰 등 통상 리스크 피해 중소기업 긴급 융자' },
];

async function fetchDetail(code) {
  const url = `https://www.kosmes.or.kr/nsh/SH/SBI/${code}.do`;
  const res = await fetch(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// HTML → 평문 (motie 크롤러와 동일 패턴)
function cleanText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|dt|dd)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 본문 추출 — "신청대상" sub-title 부터 "융자상담처" sub-title 직전까지
// 페이지마다 본문 컨테이너가 다르고 사이드바 메뉴와 헷갈리기 쉬워 가장 명확한 마커 사용
function extractContent(html) {
  // 1차: 신청대상 sub-title-02 ~ 융자상담처 sub-title-02 직전
  const startRe = /<h3[^>]*class="[^"]*sub-title-02[^"]*"[^>]*>\s*신청대상\s*<\/h3>/;
  const endRe = /<h3[^>]*class="[^"]*sub-title-02[^"]*"[^>]*>\s*융자상담처/;
  const startMatch = html.match(startRe);
  if (startMatch) {
    const startIdx = startMatch.index;
    const after = html.slice(startIdx);
    const endMatch = after.match(endRe);
    if (endMatch) {
      return cleanText(after.slice(0, endMatch.index));
    }
    return cleanText(after.slice(0, 5000)); // 끝 마커 없으면 적당히 제한
  }

  // 2차: 더 너그러운 매칭 (sub-title-02 클래스 있는 첫 h3 ~ 융자상담처)
  const altStart = html.match(/<h3[^>]*class="[^"]*sub-title-02[^"]*"[^>]*>(?!\s*융자상담처)/);
  if (altStart) {
    const startIdx = altStart.index;
    const after = html.slice(startIdx);
    const endMatch = after.match(endRe);
    if (endMatch) return cleanText(after.slice(0, endMatch.index));
  }

  // 3차: 평문에서 "신청대상" ~ "융자상담처" 구간 직접
  const plain = cleanText(html);
  const sIdx = plain.indexOf('신청대상');
  const eIdx = plain.indexOf('융자상담처');
  if (sIdx >= 0 && eIdx > sIdx) return plain.slice(sIdx, eIdx).trim();

  return '';
}

(async () => {
  console.log('▶ 중진공 정책자금 크롤링 시작 (7건)');
  const data = [];
  let ok = 0, fail = 0;

  for (let i = 0; i < FUNDS.length; i++) {
    const f = FUNDS[i];
    try {
      const html = await fetchDetail(f.code);
      const body = extractContent(html);
      const bodyLen = body.length;

      data.push({
        pblancNm: `중소기업 정책자금 — ${f.name}`,
        bsnsSumryCn: body ? body.slice(0, 2000) : f.summary,
        jrsdInsttNm: '중소벤처기업진흥공단',
        excInsttNm: `${f.stage} 정책자금`,
        reqstBeginEndDe: '연중 (지역본부별 신청기간 내 수시 접수)',
        pblancUrl: `https://www.kosmes.or.kr/nsh/SH/SBI/${f.code}.do`,
        pblancId: `KOSMES_${f.code}`,
        // 전국 대상 자금 — 모든 광역시도 포함해 사용자 지역 선택 시 매칭되게
        hashtags: [
          '중소벤처기업진흥공단', '중진공', '정책자금', '융자', '전국', f.stage,
          '서울','부산','대구','인천','광주','대전','울산','세종',
          '경기','강원','충북','충남','전북','전남','경북','경남','제주',
        ].join(','),
        pldirSportRealmLclasCodeNm: '금융',
        trgetNm: '중소기업기본법 제2조에 따른 중소기업 (전국). 재무 우량·휴폐업·세금체납·신용불량 등 제외',
        _source: 'kosmes',
      });
      ok++;
      console.log(`  [${i + 1}/${FUNDS.length}] ✓ ${f.code} ${f.name} (본문 ${bodyLen}자)`);
    } catch (err) {
      fail++;
      console.error(`  [${i + 1}/${FUNDS.length}] ✗ ${f.code} ${f.name}: ${err.message}`);
      // 실패 시에도 정적 정보로 fallback (제목·요약은 있음)
      data.push({
        pblancNm: `중소기업 정책자금 — ${f.name}`,
        bsnsSumryCn: f.summary + ' (사이트 fetch 실패, 정적 안내만 표시)',
        jrsdInsttNm: '중소벤처기업진흥공단',
        excInsttNm: `${f.stage} 정책자금`,
        reqstBeginEndDe: '연중 (지역본부별 신청기간 내 수시 접수)',
        pblancUrl: `https://www.kosmes.or.kr/nsh/SH/SBI/${f.code}.do`,
        pblancId: `KOSMES_${f.code}`,
        hashtags: [
          '중소벤처기업진흥공단', '중진공', '정책자금', '융자', '전국', f.stage,
          '서울','부산','대구','인천','광주','대전','울산','세종',
          '경기','강원','충북','충남','전북','전남','경북','경남','제주',
        ].join(','),
        pldirSportRealmLclasCodeNm: '금융',
        trgetNm: '중소기업기본법 제2조에 따른 중소기업 (전국)',
        _source: 'kosmes',
        _fetchFailed: true,
      });
    }
    if (i < FUNDS.length - 1) await sleep(DELAY_MS);
  }

  const output = { updatedAt: new Date().toISOString(), total: data.length, data };
  fs.writeFileSync('kosmes-data.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nkosmes-data.json saved: ${data.length}건 (성공 ${ok}, 실패 ${fail}) (${output.updatedAt})`);
})();
