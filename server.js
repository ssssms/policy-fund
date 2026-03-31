const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3000;

// ── 국세청 API 키 (발급 키 고정) ──
const NTS_API_KEY = '602232bf3c4efc9b39717b92fc82ee11a3ef22aa1821f1d883a2f16a321821bc';

// ── 기업마당 테스트 키 ──
const BIZINFO_KEY = 'QP6yn2';

// ── 업종별 검색 키워드 매핑 ──
const INDUSTRY_KEYWORDS = {
  '음식':  ['외식', '식품', '음식점'],
  '소매':  ['도소매', '유통'],
  '미용':  ['이미용', '미용'],
  '세탁':  ['세탁', '수선'],
  '제조':  ['제조업', '제조'],
  'IT':    ['IT', '소프트웨어', '디지털'],
  '기술':  ['기술개발', 'R&D', '연구개발'],
  '서비스':['서비스업'],
  '건설':  ['건설업', '건설'],
  '농업':  ['농업', '농축산', '수산'],
  '창업':  ['창업', '스타트업'],
};

// ── 업종 본문 매칭용 키워드 ──
const INDUSTRY_MATCH_WORDS = {
  '음식':  ['음식','외식','식품','요식','식당','카페','주점'],
  '소매':  ['도소매','소매','유통','판매점'],
  '미용':  ['미용','이미용','네일','헤어'],
  '세탁':  ['세탁','수선','의류'],
  '제조':  ['제조','생산','공장'],
  'IT':    ['IT','소프트웨어','디지털','앱','플랫폼','정보통신'],
  '기술':  ['기술개발','R&D','연구개발','특허','기술사업화'],
  '서비스':['서비스','컨설팅'],
  '건설':  ['건설','시공','인테리어'],
  '농업':  ['농업','농축산','수산','임업','어업'],
  '창업':  ['창업','스타트업','벤처','초기기업'],
};

// ── 생활업종: 기술·R&D·수출 분야 공고 제외 대상 ──
const LIFE_INDUSTRIES = new Set(['음식','소매','미용','세탁','서비스','건설','농업']);
const TECH_REALMS     = new Set(['기술','수출']);

// ── 업종별 관련 지원분야(realm) ──
// 해당 realm 이면 업종 키워드 미언급이어도 관련 공고로 인정
const INDUSTRY_REALMS = {
  '음식':  new Set(['금융','경영','내수','인력','창업']),
  '소매':  new Set(['금융','경영','내수','인력','창업']),
  '미용':  new Set(['금융','경영','내수','인력','창업']),
  '세탁':  new Set(['금융','경영','내수','인력','창업']),
  '제조':  new Set(['금융','기술','수출','경영','인력']),
  'IT':    new Set(['기술','창업','경영','금융']),
  '기술':  new Set(['기술','창업','경영','금융']),
  '서비스':new Set(['금융','경영','인력','창업','내수']),
  '건설':  new Set(['금융','경영','인력']),
  '농업':  new Set(['금융','경영','수출','내수']),
  '창업':  new Set(['창업','기술','경영','금융']),
};

// 시군구명에서 hashtag용 짧은 이름 추출 (경주시→경주, 해운대구→해운대, 달성군→달성)
function cityToHashtag(city) {
  if (!city) return '';
  return city.replace(/(특별시|광역시|특별자치시|특별자치도|시|군|구)$/, '');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// 기업마당 지원사업 검색
// ─────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { region, city, industry, size = '소상공인', pageUnit = 30 } = req.query;

  const results = [];
  const seen = new Set();

  const callBizinfo = async (hashtags, kw) => {
    const params = new URLSearchParams({
      crtfcKey: BIZINFO_KEY,
      dataType: 'json',
      pageIndex: 1,
      pageUnit
    });
    if (hashtags) params.append('hashtags', hashtags);
    if (kw)       params.append('keyword', kw);

    const url = `https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do?${params}`;
    console.log('[기업마당]', url);

    const response = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 10000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    for (const item of (data.jsonArray || [])) {
      const id = item.pblancId || item.pblancNm;
      if (id && !seen.has(id)) { seen.add(id); results.push(item); }
    }
  };

  try {
    const regionTag = region && region !== '전국' ? region : '';
    const sizeTag   = size === '소상공인' ? '소상공인' : '중소기업';
    const kwList    = industry ? (INDUSTRY_KEYWORDS[industry] || [industry]) : [];

    const cityTag   = city ? cityToHashtag(city) : '';   // "경주시" → "경주"
    const cityFull  = city || '';                          // "경주시" 그대로

    if (regionTag) {
      if (cityTag) {
        // ① 시군구 hashtag + 업종 keyword (가장 구체적)
        for (const kw of kwList) {
          await callBizinfo(`${cityTag},${regionTag},${sizeTag}`, kw);
        }
        // ② 시군구 hashtag (업종 무관, 시군구 전체 공고)
        await callBizinfo(`${cityTag},${regionTag},${sizeTag}`, '');
        await callBizinfo(`${cityTag},${sizeTag}`, '');

        // ③ 시군구 원명/짧은명 keyword 검색 (hashtag에 없는 공고 보완)
        await callBizinfo(`${regionTag},${sizeTag}`, cityTag);
        if (cityFull !== cityTag) {
          await callBizinfo(`${regionTag},${sizeTag}`, cityFull);
        }
      }
      // ④ 시도 + 업종 keyword
      for (const kw of kwList) {
        await callBizinfo(`${regionTag},${sizeTag}`, kw);
      }
      // ⑤ 시도 전체 (업종 무관 일반 지원)
      await callBizinfo(`${regionTag},${sizeTag}`, '');
    } else {
      for (const kw of kwList) {
        await callBizinfo(sizeTag, kw);
      }
      await callBizinfo(sizeTag, '정책자금');
    }

    // ── 후처리 ──
    const ALL_REGIONS    = ['서울','부산','대구','인천','광주','대전','울산','세종','경기','강원','충북','충남','전북','전남','경북','경남','제주'];
    const matchWords     = industry ? (INDUSTRY_MATCH_WORDS[industry] || [industry]) : [];
    const goodRealms     = industry ? (INDUSTRY_REALMS[industry] || new Set()) : new Set();
    const isLifeIndustry = LIFE_INDUSTRIES.has(industry);

    const processed = results
      .map(item => {
        const tags     = item.hashtags || '';
        const jrsd     = (item.jrsdInsttNm || '') + (item.excInsttNm || '');
        const content  = (item.pblancNm + ' ' + (item.bsnsSumryCn || '') + ' ' + tags + ' ' + jrsd).toLowerCase();
        const realm    = item.pldirSportRealmLclasCodeNm || '';

        const regionCount       = ALL_REGIONS.filter(r => tags.includes(r)).length;
        const hasSelectedRegion = regionTag ? tags.includes(regionTag) : true;
        const isRegional        = hasSelectedRegion && regionCount <= 5;

        // 시군구 매칭: hashtag에 있거나 기관명/제목에 포함
        const hasCity = cityTag ? (
          tags.includes(cityTag) ||
          content.includes(cityTag.toLowerCase()) ||
          (cityFull !== cityTag && content.includes(cityFull.toLowerCase()))
        ) : false;

        // 업종 매칭: 키워드 매칭 OR 관련 realm
        const hasIndustry = matchWords.length === 0 || (
          matchWords.some(w => content.includes(w.toLowerCase())) ||
          goodRealms.has(realm)
        );

        return {
          ...item,
          _isRegional: isRegional,
          _hasRegion: hasSelectedRegion,
          _hasCity: hasCity,
          _hasIndustry: hasIndustry,
          _realm: realm
        };
      })
      .filter(item => {
        if (!item._hasRegion) return false;
        // 생활업종: 기술·수출 realm이고 업종 키워드도 없으면 제외
        if (isLifeIndustry && TECH_REALMS.has(item._realm) &&
            !matchWords.some(w => (item.pblancNm || '').toLowerCase().includes(w))) return false;
        return true;
      });

    // 정렬: 시군구매칭(8) + 지역특화(4) + 업종매칭(2) + 기관명시군구일치(1)
    processed.sort((a, b) => {
      const jrsdA = ((a.jrsdInsttNm || '') + (a.excInsttNm || '')).toLowerCase();
      const jrsdB = ((b.jrsdInsttNm || '') + (b.excInsttNm || '')).toLowerCase();
      const cityMatch = cityTag.toLowerCase();
      const scoreA = (a._hasCity ? 8 : 0) + (a._isRegional ? 4 : 0) + (a._hasIndustry ? 2 : 0)
                   + (cityMatch && jrsdA.includes(cityMatch) ? 1 : 0);
      const scoreB = (b._hasCity ? 8 : 0) + (b._isRegional ? 4 : 0) + (b._hasIndustry ? 2 : 0)
                   + (cityMatch && jrsdB.includes(cityMatch) ? 1 : 0);
      return scoreB - scoreA;
    });

    res.json({ success: true, total: processed.length, data: processed });
  } catch (err) {
    console.error('[오류]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// 국세청 사업자 상태 조회
// ─────────────────────────────────────────────
app.post('/api/business-status', async (req, res) => {
  const { businessNumber } = req.body;
  const bNo = (businessNumber || '').replace(/-/g, '').trim();

  if (!bNo || bNo.length !== 10) {
    return res.status(400).json({ success: false, error: '사업자번호 10자리를 입력하세요.' });
  }

  try {
    const url = `https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=${encodeURIComponent(NTS_API_KEY)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ b_no: [bNo] }),
      timeout: 8000
    });
    if (!response.ok) throw new Error(`국세청 API HTTP ${response.status}`);
    const data = await response.json();
    res.json({ success: true, data });
  } catch (err) {
    console.error('[국세청 오류]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ 정책자금 매칭 서비스 실행 중`);
  console.log(`   http://localhost:${PORT}\n`);
});
