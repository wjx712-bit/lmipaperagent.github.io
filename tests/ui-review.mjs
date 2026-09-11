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
  ...paper, topics: index < 3 ? [topic] : ['Liver metabolism / MASLD'],
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
  await page.addInitScript(({ role, sample }) => {
    window.__testRole = role;
    window.__reviewWrites = [];
    window.__failSave = false;
    window.__saveDelay = 0;
    window.__rows = [
      { user_id: 'other', paper_id: sample[0].id, score: 5, note: 'Other member private note' },
      { user_id: 'other', paper_id: sample[1].id, score: 3, note: '' },
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
        React.useEffect(() => { window.__setRole = setRole; }, []);
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
    export const supabase = { from() {
      let userId, start = 0, end = 999;
      return { select() { return this; }, order() { return this; },
        eq(key, value) { userId = value; return this; },
        range(from, to) { start = from; end = to; return this; },
        then(resolve) {
          const rows = window.__rows.filter(row => !userId || row.user_id === userId);
          return Promise.resolve({ data: rows.slice(start, end + 1), error: null }).then(resolve);
        },
        async upsert(row) {
          window.__reviewWrites.push(structuredClone(row));
          await new Promise(resolve => setTimeout(resolve, window.__saveDelay));
          if (window.__failSave) return { error: { message: 'Simulated save failure' } };
          window.__rows = window.__rows.filter(old => old.user_id !== row.user_id || old.paper_id !== row.paper_id);
          window.__rows.push(structuredClone(row));
          return { error: null };
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
  await page.evaluate(() => window.__setRole('anonymous'));
  await waitFor(page, () => document.querySelectorAll('.stat-card.locked').length === 3);
  assert.equal(await page.locator('.review-queue-bar').count(), 0);
  await context.close();
  console.log('PASS: filtered pending queue, no skips, failed saves, dirty drafts, previous/next, completion, author isolation');

  const admin = await setup('admin');
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
} finally {
  await browser.close();
}
