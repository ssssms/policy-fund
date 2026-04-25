// 산업통상자원부 공고 크롤링 → motie-data.json 저장
const fetch = require('node-fetch');
const fs = require('fs');

async function fetchPage(pageIndex) {
  const url = `https://www.motie.go.kr/kor/article/ATCLc01b2801b?pageIndex=${pageIndex}`;
  const res = await fetch(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    redirect: 'follow'
  });
  return res.text();
}

async function crawl() {
  const results = [];
  const seen = new Set();

  for (let page = 1; page <= 5; page++) {
    try {
      const html = await fetchPage(page);
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
              _source: 'motie'
            });
          }
        }
      }
    } catch (err) {
      console.error(`page ${page} error:`, err.message);
    }
  }

  const output = { updatedAt: new Date().toISOString(), total: results.length, data: results };
  fs.writeFileSync('motie-data.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log(`motie-data.json saved: ${results.length}건 (${output.updatedAt})`);
}

crawl();
