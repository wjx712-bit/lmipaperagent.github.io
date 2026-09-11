import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(process.env.LMI_NODE_MODULES ? path.join(process.env.LMI_NODE_MODULES, '_admin-test.cjs') : import.meta.url);
const { chromium } = require('playwright');
const baseUrl = process.env.LMI_UI_URL || 'http://127.0.0.1:8793/';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'Local test doubles only');
const dataset = JSON.parse(await readFile('public/data/papers.json', 'utf8'));
const rows = dataset.papers.slice(0, 1100).map((paper, index) => ({ user_id: 'member', paper_id: paper.id, score: index % 2 ? 3 : 1, note: index === 0 ? '=HYPERLINK("https://example.test")' : 'Private member note', updated_at: '2026-09-09T00:00:00Z' }));
rows.push({ user_id: 'other', paper_id: rows[0].paper_id, score: 5, note: 'Other private note', updated_at: '2026-09-10T00:00:00Z' });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('.cache/ui-admin', { recursive: true });
const errors = [];
async function setup(role) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  // Any accidental real backend request fails this test and cannot touch production reviews.
  await page.route('https://*.supabase.co/**', route => { errors.push('Unexpected real Supabase request'); return route.abort(); });
  await page.addInitScript(({ role, rows }) => { window.__role = role; window.__rows = rows; window.__calls = []; window.__denyAdmin = false; window.__failPage = false; }, { role, rows });
  await page.route(/\/src\/useAuth\.js(\?.*)?$/, async (route) => {
    const original = await (await route.fetch()).text();
    const reactUrl = original.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    assert.ok(reactUrl);
    await route.fulfill({ contentType: 'text/javascript', body: `
      import React from ${JSON.stringify(reactUrl)};
      export function useAuth() {
        const [role, setRole] = React.useState(window.__role);
        React.useEffect(() => { window.__setRole = setRole; }, []);
        const signedIn = role !== 'anonymous';
        return { configured: true, loading: false, error: '',
          user: signedIn ? { id: role, email: role + '@example.test', user_metadata: {} } : null,
          profile: signedIn ? { id: role, display_name: role, role, status: role === 'pending' ? 'pending' : 'approved' } : null,
          isApproved: signedIn && role !== 'pending', isAdmin: role === 'admin',
          signInWithGoogle() {}, refreshProfile() {}, signOut() { setRole('anonymous'); }
        };
      }` });
  });
  await page.route(/\/src\/supabase(?:\.js)?(\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `
    export const supabase = {
      async rpc(name, args) {
        window.__calls.push({rpc:name});
        if (name === 'review_completion') {
          const papers = [...new Set(window.__rows.filter(row => args.requested_paper_ids.includes(row.paper_id)).map(row => row.paper_id))].map(paper_id => ({paper_id, topics: [], other_topics: [], other_unattributed: true}));
          return {data: {version:1,papers}, error:null};
        }
        return {data:!window.__denyAdmin,error:null};
      },
      from(table) {
        let from=0,to=999,userId,cursor,order=[];
        return { select(){return this}, order(key){order.push(key);return this}, eq(key,value){userId=value;return this},
          gt(key,value){cursor=[value];return this},
          or(value){const values=[...value.matchAll(/"(?:\\\\.|[^"\\\\])*"/g)].map(match=>JSON.parse(match[0]));cursor=[values[0],values[2]];return this},
          range(a,b){from=a;to=b;return this},
          then(resolve) {
            window.__calls.push({table,from,to,userId});
            if(window.__failPage && (from>0||cursor)) return Promise.resolve({data:null,error:{message:'Later page failure'}}).then(resolve);
            const source=table==='profiles' ? ['admin','member','other'].map(id=>({id,email:id+'@example.test',display_name:id,status:'approved',role:id==='admin'?'admin':'member',created_at:'2026-09-01T00:00:00Z'})) : window.__rows.filter(row=>!userId||row.user_id===userId);
            source.sort((a,b)=>{for(const key of order){if(a[key]<b[key])return -1;if(a[key]>b[key])return 1}return 0});
            const filtered=source.filter(row=>!cursor||row[order[0]]>cursor[0]||(order.length===2&&row[order[0]]===cursor[0]&&row[order[1]]>cursor[1]));
            return Promise.resolve({data:filtered.slice(from,to+1),error:null}).then(resolve);
          },
          upsert(){ throw new Error('Unexpected write'); }
        }
      }
    };` }));
  await page.goto(baseUrl);
  await page.locator('.paper-row').first().waitFor();
  return { page, context };
}
async function openAdmin(page) {
  await page.locator('.account-button').click();
  await page.getByRole('button', { name: '평가 관리', exact: true }).click();
  await page.getByRole('heading', { name: '주제별 평가 현황' }).waitFor();
}
async function readDownload(page, name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const download = await pending;
  return readFile(await download.path(), 'utf8');
}

try {
  for (const role of ['anonymous', 'member', 'pending']) {
    const { page, context } = await setup(role);
    if (role !== 'anonymous') await page.locator('.account-button').click();
    assert.equal(await page.getByRole('button', { name: '평가 관리', exact: true }).count(), 0);
    assert.equal(await page.locator('.admin-panel').count(), 0);
    assert.equal(await page.getByRole('tab', { name: '새 분류 미리보기', exact: true }).count(), 0);
    assert.equal(await page.getByText('Other private note', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.__calls.some(call => call.table === 'profiles' || (call.rpc && call.rpc !== 'review_completion'))), false);
    await context.close();
  }
  console.log('PASS: anonymous/member/pending have no admin entry, data fetch, or private review leak');

  const { page, context } = await setup('admin');
  await openAdmin(page);
  assert.equal(await page.locator('.admin-summary > div').last().locator('strong').innerText(), '1,101');
  const topic = dataset.papers[0].topics[0];
  await page.getByLabel('관리자 주제 필터').selectOption(topic);
  const expected = rows.filter(row => dataset.papers.find(paper => paper.id === row.paper_id)?.topics.includes(topic));
  const payload = JSON.parse(await readDownload(page, '원점수 JSON'));
  assert.equal(payload.records.length, expected.length);
  assert.equal(payload.filters.paper_topic, topic);
  assert.ok(payload.records.every(row => row.review_topic === null && row.review_topic_status === 'not_recorded'));
  assert.ok(payload.records.some(row => row.note.startsWith('=HYPERLINK')));
  const csv = await readDownload(page, '원점수 CSV');
  assert.ok(csv.includes("'=HYPERLINK"));
  await page.getByLabel('관리자 저널 필터').selectOption(dataset.papers[0].journalShort);
  const journalPayload = JSON.parse(await readDownload(page, '원점수 JSON'));
  assert.ok(journalPayload.records.length > 0);
  assert.ok(journalPayload.records.every(row => row.journal === dataset.papers[0].journal));
  await page.getByLabel('관리자 저널 필터').selectOption('');
  await page.getByLabel('관리자 평가자 필터').selectOption('other');
  const ownPayload = JSON.parse(await readDownload(page, '원점수 JSON'));
  assert.equal(ownPayload.records.length, 1);
  await page.getByRole('tab', { name: '평가 불일치 후보', exact: true }).click();
  assert.equal(await page.locator('.disagreement-row').count(), 1);
  await page.getByText('1~5점 · 차이 4 · 우선 확인', { exact: true }).waitFor();
  assert.ok(await page.getByLabel('관리자 평가자 필터').isDisabled());
  assert.equal(await page.locator('.disagreement-row tbody tr').count(), 2);
  const report = await readDownload(page, '보고서');
  assert.ok(report.includes('기존 평가 경로와 기준 버전은 추정하지 않습니다'));
  assert.ok(report.includes('Other private note'));
  console.log('PASS: paginated admin data, topic/journal/reviewer exports, raw scores, CSV safety, disagreement across authors');

  await page.getByRole('tab', { name: '주제별 평가', exact: true }).click();
  await page.getByLabel('관리자 주제 필터').selectOption('');
  await page.getByLabel('관리자 평가자 필터').selectOption('');
  await page.getByLabel('관리자 주제 필터').selectOption('미분류');
  const unclassifiedReviews = JSON.parse(await readDownload(page, '원점수 JSON'));
  const unclassifiedIds = new Set(dataset.papers.filter(paper => paper.topics.includes('미분류')).map(paper => paper.id));
  assert.equal(unclassifiedIds.size, 17);
  assert.equal(unclassifiedReviews.records.length, rows.filter(row => unclassifiedIds.has(row.paper_id)).length);
  assert.ok(unclassifiedReviews.records.every(row => row.paper_topics.includes('미분류')));
  await page.getByLabel('관리자 주제 필터').selectOption('');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const tab of ['저널·주제 분포', '주제별 평가', '평가 불일치 후보', '분류 품질 보고서']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const dimensions = await page.evaluate(() => ({width:innerWidth,doc:document.documentElement.scrollWidth,body:document.querySelector('.admin-body').scrollWidth,client:document.querySelector('.admin-body').clientWidth}));
      assert.ok(dimensions.doc <= width + 1 && dimensions.body <= dimensions.client + 1, `${tab} ${JSON.stringify(dimensions)}`);
      if (width === 390 || width === 1440) await page.screenshot({ path: `.cache/ui-admin/${width}-${['저널·주제 분포','주제별 평가','평가 불일치 후보','분류 품질 보고서'].indexOf(tab)}.png` });
    }
  }
  await page.getByRole('tab', { name: '분류 품질 보고서', exact: true }).click();
  assert.ok(await page.getByRole('region', { name: '분류 품질 점검 항목', exact: true }).locator('tbody tr').count() > 0);
  const baselineStats = await page.locator('.stat-card').allTextContents();
  const baselineRows = await page.locator('.paper-row').allTextContents();
  const baselineReviews = await page.evaluate(() => JSON.stringify(window.__rows));
  await page.getByRole('tab', { name: '새 분류 미리보기', exact: true }).click();
  await page.locator('[data-preview-ready="true"]').waitFor({ timeout: 60000 });
  await page.getByText('실험용 분류 초안 · 운영 미적용', { exact: true }).waitFor();
  await page.getByLabel('미리보기 비교 범위').selectOption('all');
  const preview = JSON.parse(await readDownload(page, '근거 포함 JSON'));
  assert.equal(preview.records.length, dataset.papers.length);
  assert.equal(preview.applied, false);
  assert.equal(preview.reviewDataIncluded, false);
  assert.ok(!JSON.stringify(preview).includes('Private member note'));
  assert.ok(!JSON.stringify(preview).includes('Other private note'));
  assert.match(preview.inputHash, /^[a-f0-9]{64}$/);
  for (const row of preview.records) assert.deepEqual(row.oldTopics, dataset.papers.find(paper => paper.id === row.paperId).topics);
  const previewTopic = 'Adipose tissue / adipocyte biology';
  await page.getByLabel('미리보기 기존 주제').selectOption(previewTopic);
  const topicPreview = JSON.parse(await readDownload(page, '근거 포함 JSON'));
  assert.equal(topicPreview.records.length, dataset.papers.filter(paper => paper.topics.includes(previewTopic)).length);
  assert.ok(topicPreview.records.every(row => row.oldTopics.includes(previewTopic)));
  await page.getByLabel('미리보기 기존 주제').selectOption('');
  await page.getByLabel('미리보기 기존 주제').selectOption('__unclassified__');
  const unclassifiedPreview = JSON.parse(await readDownload(page, '근거 포함 JSON'));
  assert.equal(unclassifiedPreview.records.length, 17);
  assert.equal(unclassifiedPreview.summary.oldUnclassified, 17);
  await page.getByLabel('미리보기 기존 주제').selectOption('');
  const brainSource = dataset.papers.find(paper => paper.doi === '10.1038/s41467-026-77116-9');
  assert.ok(brainSource, 'Expected brain-metabolism regression sample in catalog');
  await page.getByLabel('미리보기 논문 검색').fill(brainSource.doi);
  assert.equal(await page.locator('.preview-paper').count(), 1);
  const brain = JSON.parse(await readDownload(page, '근거 포함 JSON')).records[0];
  assert.ok(!brain.coreTopics.includes('Liver metabolism / MASLD'));
  assert.ok(!brain.coreTopics.includes(previewTopic));
  await page.locator('.preview-evidence summary').first().click();
  const quotes = await page.locator('.preview-evidence blockquote').allTextContents();
  assert.ok(quotes.length > 0);
  for (const quote of quotes) assert.ok(brainSource.title.includes(quote) || brainSource.abstract.includes(quote));
  await page.locator('.preview-abstract summary').first().click();
  assert.equal(await page.locator('.preview-abstract [lang="en"]').innerText(), brainSource.abstract);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({width,height:1000});
    const dimensions = await page.evaluate(() => ({width:innerWidth,doc:document.documentElement.scrollWidth,body:document.querySelector('.admin-body').scrollWidth,client:document.querySelector('.admin-body').clientWidth}));
    assert.ok(dimensions.doc <= width + 1 && dimensions.body <= dimensions.client + 1, `Preview ${JSON.stringify(dimensions)}`);
    await page.locator('.preview-safety').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.cache/ui-admin/preview-${width}.png` });
    await page.locator('.preview-comparison').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.cache/ui-admin/preview-paper-${width}.png` });
  }
  await page.getByLabel('미리보기 논문 검색').fill('');
  await page.getByRole('button', { name: '미리보기 다음 페이지', exact: true }).click();
  assert.ok((await page.getByRole('navigation', { name: '미리보기 페이지' }).innerText()).includes('2 /'));
  await page.getByRole('button', { name: '미리보기 이전 페이지', exact: true }).click();
  await readDownload(page, '비교 CSV');
  assert.deepEqual(await page.locator('.stat-card').allTextContents(), baselineStats);
  assert.deepEqual(await page.locator('.paper-row').allTextContents(), baselineRows);
  assert.equal(await page.evaluate(() => JSON.stringify(window.__rows)), baselineReviews);
  assert.equal(await page.locator('.classification-preview').getByRole('button', { name: /적용|저장/ }).count(), 0);
  await page.getByRole('tab', { name: '주제별 평가', exact: true }).click();
  await page.getByRole('heading', { name: '주제별 평가 현황' }).waitFor();
  assert.equal(await page.locator('.admin-summary > div').last().locator('strong').innerText(), '1,101');
  console.log('PASS: isolated new-rule preview, all papers/old-topic filters, evidence, exports, mobile widths, no assignment or review changes');
  await page.evaluate(() => { window.__failPage = true; });
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Later page failure' }).waitFor();
  assert.equal(await page.locator('.admin-analytics').count(), 0, 'No partial export or false progress');
  await page.evaluate(() => { window.__failPage = false; window.__denyAdmin = true; });
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '관리자 권한' }).waitFor();
  assert.equal(await page.locator('.admin-analytics').count(), 0);
  await page.evaluate(() => { window.__denyAdmin = false; });
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.locator('.admin-analytics').waitFor();
  await page.evaluate(() => window.__setRole('member'));
  await page.locator('.admin-panel').waitFor({ state: 'detached' });
  assert.equal(await page.getByText('Other private note', { exact: true }).count(), 0);
  await context.close();
  assert.deepEqual(errors, []);
  console.log('PASS: all admin tabs 320/390/768/1440, quality report, failure closed, permission revoked, account switch clears private panel');
} finally { await browser.close(); }
