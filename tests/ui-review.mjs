import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(process.env.LMI_NODE_MODULES
  ? path.join(process.env.LMI_NODE_MODULES, '_ui-test.cjs') : import.meta.url);
const { chromium } = require('playwright');
const baseUrl = process.env.LMI_UI_URL || 'http://127.0.0.1:8793/';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname), 'Run write simulations only on a local dev server');
const dataset = JSON.parse(await readFile('public/data/papers.json', 'utf8'));
const topic = 'Adipose tissue / adipocyte biology';
const sample = dataset.papers.slice(0, 4).map((paper, index) => ({
  ...paper, topics: index < 2 ? [topic, 'Liver metabolism / MASLD'] : index === 2 ? [topic] : ['Liver metabolism / MASLD'],
  addedAt: `2026-08-${30 - index}T00:00:00Z`,
}));
const artifacts = '.cache/ui-review';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.LMI_BROWSER_CHANNEL || 'chrome' });
const failures = [];

async function setup(role, { fullData = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => failures.push(error.message));
  await page.route('https://*.supabase.co/**', route => { failures.push('Unexpected real Supabase request'); return route.abort(); });
  await page.addInitScript(({ role, sample }) => {
    window.__testRole = role;
    window.__reviewWrites = [];
    window.__failSave = false;
    window.__saveDelay = 0;
    window.__failCompletion = false;
    window.__completionResponses = [];
    window.__rows = [
      { user_id: 'other', paper_id: sample[0].id, score: 5, note: 'Other member private note', review_topic: 'Liver metabolism / MASLD' },
      { user_id: 'other', paper_id: sample[1].id, score: 3, note: '', review_topic: 'Liver metabolism / MASLD' },
      { user_id: 'member', paper_id: sample[0].id, score: 2, note: 'My existing note' },
    ];
  }, { role, sample });
  if (!fullData) await page.route('**/data/papers.json', (route) => route.fulfill({ json: { ...dataset, papers: sample } }));
  await page.route(/\/src\/useAuth\.js(\?.*)?$/, async (route) => {
    const original = await (await route.fetch()).text();
    const reactUrl = original.match(/from\s+["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    assert.ok(reactUrl, 'Vite React module URL');
    await route.fulfill({ contentType: 'text/javascript', body: `
      import React from ${JSON.stringify(reactUrl)};
      export function useAuth() {
        const [role, setRole] = React.useState(window.__testRole);
        React.useEffect(() => { window.__setRole = setRole; window.__activeRole = role; }, [role]);
        const signedIn = role !== 'anonymous';
        return { configured: true, loading: false, error: '',
          user: signedIn ? { id: role, email: role + '@example.test', user_metadata: {} } : null,
          profile: signedIn ? { display_name: 'Test researcher', status: role === 'pending' ? 'pending' : 'approved' } : null,
          isApproved: signedIn && role !== 'pending', isAdmin: role === 'admin',
          signInWithGoogle() {}, refreshProfile() {}, signOut() { setRole('anonymous'); }
        };
      }` });
  });
  // Isolate persistence at the module boundary; no Supabase requests or real labels are written.
  await page.route(/\/src\/supabase(?:\.js)?(\?.*)?$/, (route) => route.fulfill({ contentType: 'text/javascript', body: `
    export const supabase = {
      async rpc(name, args) {
        if (window.__failCompletion) return { error: { message: 'Completion unavailable' } };
        const rows = window.__rows.filter(row => args.requested_paper_ids.includes(row.paper_id));
        const papers = [...new Set(rows.map(row => row.paper_id))].map(paper_id => {
          const all = rows.filter(row => row.paper_id === paper_id);
          const others = all.filter(row => row.user_id !== window.__activeRole);
          return { paper_id, topics: [...new Set(all.map(row => row.review_topic).filter(Boolean))], other_topics: [...new Set(others.map(row => row.review_topic).filter(Boolean))], other_unattributed: others.some(row => !row.review_topic) };
        });
        const data = { version: 1, papers };
        window.__completionResponses.push(data);
        return { data, error: null };
      },
      from() {
      let userId, start = 0, end = 999;
      return { select() { return this; }, order() { return this; },
        eq(key, value) { userId = value; return this; },
        range(from, to) { start = from; end = to; return this; },
        then(resolve) {
          const rows = window.__rows.filter(row => !userId || row.user_id === userId);
          return Promise.resolve({ data: rows.slice(start, end + 1), error: null }).then(resolve);
        },
        upsert(row) {
          return { select() { return this; }, async single() {
            window.__reviewWrites.push(structuredClone(row));
            await new Promise(resolve => setTimeout(resolve, window.__saveDelay));
            if (window.__failSave) return { error: { message: 'Simulated save failure' } };
            const old = window.__rows.find(old => old.user_id === row.user_id && old.paper_id === row.paper_id);
            const saved = { ...row, review_topic: old ? old.review_topic ?? null : row.review_topic };
            window.__rows = window.__rows.filter(old => old.user_id !== row.user_id || old.paper_id !== row.paper_id);
            window.__rows.push(structuredClone(saved));
            return { error: null, data: { review_topic: saved.review_topic } };
          }};
        }
      };
    }};` }));
  await page.goto(baseUrl);
  await page.locator('.paper-row').first().waitFor();
  if (['member', 'admin'].includes(role)) {
    try { await page.getByRole('button', { name: '미평가 연속 검토' }).waitFor({ timeout: 10000 }); }
    catch (error) { console.error((await page.locator('body').innerText()).slice(0, 1800), failures); throw error; }
  }
  return { context, page };
}

async function waitFor(page, predicate, arg) { await page.waitForFunction(predicate, arg); }
async function checkWidth(page, label) {
  const sizes = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(sizes.document <= sizes.width + 1 && sizes.body <= sizes.width + 1, `${label}: ${JSON.stringify(sizes)}`);
}
async function selectScore(page, value) { await page.locator(`.score-options label:has(input[value="${value}"])`).click(); }
async function drawerTitle(page) { return page.locator('.drawer-paper h3').innerText(); }

try {
  const anonymous = await setup('anonymous', { fullData: true });
  for (const width of [320, 375, 390, 620, 820, 1080, 1440]) {
    await anonymous.page.setViewportSize({ width, height: 950 });
    await checkWidth(anonymous.page, `anonymous ${width}`);
    assert.equal(await anonymous.page.locator('.stat-card.locked').count(), 3);
    for (const text of await anonymous.page.locator('.stat-card.locked strong').allTextContents()) assert.equal(text, '로그인 후 확인');
    assert.equal(await anonymous.page.locator('.paper-row').first().locator('p.abstract').count(), 1);
    const bounds = await anonymous.page.locator('.data-badge').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'Badge stays on screen');
    if ([390, 1440].includes(width)) await anonymous.page.screenshot({ path: `${artifacts}/anonymous-${width}.png` });
  }
  await anonymous.page.setViewportSize({ width: 390, height: 844 });
  await anonymous.page.getByRole('button', { name: /^필터/ }).click();
  await checkWidth(anonymous.page, 'open mobile filters');
  await anonymous.page.getByRole('button', { name: '필터 닫기' }).click();
  await anonymous.page.locator('.paper-main').first().click();
  assert.ok(await anonymous.page.locator('.abstract-language p[lang="en"]').innerText());
  assert.ok(await anonymous.page.locator('.abstract-language p[lang="ko"]').innerText());
  await anonymous.page.getByRole('tab', { name: '내 평가', exact: true }).click();
  assert.equal(await anonymous.page.locator('.score-options').count(), 0);
  await anonymous.context.close();
  console.log('PASS: logged-out stats, bilingual detail, mobile/desktop widths');

  const unclassifiedPapers = dataset.papers.filter(paper => paper.topics.includes('미분류'));
  assert.equal(unclassifiedPapers.length, 17);
  const unclassified = await setup('member', { fullData: true });
  await unclassified.page.locator('.check-option').filter({ hasText: '미분류' }).click();
  await waitFor(unclassified.page, count => document.querySelectorAll('.paper-row').length === count, unclassifiedPapers.length);
  const expectedTitles = unclassifiedPapers.map(paper => paper.title).sort();
  assert.deepEqual((await unclassified.page.locator('.paper-row h3').allTextContents()).sort(), expectedTitles);
  const priorRows = await unclassified.page.evaluate(() => JSON.stringify(window.__rows));
  for (const width of [390, 1440]) {
    await unclassified.page.setViewportSize({ width, height: 950 });
    await checkWidth(unclassified.page, `unclassified ${width}`);
    await unclassified.page.screenshot({ path: `${artifacts}/unclassified-${width}.png` });
  }
  await unclassified.page.getByRole('button', { name: '미평가 연속 검토' }).click();
  assert.equal(await unclassified.page.locator('.drawer-navigation > span').innerText(), '1 / 17');
  const unclassifiedTitle = await drawerTitle(unclassified.page);
  const reviewedPaper = unclassifiedPapers.find(paper => paper.title === unclassifiedTitle);
  assert.ok(reviewedPaper);
  await unclassified.page.getByRole('button', { name: '평가하기', exact: true }).click();
  await selectScore(unclassified.page, 1);
  await unclassified.page.getByLabel('리뷰 노트', { exact: true }).fill('Lab relevance reviewed for an unclassified paper');
  await unclassified.page.getByRole('button', { name: '평가 저장', exact: true }).click();
  await unclassified.page.getByText('저장되었습니다', { exact: true }).waitFor();
  const unclassifiedWrites = await unclassified.page.evaluate(() => window.__reviewWrites);
  assert.equal(unclassifiedWrites.length, 1);
  assert.equal(unclassifiedWrites[0].paper_id, reviewedPaper.id);
  assert.equal(unclassifiedWrites[0].user_id, 'member');
  assert.equal(unclassifiedWrites[0].score, 1);
  assert.equal(unclassifiedWrites[0].review_topic, '미분류');
  const preservedRows = await unclassified.page.evaluate(id => JSON.stringify(window.__rows.filter(row => row.paper_id !== id)), reviewedPaper.id);
  assert.equal(preservedRows, priorRows);
  await unclassified.context.close();
  console.log('PASS: actual 17 unclassified papers filter, mobile layout, continuous review and isolated score/note save');

  const { page, context } = await setup('member');
  assert.equal(await page.locator('.review-scope').count(), 0);
  assert.ok((await page.locator('.stat-card').filter({ hasText: '필독 후보' }).innerText()).includes('0'));
  await page.locator('.check-option').filter({ hasText: topic }).click();
  await waitFor(page, () => document.querySelectorAll('.paper-row').length === 3);
  await page.getByRole('tab', { name: /^평가 대기/ }).click();
  await page.getByRole('button', { name: '미평가 연속 검토' }).click();
  assert.equal(await drawerTitle(page), sample[1].title);
  assert.equal(await page.locator('.drawer-navigation > span').innerText(), '1 / 2');
  await page.getByRole('button', { name: '평가하기', exact: true }).click();
  assert.equal(await page.locator('.score-options input:checked').count(), 0);
  await selectScore(page, 4);
  await page.getByLabel('리뷰 노트', { exact: true }).fill('Topic-specific review note');
  await page.getByRole('button', { name: '다음 논문', exact: true }).click();
  await page.getByText('저장하지 않은 평가가 있습니다.', { exact: true }).waitFor();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  assert.equal(await page.getByLabel('리뷰 노트', { exact: true }).inputValue(), 'Topic-specific review note');
  await page.evaluate(() => { window.__failSave = true; });
  await page.getByRole('button', { name: '저장 후 다음', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Simulated save failure' }).waitFor();
  assert.equal(await drawerTitle(page), sample[1].title);
  assert.equal(await page.getByLabel('리뷰 노트', { exact: true }).inputValue(), 'Topic-specific review note');
  await page.evaluate(() => { window.__failSave = false; window.__saveDelay = 250; });
  await page.getByRole('button', { name: '저장 후 다음', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '다음 논문', exact: true }).isDisabled(), true);
  await waitFor(page, title => document.querySelector('.drawer-paper h3')?.textContent === title, sample[2].title);
  assert.equal(await page.locator('.drawer-navigation > span').innerText(), '2 / 2');
  assert.equal(await page.getByRole('tab', { name: 'Abstract', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: '평가하기', exact: true }).click();
  assert.equal(await page.getByLabel('리뷰 노트', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('.score-options input:checked').count(), 0);
  await page.getByRole('button', { name: '이전 논문', exact: true }).click();
  assert.equal(await page.locator('.score-options input:checked').inputValue(), '4');
  assert.equal(await page.getByLabel('리뷰 노트', { exact: true }).inputValue(), 'Topic-specific review note');
  await page.getByRole('button', { name: '다음 논문', exact: true }).click();
  await page.getByLabel('리뷰 노트', { exact: true }).fill('Unsaved note');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '변경 버리고 이동', exact: true }).click();
  assert.equal(await page.locator('.review-drawer').count(), 0);
  await page.getByRole('button', { name: '미평가 연속 검토' }).click();
  assert.equal(await drawerTitle(page), sample[2].title);
  await page.getByRole('button', { name: '평가하기', exact: true }).click();
  await selectScore(page, 5);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await checkWidth(page, `review drawer ${width}`);
    const controls = await page.locator('.drawer-footer button').evaluateAll(elements => elements.map(el => {
      const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, bottom: rect.bottom };
    }));
    assert.ok(controls.every(rect => rect.left >= 0 && rect.right <= width && rect.bottom <= 844), 'Save controls visible');
    if (width === 390) await page.screenshot({ path: `${artifacts}/review-390.png` });
  }
  await page.getByRole('button', { name: '저장 후 완료', exact: true }).click();
  await page.getByText('마지막 논문의 평가를 저장했습니다.', { exact: true }).waitFor();
  const writes = await page.evaluate(() => window.__reviewWrites);
  assert.equal(writes.length, 3, 'one failed attempt and two successful saves');
  assert.ok(writes.every(row => row.user_id === 'member'), 'Only the current author is written');
  assert.equal(writes[1].paper_id, sample[1].id);
  assert.equal(writes[2].paper_id, sample[2].id);
  assert.ok(writes.every(row => row.review_topic === topic));
  await page.evaluate(() => window.__setRole('anonymous'));
  await waitFor(page, () => document.querySelectorAll('.stat-card.locked').length === 3);
  assert.equal(await page.locator('.review-queue-bar').count(), 0);
  await context.close();
  console.log('PASS: filtered pending queue, no skips, failed saves, dirty drafts, previous/next, completion, author isolation');

  const admin = await setup('admin');
  await admin.page.getByLabel('작업 주제', { exact: true }).selectOption('__general__');
  assert.ok((await admin.page.locator('.stat-card').filter({ hasText: '필독 후보' }).innerText()).includes('1'));
  assert.equal(await admin.page.locator('.review-scope button[aria-pressed="true"]').innerText(), '연구실 전체');
  await admin.page.locator('.paper-main').first().click();
  await admin.page.getByRole('button', { name: '평가하기', exact: true }).click();
  assert.equal(await admin.page.locator('.score-options input:checked').count(), 0, 'Other member score is not my score');
  assert.equal(await admin.page.getByLabel('리뷰 노트', { exact: true }).inputValue(), '');
  await admin.page.getByRole('button', { name: '검토창 닫기' }).click();
  await admin.page.getByRole('group', { name: '평가 집계 범위' }).getByRole('button', { name: '내 평가', exact: true }).click();
  assert.ok((await admin.page.locator('.stat-card').filter({ hasText: '필독 후보' }).innerText()).includes('0'));
  await admin.page.getByRole('button', { name: '미평가 연속 검토' }).click();
  assert.equal(await admin.page.locator('.drawer-navigation > span').innerText(), '1 / 4');
  await admin.page.getByRole('button', { name: '평가하기', exact: true }).click();
  await selectScore(admin.page, 3);
  await admin.page.getByRole('button', { name: '평가 저장', exact: true }).click();
  await admin.page.getByText('저장되었습니다', { exact: true }).waitFor();
  assert.equal(await drawerTitle(admin.page), sample[0].title);
  await admin.page.getByRole('button', { name: '검토창 닫기' }).click();
  await admin.page.getByRole('group', { name: '평가 집계 범위' }).getByRole('button', { name: '연구실 전체', exact: true }).click();
  assert.equal(await admin.page.locator('.paper-row').first().locator('.metric.human strong').innerText(), '5');
  assert.ok((await admin.page.locator('.paper-row').first().locator('.metric.human small').innerText()).includes('3명'));
  await admin.context.close();
  console.log('PASS: admin lab/own scope and unchanged lab candidate scores');

  const pending = await setup('pending');
  assert.equal(await pending.page.locator('.stat-card.locked').count(), 3);
  assert.equal(await pending.page.locator('.stat-card.locked strong').first().innerText(), '승인 후 확인');
  await pending.context.close();
  assert.deepEqual(failures, [], 'No browser exceptions');
  console.log('PASS: approval gating and no browser errors');

  const shared = await setup('member');
  const sharedPage = shared.page;
  await sharedPage.locator('.stat-card').filter({ hasText: '전체 평가 진행률' }).getByText('50%', { exact: true }).waitFor();
  assert.equal(await sharedPage.getByText('Other member private note', { exact: true }).count(), 0);
  const sharedJson = await sharedPage.evaluate(() => JSON.stringify(window.__completionResponses));
  assert.ok(!sharedJson.match(/score|note|user_id|email/));
  await sharedPage.locator('.check-option').filter({ hasText: topic }).click();
  assert.equal(await sharedPage.getByLabel('작업 주제', { exact: true }).inputValue(), topic);
  await sharedPage.getByLabel('현재 작업 주제에서 미평가만', { exact: true }).check();
  assert.equal(await sharedPage.locator('.paper-row').count(), 3, 'Other-topic and unknown-origin reviews do not complete the current work topic');
  await sharedPage.evaluate(({ id, topic }) => window.__rows.push({ user_id: 'another', paper_id: id, score: 4, note: 'Still private', review_topic: topic }), { id: sample[2].id, topic });
  await sharedPage.getByRole('button', { name: '공유 평가 현황 새로고침' }).click();
  await waitFor(sharedPage, () => document.querySelectorAll('.paper-row').length === 2);
  assert.deepEqual(await sharedPage.locator('.paper-row h3').allTextContents(), sample.slice(0, 2).map(p => p.title));
  assert.ok((await sharedPage.locator('.paper-row').nth(1).locator('.completion-status').innerText()).includes('Liver metabolism / MASLD 경유 · 평가 있음'));
  assert.ok((await sharedPage.locator('.coordination-progress').innerText()).includes('1 / 3편 (33.3%)'));
  for (const width of [320, 390, 768, 1440]) {
    await sharedPage.setViewportSize({ width, height: 950 });
    await checkWidth(sharedPage, `shared completion ${width}`);
    const progressBounds = await sharedPage.locator('.stat-card').filter({ hasText: '전체 평가 진행률' }).evaluate(card => ({ text: card.querySelector('small').getBoundingClientRect().bottom, track: card.querySelector('.progress-track').getBoundingClientRect().top }));
    assert.ok(progressBounds.text + 3 <= progressBounds.track, 'Progress text stays clear of its bar');
    if ([390, 1440].includes(width)) await sharedPage.locator('.paper-results').screenshot({ path: `${artifacts}/coordination-${width}.png` });
  }
  await sharedPage.getByRole('button', { name: '미평가 연속 검토' }).click();
  assert.equal(await drawerTitle(sharedPage), sample[1].title);
  assert.equal(await sharedPage.locator('.drawer-navigation > span').innerText(), '1 / 1');
  await sharedPage.getByRole('button', { name: '평가하기', exact: true }).click();
  await selectScore(sharedPage, 2);
  await sharedPage.getByRole('button', { name: '평가 저장', exact: true }).click();
  await sharedPage.getByText('저장되었습니다', { exact: true }).waitFor();
  assert.equal(await sharedPage.evaluate(() => window.__reviewWrites.at(-1).review_topic), topic);
  await sharedPage.getByRole('button', { name: '검토창 닫기' }).click();
  await waitFor(sharedPage, () => document.querySelector('.coordination-progress')?.textContent.includes('2 / 3편 (66.7%)'));
  assert.equal(await sharedPage.locator('.stat-card').filter({ hasText: '전체 평가 진행률' }).locator('strong').innerText(), '75%');
  await sharedPage.getByLabel('현재 작업 주제에서 미평가만', { exact: true }).uncheck();
  await sharedPage.locator('.paper-main').first().click();
  assert.ok((await sharedPage.locator('.review-origin').innerText()).includes('평가 경로 미기록'));
  await sharedPage.getByRole('button', { name: '평가하기', exact: true }).click();
  await selectScore(sharedPage, 4);
  await sharedPage.getByRole('button', { name: '평가 저장', exact: true }).click();
  await sharedPage.getByText('저장되었습니다', { exact: true }).waitFor();
  assert.equal(await sharedPage.evaluate(() => window.__reviewWrites.at(-1).review_topic), null);
  await sharedPage.getByRole('button', { name: '검토창 닫기' }).click();

  await sharedPage.getByLabel('현재 작업 주제에서 미평가만', { exact: true }).check();
  await sharedPage.evaluate(() => { window.__failCompletion = true; });
  await sharedPage.getByRole('button', { name: '공유 평가 현황 새로고침' }).click();
  await sharedPage.getByText('공유 평가 현황 확인 필요', { exact: true }).waitFor();
  assert.equal(await sharedPage.getByText('조건에 맞는 논문이 없습니다', { exact: true }).count(), 0);
  assert.equal(await sharedPage.locator('.completion-status').count(), 0);
  await sharedPage.evaluate(() => { window.__failCompletion = false; });
  await sharedPage.getByRole('button', { name: '공유 평가 현황 새로고침' }).click();
  await waitFor(sharedPage, () => document.querySelectorAll('.paper-row').length === 1);
  await sharedPage.evaluate(() => window.__setRole('anonymous'));
  await waitFor(sharedPage, () => document.querySelectorAll('.stat-card.locked').length === 3);
  assert.equal(await sharedPage.locator('.completion-status').count(), 0);
  await shared.context.close();
  console.log('PASS: anonymous statuses, unique total/topic coverage, cross-topic review preserved, old origins unchanged, fail-closed refresh and logout');

  const start = await setup('member');
  await start.page.locator('.check-option').filter({ hasText: topic }).click();
  await start.page.locator('.check-option').filter({ hasText: 'Liver metabolism / MASLD' }).click();
  await start.page.getByRole('button', { name: '미평가 연속 검토' }).click();
  await start.page.getByRole('dialog', { name: '이번 작업 주제' }).waitFor();
  assert.equal(await start.page.getByRole('button', { name: '검토 시작', exact: true }).isDisabled(), true);
  await start.page.getByLabel('검토 시작 주제').selectOption('Liver metabolism / MASLD');
  await start.page.getByRole('button', { name: '검토 시작', exact: true }).click();
  assert.equal(await start.page.locator('.drawer-navigation > span').innerText(), '1 / 2');
  assert.equal(await drawerTitle(start.page), sample[1].title);
  await start.page.getByRole('button', { name: '다음 논문', exact: true }).click();
  assert.equal(await drawerTitle(start.page), sample[3].title);
  await start.context.close();
  assert.deepEqual(failures, [], 'No errors in new coordination flow');
  console.log('PASS: multi-topic start requires a single explicit origin and freezes only the matching queue');
} finally {
  await browser.close();
}
