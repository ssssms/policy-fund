// 산업통상자원부 공고 크롤링 → motie-data.json 저장
// 1단계: 목록 5페이지 → 관련 공고 ID 수집
// 2단계: 각 공고 상세 페이지 fetch → 본문/담당부서/지원대상/마감일 보강
const fetch = require('node-fetch');
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (PolicyFund-Research)';
const DETAIL_DELAY_MS = 800;       // 상세 페이지 사이 딜레이 (서버 보호)
const DETAIL_TIMEOUT_MS = 20000;
const LIST_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchListing(pageIndex) {
  const url = `https://www.motie.go.kr/kor/article/ATCLc01b2801b?pageIndex=${pageIndex}`;
  const res = await fetch(url, { timeout: LIST_TIMEOUT_MS, headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`listing HTTP ${res.status}`);
  return res.text();
}

async function fetchDetail(id) {
  const url = `https://www.motie.go.kr/kor/article/ATCLc01b2801b/${id}/view`;
  const res = await fetch(url, { timeout: DETAIL_TIMEOUT_MS, headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`detail HTTP ${res.status}`);
  return res.text();
}

// HTML → 평문 텍스트
function cleanText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// detail-cont 내부 본문만 추출
function extractDetailCont(html) {
  const m = html.match(/<div class="detail-cont">([\s\S]*?)(?:<!-- \/\/게시판 상세보기 -->|<div class="board-button">)/);
  if (!m) return '';
  return cleanText(m[1]);
}

// 담당부서·공고번호 추출
function extractMeta(html) {
  const out = { dept: '', pblancNo: '', regDate: '' };
  const infoMatch = html.match(/<div class="detail-info">([\s\S]*?)<\/div>/);
  const info = infoMatch ? infoMatch[1] : html;
  const grab = (label) => {
    const re = new RegExp(`<em>\\s*${label}\\s*<\\/em>\\s*<span>([^<]+)<\\/span>`);
    const mm = info.match(re);
    return mm ? mm[1].trim() : '';
  };
  out.dept     = grab('담당부서');
  out.pblancNo = grab('공고번호');
  out.regDate  = grab('등록일');
  return out;
}

// 본문에서 "지원대상" 섹션 추출 시도
// 보수적: 명백한 라벨 + 콜론·줄바꿈 다음 내용만 추출.
// 부조리한 시작어(및/또는/그/본 ~)로 시작하면 거름 (헤더 단편 잘못 매칭 방지)
function extractTarget(text) {
  if (!text) return '';
  const labels = ['신청자격', '신청대상', '지원대상', '참여자격', '지원자격', '대상기관', '신청\\s*기관'];
  for (const lab of labels) {
    // 라벨 뒤에 콜론(:/：) 또는 줄바꿈이 반드시 와야 매칭
    const re = new RegExp(`${lab}[\\s\\d\\.\\)]*[:：\\n]([\\s\\S]{20,500}?)(?:\\n[\\s\\d\\.\\)]*(?:지원\\s*내용|지원\\s*규모|지원\\s*분야|신청\\s*방법|선정\\s*절차|선정\\s*방법|평가|사업\\s*기간|문의|첨부|기타|제출|일정|공고)|$)`);
    const m = text.match(re);
    if (!m) continue;
    let v = m[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    // 부조리한 시작어 거르기 — 헤더 단편 잘못 매칭 방지
    if (/^(및|또는|그|본|이|위|아래|등|을|를|에|의|는|이라|한다|함\s)/.test(v)) continue;
    if (v.length < 20) continue;
    return v.slice(0, 400);
  }
  return '';
}

// 본문에서 마감일 추출 시도
function extractDeadline(text) {
  if (!text) return '';
  // YYYY.M.D., YYYY-MM-DD, YYYY년 M월 D일 까지/마감
  const patterns = [
    /(\d{4})\s*[\.\-년]\s*(\d{1,2})\s*[\.\-월]\s*(\d{1,2})\s*[일\.]?\s*(?:까지|마감|기한|한)/,
    /접수\s*기간[^0-9]{0,50}~\s*(\d{4})\s*[\.\-년]\s*(\d{1,2})\s*[\.\-월]\s*(\d{1,2})/,
    /신청\s*기간[^0-9]{0,50}~\s*(\d{4})\s*[\.\-년]\s*(\d{1,2})\s*[\.\-월]\s*(\d{1,2})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const y = m[1], mo = m[2].padStart(2, '0'), d = m[3].padStart(2, '0');
      return `${y}-${mo}-${d}`;
    }
  }
  return '';
}

async function crawl() {
  const results = [];
  const seen = new Set();

  // ─ 1단계: 목록 페이지에서 ID·제목·등록일 수집 ─
  for (let page = 1; page <= 5; page++) {
    try {
      const html = await fetchListing(page);
      const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
      let m;
      while ((m = trRegex.exec(html)) !== null) {
        const tr = m[1];
        const viewMatch = tr.match(/article\.view\('(\d+)'\)/);
        const titleMatch = tr.match(/<i>([\s\S]*?)<\/i>/);
        const dateMatch = tr.match(/<td>(\d{4}-\d{2}-\d{2})<\/td>/);
        if (viewMatch && titleMatch) {
          const id = viewMatch[1];
          const title = titleMatch[1].trim();
          const isRelevant = /지원|보전|융자|보증|자금|수급/.test(title)
                          && !/채용|합격|입법예고|인사|임기제|전입|포상/.test(title);
          if (isRelevant && !seen.has(id)) {
            seen.add(id);
            results.push({
              pblancNm: title,
              bsnsSumryCn: '',
              jrsdInsttNm: '산업통상자원부',
              excInsttNm: '',
              reqstBeginEndDe: dateMatch ? dateMatch[1] : '상시',
              pblancUrl: `https://www.motie.go.kr/kor/article/ATCLc01b2801b/${id}/view`,
              pblancId: 'MOTIE_' + id,
              hashtags: '',
              pldirSportRealmLclasCodeNm: '',
              trgetNm: '',
              _source: 'motie',
            });
          }
        }
      }
      console.log(`[목록] page ${page}: 누적 ${results.length}건`);
    } catch (err) {
      console.error(`[목록] page ${page} error:`, err.message);
    }
  }

  console.log(`\n[상세] ${results.length}건 본문 보강 시작 (딜레이 ${DETAIL_DELAY_MS}ms)...`);
  let detailOk = 0, detailFail = 0;

  // ─ 2단계: 각 공고 상세 페이지에서 본문·담당부서·지원대상·마감일 보강 ─
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const id = item.pblancId.replace(/^MOTIE_/, '');
    try {
      const html = await fetchDetail(id);
      const meta = extractMeta(html);
      const body = extractDetailCont(html);

      if (meta.dept) item.excInsttNm = meta.dept;
      if (meta.pblancNo) item.pblancNo = meta.pblancNo;

      if (body) {
        item.bsnsSumryCn = body.slice(0, 1500);  // 너무 길면 자름
        const target = extractTarget(body);
        if (target) item.trgetNm = target;
        const deadline = extractDeadline(body);
        if (deadline && /^\d{4}-\d{2}-\d{2}$/.test(item.reqstBeginEndDe)) {
          item.reqstBeginEndDe = `${item.reqstBeginEndDe} ~ ${deadline}`;
        }
      }

      detailOk++;
      console.log(`  [${i + 1}/${results.length}] ✓ ${id} (${meta.dept || '-'}, body ${body.length}자, target ${(item.trgetNm || '').length}자)`);
    } catch (err) {
      detailFail++;
      console.error(`  [${i + 1}/${results.length}] ✗ ${id} 본문 실패: ${err.message} — 목록 정보만 유지`);
    }
    if (i < results.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  const output = { updatedAt: new Date().toISOString(), total: results.length, data: results };
  fs.writeFileSync('motie-data.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nmotie-data.json saved: ${results.length}건 (본문 성공 ${detailOk}, 실패 ${detailFail}) (${output.updatedAt})`);
}

crawl();
