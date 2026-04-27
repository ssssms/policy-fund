// 지역신용보증재단 보증상품 → shinbo-data.json
// 대구·경북: 동적 크롤링 (동일 CMS의 gdsNo 패턴)
// 서울·경기: 정적 데이터 (SPA로 동적 크롤링 어려움, 보증상품은 연간 변동 적음)
const fetch = require('node-fetch');
const https = require('https');
const fs = require('fs');

// SSL 인증서 검증 우회 (공공기관 인증서 체인 이슈 대응)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// HTML 태그 제거 + 공백 정리
function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// 보증상품 상세 페이지 → 정보 추출
function parseDetail(html) {
  const titleMatch = html.match(/<h1[^>]*class="tm_h1[^"]*"[^>]*>([^<]+)<\/h1>/);
  if (!titleMatch) return null;
  const name = stripTags(titleMatch[1]);

  // table의 th/td 쌍 추출
  const info = {};
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const cells = [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)];
    for (let i = 0; i < cells.length - 1; i++) {
      const k = stripTags(cells[i][1]);
      const v = stripTags(cells[i+1][1]);
      if (k && v && k.length < 20 && /지원목적|지원대상|자금조건|자금종류|보증료율|대출한도|이자지원|상세설명|융자규모|시행년도|보증한도/.test(k)) {
        if (!info[k]) info[k] = v;
      }
    }
  }

  return { name, info };
}

// 동적 크롤링: 단일 재단
async function crawlFoundation(cfg) {
  const results = [];
  const { region, host, listPath, max } = cfg;
  console.log(`\n[${region}] 크롤링 시작 (gdsNo 1~${max})`);

  for (let n = 1; n <= max; n++) {
    const url = `https://${host}${listPath}?pageDtlOrdrNo=1&importUrl=/guaranteegoods/detail.tc&gdsNo=${n}`;
    try {
      const r = await fetch(url, { agent: httpsAgent, headers: { 'User-Agent': UA }, timeout: 12000 });
      if (!r.ok) continue;
      const html = await r.text();
      const parsed = parseDetail(html);
      if (!parsed || !parsed.name) continue;
      // ERROR/NOT FOUND 페이지는 h1이 다른 경우가 많음
      if (parsed.name.length < 4 || parsed.name.length > 100) continue;

      const summary = [
        parsed.info['지원목적'] && `목적: ${parsed.info['지원목적']}`,
        parsed.info['지원대상'] && `대상: ${parsed.info['지원대상']}`,
        parsed.info['자금조건'] && `조건: ${parsed.info['자금조건']}`,
        parsed.info['보증료율'] && `보증료율: ${parsed.info['보증료율']}`
      ].filter(Boolean).join(' / ');

      results.push({
        pblancNm: parsed.name,
        bsnsSumryCn: summary || (parsed.info['상세설명'] || ''),
        jrsdInsttNm: `${region}신용보증재단`,
        excInsttNm: '',
        reqstBeginEndDe: '상시',
        pblancUrl: url,
        pblancId: `SHINBO_${region}_${n}`,
        hashtags: [region, '신용보증재단', '소상공인', '중소기업', '보증'].join(','),
        pldirSportRealmLclasCodeNm: '금융',
        trgetNm: parsed.info['지원대상'] || '',
        _source: 'shinbo'
      });
    } catch (err) {
      // 개별 실패는 무시 (404 등)
    }
  }
  console.log(`[${region}] ${results.length}건 수집`);
  return results;
}

// ── 서울·경기 정적 데이터 (보증상품 연간 변동 적음, 시연 안정성 우선) ──
const STATIC_PRODUCTS = [
  // ── 서울신용보증재단 ──
  {
    region: '서울', name: '소상공인 일반보증',
    purpose: '서울시 소재 소상공인 운영자금 지원',
    target: '서울시 사업자등록 소상공인',
    cond: '한도 1억원 이내, 보증료 0.5~1.5%',
    url: 'https://www.seoulshinbo.co.kr/'
  },
  {
    region: '서울', name: '청년창업 특별보증',
    purpose: '만 19~39세 청년 창업기업 지원',
    target: '서울시 청년 창업기업(업력 3년 이내)',
    cond: '한도 1억원, 우대 보증료율 적용',
    url: 'https://www.seoulshinbo.co.kr/'
  },
  {
    region: '서울', name: '골목상권 응원 특례보증',
    purpose: '서울시 골목상권 소상공인 경영안정 자금 지원',
    target: '서울시 골목상권 소상공인',
    cond: '한도 5천만원, 이차보전 적용',
    url: 'https://www.seoulshinbo.co.kr/'
  },
  {
    region: '서울', name: '서울형 정책자금',
    purpose: '서울시 정책자금 융자 보증',
    target: '서울시 소상공인·중소기업',
    cond: '한도 2억원, 시중금리 대비 우대',
    url: 'https://www.seoulshinbo.co.kr/'
  },
  {
    region: '서울', name: '서울신보 손실보전 특례보증',
    purpose: '경영악화 소상공인 긴급 운영자금',
    target: '서울시 소상공인',
    cond: '한도 1천만원, 보증료 0.5%',
    url: 'https://www.seoulshinbo.co.kr/'
  },
  // ── 경기신용보증재단 ──
  {
    region: '경기', name: '경기도 소상공인 특례보증',
    purpose: '경기도 소상공인 경영안정 자금',
    target: '경기도 사업자등록 소상공인',
    cond: '한도 7천만원, 보증비율 100%',
    url: 'https://www.gcgf.or.kr/'
  },
  {
    region: '경기', name: 'G-희망 경기도 특례보증',
    purpose: '경기도 중소기업 운영자금',
    target: '경기도 중소기업',
    cond: '한도 1억원, 이차보전 1~2%',
    url: 'https://www.gcgf.or.kr/'
  },
  {
    region: '경기', name: '경기 청년창업 특례보증',
    purpose: '경기도 청년 창업기업 지원',
    target: '만 19~39세 경기도 창업자',
    cond: '한도 1억원, 보증료 0.3% 우대',
    url: 'https://www.gcgf.or.kr/'
  },
  {
    region: '경기', name: '경기 신혼부부 창업특례보증',
    purpose: '경기도 신혼부부 창업 자금',
    target: '경기도 신혼부부 창업자',
    cond: '한도 5천만원, 우대 이차보전',
    url: 'https://www.gcgf.or.kr/'
  },
  {
    region: '경기', name: '경기도 골목상권 활력자금 특례보증',
    purpose: '경기도 골목상권 소상공인 활력 지원',
    target: '경기도 골목상권 소상공인',
    cond: '한도 3천만원, 보증료 면제',
    url: 'https://www.gcgf.or.kr/'
  }
];

function staticToItems() {
  return STATIC_PRODUCTS.map((p, i) => ({
    pblancNm: p.name,
    bsnsSumryCn: `목적: ${p.purpose} / 대상: ${p.target} / 조건: ${p.cond}`,
    jrsdInsttNm: `${p.region}신용보증재단`,
    excInsttNm: '',
    reqstBeginEndDe: '상시',
    pblancUrl: p.url,
    pblancId: `SHINBO_${p.region}_S${i+1}`,
    hashtags: [p.region, '신용보증재단', '소상공인', '중소기업', '보증'].join(','),
    pldirSportRealmLclasCodeNm: '금융',
    trgetNm: p.target,
    _source: 'shinbo'
  }));
}

(async () => {
  try {
    const all = [];

    // 동적: 대구·경북
    const daegu = await crawlFoundation({
      region: '대구', host: 'www.dgsinbo.or.kr',
      listPath: '/page/10039/10043.tc', max: 100
    });
    all.push(...daegu);

    const gyeongbuk = await crawlFoundation({
      region: '경북', host: 'gbsinbo.co.kr',
      listPath: '/page/10045/10003.tc', max: 150
    });
    all.push(...gyeongbuk);

    // 정적: 서울·경기
    const staticItems = staticToItems();
    all.push(...staticItems);
    console.log(`\n[서울·경기 정적] ${staticItems.length}건`);

    const output = {
      updatedAt: new Date().toISOString(),
      total: all.length,
      regions: { 대구: daegu.length, 경북: gyeongbuk.length, 서울: 5, 경기: 5 },
      data: all
    };
    fs.writeFileSync('shinbo-data.json', JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\nshinbo-data.json saved: ${all.length}건 (${output.updatedAt})`);
    console.log(`분포: ${JSON.stringify(output.regions)}`);
  } catch (err) {
    console.error('[shinbo 크롤 오류]', err.message);
    process.exit(1);
  }
})();
