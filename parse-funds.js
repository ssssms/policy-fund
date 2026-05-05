#!/usr/bin/env node
/**
 * parse-funds.js
 *
 * 4개 정책자금 데이터 소스(gov24, shinbo, motie, onlending)의 공고를
 * Claude로 파싱하여 구조화된 매칭용 태그(자격/한도/특수자격/요약)를 추출한다.
 *
 * 사용법:
 *   node parse-funds.js              # 전체 (이미 파싱된 건 스킵)
 *   node parse-funds.js --sample 5   # 5건만 테스트
 *   node parse-funds.js --force      # 기존 결과 무시하고 전부 재파싱
 *   node parse-funds.js --concurrency 3
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk').default;

const ROOT = __dirname;
const MODEL = 'claude-sonnet-4-6';

// ── CLI 인자 파싱 ──
const args = process.argv.slice(2);
const argVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const SAMPLE = argVal('--sample') ? parseInt(argVal('--sample'), 10) : null;
const FORCE = args.includes('--force');
const CONCURRENCY = argVal('--concurrency') ? parseInt(argVal('--concurrency'), 10) : 5;
const OUTPUT_FILE = path.join(ROOT, argVal('--output') || 'parsed-funds.json');

// ── API 키 ──
if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('여기에')) {
  console.error('❌ ANTHROPIC_API_KEY 가 .env 에 설정되지 않았습니다.');
  process.exit(1);
}
const anthropic = new Anthropic();

// ── 데이터 소스 로드 ──
function loadAllFunds() {
  const sources = [
    { file: 'gov24-data.json', source: 'gov24' },
    { file: 'shinbo-data.json', source: 'shinbo' },
    { file: 'motie-data.json', source: 'motie' },
    { file: 'kosmes-data.json', source: 'kosmes' },
  ];
  const all = [];
  for (const { file, source } of sources) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    const items = Array.isArray(obj?.data) ? obj.data : [];
    for (const it of items) {
      all.push({ ...it, _source: it._source || source });
    }
  }
  // onlending(도매금융)은 별도 구조 — 그대로 추가
  const onlendingP = path.join(ROOT, 'onlending-data.json');
  if (fs.existsSync(onlendingP)) {
    const obj = JSON.parse(fs.readFileSync(onlendingP, 'utf8'));
    for (const p of (obj.products || [])) {
      all.push({
        pblancId: `ONLENDING_${p.code}`,
        pblancNm: p.name,
        bsnsSumryCn: [p.tagline, p.summary, (p.benefits || []).join(' / ')].filter(Boolean).join(' / '),
        jrsdInsttNm: p.provider || '한국은행/산업은행',
        excInsttNm: 'iM뱅크',
        reqstBeginEndDe: p.windowText || '상시',
        pblancUrl: p.sourceUrl || '',
        hashtags: [p.code, '도매금융'].join(','),
        pldirSportRealmLclasCodeNm: '금융',
        trgetNm: p.target || '',
        _source: 'onlending',
      });
    }
  }
  return all;
}

// ── 기존 결과 로드 (idempotent) ──
function loadExistingParsed() {
  if (FORCE || !fs.existsSync(OUTPUT_FILE)) return { items: {}, updatedAt: null };
  try {
    const obj = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    return obj && typeof obj === 'object' ? obj : { items: {}, updatedAt: null };
  } catch (e) {
    console.warn('⚠️ 기존 parsed-funds.json 읽기 실패, 빈 상태로 시작:', e.message);
    return { items: {}, updatedAt: null };
  }
}

// ── LLM 파싱용 tool 스키마 (강제 구조화 출력) ──
const PARSE_TOOL = {
  name: 'extract_fund_metadata',
  description: '정책자금 공고의 비정형 텍스트에서 매칭에 필요한 구조화된 메타데이터를 추출합니다.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: '소상공인 사장님이 한눈에 이해할 50~80자 요약. 어떤 자금인지 핵심만.',
      },
      matchReason: {
        type: 'string',
        description: '"~한 사장님께 적합" 형식 1줄 추천 사유 (예: "재해 피해 입은 소상공인께 적합")',
      },
      businessSize: {
        type: 'array',
        items: { type: 'string', enum: ['소상공인', '중소기업', '중견기업', '대기업', '예비창업자', '제한없음'] },
        description: '신청 가능한 사업자 규모. 명시 없으면 ["제한없음"].',
      },
      industries: {
        type: 'array',
        items: { type: 'string' },
        description: '대상 업종 카테고리 (한글 명사). 음식/소매/미용/세탁/제조/IT/기술/서비스/건설/농업/창업/수출/문화 등. 업종 무관이면 ["전업종"].',
      },
      supportType: {
        type: 'array',
        items: { type: 'string', enum: ['융자', '보조금', '보증', '이차보전', '투자', '컨설팅', '교육', '바우처', '시설지원', '기타'] },
        description: '지원 형태. 본문 또는 제목 단서로 추정.',
      },
      specialGroups: {
        type: 'array',
        items: { type: 'string' },
        description: '특수자격(우대 또는 한정) — 청년/여성/장애인/고령자/재해피해/저신용/저소득/북한이탈주민/다문화/한부모/예비창업/기존사업자/사회적기업/소셜벤처/혁신창업/기술창업 등. 없으면 [].',
      },
      ageRange: {
        type: ['string', 'null'],
        description: '연령 한정 조건. 예: "만 39세 이하", "만 65세 이하". 없으면 null.',
      },
      salesLimit: {
        type: ['string', 'null'],
        description: '매출 한도 조건. 예: "연매출 5억 이하". 없으면 null.',
      },
      businessAgeRange: {
        type: ['string', 'null'],
        description: '사업기간 한정. 예: "창업 3년 이내", "사업개시 7년 이내". 없으면 null.',
      },
      regions: {
        type: 'array',
        items: { type: 'string' },
        description: '지역 한정. 예: ["대구"], ["서울 강남구"]. 전국 또는 명시 없으면 ["전국"].',
      },
      amountText: {
        type: ['string', 'null'],
        description: '지원 한도 한 줄. 예: "최대 1억원", "융자 5천만원". 없으면 null.',
      },
      isAlwaysOpen: {
        type: 'boolean',
        description: '"상시" 또는 연중 신청 가능이면 true.',
      },
      applicationStatusHint: {
        type: 'string',
        enum: ['open', 'closed', 'verify_at_branch', 'unknown'],
        description: 'open=신청 가능 / closed=마감 / verify_at_branch=영업점 확인 / unknown=확인 불가',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '자유 검색용 추가 키워드 5~10개 (예: "탄소중립","수출지원","재해특례").',
      },
      requirement: {
        type: 'object',
        description: '각 자격 항목의 "필수성" 분류. 잘못된 거절(false ❌) 방지를 위해 분류 모호 시 preference 또는 null로 보수적으로 분류.',
        properties: {
          ageRange: {
            type: ['string', 'null'],
            description: 'ageRange 자격의 필수성. "required" | "preference" | "conditional" | null. ageRange가 null이면 이것도 null.',
          },
          businessAgeRange: {
            type: ['string', 'null'],
            description: 'businessAgeRange 자격의 필수성. 같은 4값.',
          },
          salesLimit: {
            type: ['string', 'null'],
            description: 'salesLimit 자격의 필수성. 같은 4값.',
          },
          businessSize: {
            type: ['string', 'null'],
            description: 'businessSize 자격의 필수성. "required"|"preference"|null. (보통 자금별 핵심 정의는 required).',
          },
          specialGroups: {
            type: 'object',
            description: 'specialGroups 배열의 각 자격별 필수성 매핑. 예: {"청년": "required", "여성": "preference"}. 모든 값은 "required"|"preference"|"conditional".',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['ageRange', 'businessAgeRange', 'salesLimit', 'businessSize', 'specialGroups'],
      },
      scopeNote: {
        type: ['string', 'null'],
        description: 'conditional 자격이 있을 때 "어떤 트랙·프로그램 한정인지" 1줄 보충. 예: "ageRange는 청년그린창업 트랙만 / businessAgeRange는 에코스타트업 트랙만". 없으면 null.',
      },
    },
    required: ['summary', 'matchReason', 'businessSize', 'industries', 'supportType', 'specialGroups', 'regions', 'isAlwaysOpen', 'applicationStatusHint', 'keywords', 'requirement', 'scopeNote'],
  },
};

const SYSTEM_PROMPT = [
  {
    type: 'text',
    text: `당신은 한국 정부·지자체 정책자금 공고를 분석해 소상공인이 매칭에 활용할 구조화 메타데이터를 추출하는 전문가입니다.

**최우선 원칙**: 잘못된 거절(false ❌)이 잘못된 승인(false ✅)보다 더 큰 손해입니다. 자격 분류가 모호하면 보수적으로 "preference" 또는 null로 분류하세요. 절대 추측하지 마세요.

═══ 기본 추출 원칙 ═══
1. **추측 금지**: 본문에 명시되지 않은 조건은 null/빈배열.
2. **소상공인 관점**: 사장님이 자기 사업에 해당하는지 판단할 수 있도록 산업/규모/지역 태그를 풍부하게 답니다.
3. **summary는 50~80자**: 핵심 한 줄. "~을 위한 ~지원" 형식 권장.
4. **matchReason**: "~사장님께 적합" 형식. 가장 강한 매칭 포인트 한 가지만.
5. **industries**: 본문에서 직간접 단서로 추론. "외식 프랜차이즈"면 ["음식","외식","프랜차이즈"] 처럼 다양하게.
6. **applicationStatusHint**:
   - 본문에 "상시" 또는 reqstBeginEndDe가 "상시"면 open.
   - 도매금융(C1)처럼 "영업점 상담"이면 verify_at_branch.
   - 마감일이 명확히 과거이거나 "마감"이면 closed.
   - 그 외 미확정은 unknown.

═══ requirement 객체 — 자격의 "필수성" 분류 (핵심 신규 기능) ═══

각 자격 항목(ageRange / businessAgeRange / salesLimit / businessSize / 각 specialGroup)에 대해 다음 4값 중 하나로 분류합니다:

▶ **required** (필수, 미충족 시 신청 불가)
  - 한국어 패턴:
    "~인 자에 한해 신청", "대상은 ○○", "○○만 신청 가능", "○○에 한정",
    "○○ 자격을 갖춘 자", "○○인 기업/사업자에게 지원"
  - 자격이 자금의 핵심 정의일 때
  - 예: "대표자가 만 39세 이하인 중소기업" → ageRange="required"
  - 예: "재해 피해를 입은 기업" → specialGroups.재해피해="required"
  - 예: "사업개시 7년 이내" + 다른 일반 자격 명시 없음 → businessAgeRange="required"

▶ **preference** (우대, 미충족 시 가산점만 없음, 신청 가능)
  - 한국어 패턴:
    "○○ 우대", "○○ 우선", "○○ 가산점", "○○ 가점",
    "○○ 시 가점 부여", "특히 ○○인 경우"
  - 일반 자격 + 특정 그룹 우대 패턴
  - 예: "소상공인 대상, 여성기업 우대" → specialGroups.여성="preference"
  - 예: "중소기업 대상, 청년창업 가점" → specialGroups.청년="preference"

▶ **conditional** (일부 프로그램·트랙·세부사업만 해당)
  - 한국어 패턴:
    "(○○ 한정)", "○○ 트랙의 경우", "○○ 프로그램은",
    "세부사업별로 ~", "○○ 부문 한정"
  - 자금이 여러 프로그램으로 구성되며 일부만 자격 한정
  - 예: "사업화 지원 / 에코스타트업(7년 이내) / 청년그린창업(39세 이하)"
       → ageRange="conditional", businessAgeRange="conditional"
  - scopeNote에 "에코스타트업 트랙 한정 / 사업화 지원은 일반" 같이 보충

▶ **null** (조건 자체가 본문에 명시되지 않음 또는 분류 모호)
  - 추측 금지. 본문에 단서 없으면 null.
  - 해당 필드(예: ageRange)가 null이면 requirement.ageRange도 null.

═══ 모호한 케이스 가이드 ═══

| 표현 | 분류 | 이유 |
|---|---|---|
| "청년 우선 지원" | preference | "우선"은 가산점/우대 의미 |
| "청년 한정" | required | "한정"은 필수 |
| "청년에게 적합한 사업" | preference | 권유성 표현 |
| "○○인 자에게 우선 지원" | preference | "우선" 키워드 |
| "○○인 자에 한정" | required | "한정" 키워드 |
| "○○인 자가 신청 가능" + 다른 일반 자격 명시 | preference | 일반인도 가능 |
| "○○인 자가 신청 가능" + 다른 자격 명시 없음 | required | 핵심 정의 |
| "○○인 경우 추가 지원" | preference | 추가/부가 |
| "원칙적으로 ○○" | required | "원칙" = 핵심 |
| "특별히 ○○" | preference | 가점성 |

═══ 처리 절차 ═══

1. 본문에서 자격 조건들을 모두 추출하여 기존 필드(specialGroups·ageRange·…)에 저장
2. 각 자격에 대해 위 키워드/패턴으로 분류 → requirement 객체에 매핑
3. 분류가 명확하지 않으면 **preference** 또는 **null** (보수적, 추측 X)
4. specialGroups 배열은 모든 관련 자격, requirement.specialGroups 객체는 각 자격별 분류
5. scopeNote: conditional 케이스에서 "어떤 프로그램이 한정인지" 한 줄 보충

═══ 예시 1: 청년전용창업자금 (한정 자금) ═══
원본: "대표자가 만 39세 이하로 사업 개시일로부터 3년 미만인 중소기업"

추출:
{
  "summary": "만 39세 이하 청년 + 창업 3년 미만 중소기업 전용 융자",
  "matchReason": "만 39세 이하 청년 + 창업 3년 미만 둘 다 충족하는 사장님께 적합",
  "specialGroups": ["청년"],
  "ageRange": "만 39세 이하",
  "businessAgeRange": "창업 3년 미만",
  "businessSize": ["중소기업"],
  "regions": ["전국"], "industries": ["전업종"], "supportType": ["융자"],
  "isAlwaysOpen": false, "applicationStatusHint": "unknown",
  "keywords": ["청년창업","청년전용","융자","39세이하"],
  "requirement": {
    "ageRange": "required",
    "businessAgeRange": "required",
    "salesLimit": null,
    "businessSize": "required",
    "specialGroups": { "청년": "required" }
  },
  "scopeNote": null
}

═══ 예시 2: 일반 보증 + 여성 우대 ═══
원본: "대구 소재 소상공인 대상 보증, 여성기업 우대"

추출:
{
  "summary": "대구 소상공인 신용보증 (여성기업 우대)",
  "matchReason": "대구 소재 소상공인 사장님께 적합 (여성기업이면 추가 우대)",
  "specialGroups": ["여성"],
  "ageRange": null, "salesLimit": null, "businessAgeRange": null,
  "businessSize": ["소상공인"],
  "regions": ["대구"], "industries": ["전업종"], "supportType": ["보증"],
  "isAlwaysOpen": false, "applicationStatusHint": "unknown",
  "keywords": ["대구","보증","여성기업"],
  "requirement": {
    "ageRange": null,
    "businessAgeRange": null,
    "salesLimit": null,
    "businessSize": "required",
    "specialGroups": { "여성": "preference" }
  },
  "scopeNote": null
}

═══ 예시 3: 다중 트랙 자금 (conditional) ═══
원본: "사업화 지원(우수 중소환경기업) / 에코스타트업(예비창업자 또는 7년 이내) / 청년그린창업(39세 이하)"

추출:
{
  "summary": "환경·녹색산업 분야 중소환경기업·예비창업자·청년창업 사업화 지원 (3개 프로그램)",
  "matchReason": "환경·녹색산업 분야 중소기업 또는 청년 창업자께 적합 (트랙 분리)",
  "specialGroups": ["청년","예비창업자"],
  "ageRange": "만 39세 이하 (청년그린창업 한정)",
  "businessAgeRange": "창업 7년 이내 (에코스타트업 한정)",
  "businessSize": ["중소기업","예비창업자"],
  "regions": ["전국"], "industries": ["환경","녹색산업"], "supportType": ["보조금","컨설팅"],
  "isAlwaysOpen": false, "applicationStatusHint": "unknown",
  "keywords": ["환경","녹색산업","에코스타트업","청년그린창업"],
  "requirement": {
    "ageRange": "conditional",
    "businessAgeRange": "conditional",
    "salesLimit": null,
    "businessSize": "preference",
    "specialGroups": { "청년": "conditional", "예비창업자": "conditional" }
  },
  "scopeNote": "ageRange는 청년그린창업 트랙만 / businessAgeRange는 에코스타트업 트랙만 / 사업화 지원은 일반"
}

반드시 extract_fund_metadata 도구를 호출해 결과를 반환합니다. 절대 일반 텍스트로 답변하지 마세요.`,
    cache_control: { type: 'ephemeral' },
  },
];

// ── 공고 1건 → 텍스트 입력 ──
function fundToInput(f) {
  const lines = [
    `[제목] ${f.pblancNm || ''}`,
    `[주관기관] ${f.jrsdInsttNm || ''} / [시행기관] ${f.excInsttNm || ''}`,
    `[지원분야] ${f.pldirSportRealmLclasCodeNm || ''}`,
    `[해시태그] ${f.hashtags || ''}`,
    `[사업요약] ${f.bsnsSumryCn || ''}`,
    `[신청대상] ${f.trgetNm || ''}`,
    `[신청기간] ${f.reqstBeginEndDe || ''}`,
    `[데이터소스] ${f._source || ''}`,
    f._region ? `[지역힌트] ${f._region} ${f._city || ''}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

// ── LLM 호출 (재시도 포함) ──
async function parseFund(fund, attempt = 1) {
  const maxAttempts = 3;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [PARSE_TOOL],
      tool_choice: { type: 'tool', name: 'extract_fund_metadata' },
      messages: [{ role: 'user', content: fundToInput(fund) }],
    });

    const toolUse = resp.content.find((c) => c.type === 'tool_use');
    if (!toolUse) throw new Error('도구 호출 응답 없음');

    return {
      ok: true,
      meta: toolUse.input,
      usage: resp.usage,
    };
  } catch (err) {
    if (attempt < maxAttempts) {
      const wait = 1000 * Math.pow(2, attempt - 1);
      console.warn(`  ⚠️ ${fund.pblancId} 재시도 ${attempt}/${maxAttempts} (${err.message})`);
      await new Promise((r) => setTimeout(r, wait));
      return parseFund(fund, attempt + 1);
    }
    return { ok: false, error: err.message };
  }
}

// ── 동시성 제한 처리 ──
async function processWithConcurrency(items, worker, concurrency, onProgress) {
  const results = [];
  let idx = 0;
  let done = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      const r = await worker(items[i], i);
      results[i] = r;
      done++;
      if (onProgress) onProgress(done, items.length, items[i], r);
    }
  });
  await Promise.all(runners);
  return results;
}

// ── 메인 ──
(async () => {
  console.log(`▶️ parse-funds.js 시작 — model: ${MODEL}, concurrency: ${CONCURRENCY}`);
  const allFunds = loadAllFunds();
  console.log(`📚 전체 공고 수: ${allFunds.length}`);

  const existing = loadExistingParsed();
  const existingIds = new Set(Object.keys(existing.items));

  let targets = allFunds.filter((f) => f.pblancId && (FORCE || !existingIds.has(f.pblancId)));
  if (SAMPLE !== null && SAMPLE > 0) {
    // 다양한 소스에서 샘플
    const bySource = {};
    for (const f of targets) {
      bySource[f._source] = bySource[f._source] || [];
      bySource[f._source].push(f);
    }
    const sampled = [];
    const sources = Object.keys(bySource);
    while (sampled.length < SAMPLE) {
      let added = false;
      for (const s of sources) {
        if (sampled.length >= SAMPLE) break;
        const next = bySource[s].shift();
        if (next) { sampled.push(next); added = true; }
      }
      if (!added) break;
    }
    targets = sampled;
    console.log(`🧪 샘플 모드: ${targets.length}건만 처리`);
  }

  console.log(`🎯 처리 대상: ${targets.length}건 (스킵: ${allFunds.length - targets.length}건 — 이미 파싱됨)`);
  if (targets.length === 0) {
    console.log('✅ 처리할 항목 없음. 종료.');
    return;
  }

  const startTime = Date.now();
  let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0;
  let fails = 0;

  const items = { ...existing.items };

  // 5건마다 incremental 저장
  const saveInterval = Math.max(5, Math.floor(targets.length / 20));

  const results = await processWithConcurrency(
    targets,
    async (fund) => {
      const r = await parseFund(fund);
      if (r.ok) {
        items[fund.pblancId] = {
          pblancId: fund.pblancId,
          source: fund._source,
          parsedAt: new Date().toISOString(),
          ...r.meta,
        };
        if (r.usage) {
          totalIn += r.usage.input_tokens || 0;
          totalOut += r.usage.output_tokens || 0;
          totalCacheRead += r.usage.cache_read_input_tokens || 0;
          totalCacheWrite += r.usage.cache_creation_input_tokens || 0;
        }
      } else {
        fails++;
      }
      return r;
    },
    CONCURRENCY,
    (done, total, fund, r) => {
      const tag = r.ok ? '✓' : '✗';
      const title = (fund.pblancNm || '').slice(0, 35);
      process.stdout.write(`  [${done}/${total}] ${tag} ${fund.pblancId} ${title}\n`);
      if (done % saveInterval === 0) {
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2));
      }
    }
  );

  // 최종 저장
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  // Sonnet 4.6 가격: input $3/1M, output $15/1M, cache_read $0.30/1M, cache_write $3.75/1M
  const cost =
    (totalIn / 1e6) * 3 +
    (totalOut / 1e6) * 15 +
    (totalCacheRead / 1e6) * 0.3 +
    (totalCacheWrite / 1e6) * 3.75;

  console.log(`\n=== 완료 ===`);
  console.log(`소요시간: ${elapsed}s`);
  console.log(`성공: ${targets.length - fails} / 실패: ${fails}`);
  console.log(`토큰 — input: ${totalIn} / output: ${totalOut} / cache_read: ${totalCacheRead} / cache_write: ${totalCacheWrite}`);
  console.log(`예상 비용: $${cost.toFixed(4)}`);
  console.log(`결과 파일: ${OUTPUT_FILE} (${Object.keys(items).length}건 누적)`);
})();
