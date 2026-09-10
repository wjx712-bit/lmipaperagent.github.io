import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAdminData } from '../src/adminData.js';

function fakeClient({ allowed = true, rpcError = null, failPage = false, revokeAfterRead = false, deleteDuringRead = false } = {}) {
  const calls = [];
  const profiles = Array.from({ length: 1203 }, (_, index) => ({ id: `user-${String(index).padStart(4, '0')}` }));
  const reviews = Array.from({ length: 2501 }, (_, index) => ({ paper_id: `paper-${String(Math.floor(index / 3)).padStart(4, '0')}`, user_id: `user-${index % 3}` }));
  let permissionsChecked = false;
  return { calls, profiles, reviews,
    async rpc(name) { calls.push({ rpc: name }); const result = allowed && !(permissionsChecked && revokeAfterRead); permissionsChecked = true; return { data: result, error: rpcError }; },
    from(table) {
      const call = { table, order: [] }; calls.push(call);
      return { select(columns) { call.columns = columns; return this; },
        order(name) { call.order.push(name); return this; },
        gt(name, value) { call.cursor = [value]; return this; },
        or(value) {
          const values = [...value.matchAll(/"(?:\\.|[^"\\])*"/g)].map(match => JSON.parse(match[0]));
          assert.equal(values.length, 3); assert.equal(values[0], values[1]);
          call.cursor = [values[0], values[2]]; call.filter = value; return this;
        },
        async range(from, to) {
          call.range = [from, to];
          if (failPage && call.cursor) return { data: null, error: new Error('Page failed') };
          if (deleteDuringRead && table === 'paper_reviews' && call.cursor && reviews[0]?.paper_id === 'paper-0000') reviews.shift();
          const source = (table === 'profiles' ? profiles : reviews).filter(row => !call.cursor || row[call.order[0]] > call.cursor[0] || (call.order.length === 2 && row[call.order[0]] === call.cursor[0] && row[call.order[1]] > call.cursor[1]));
          return { data: source.slice(from, Math.min(to + 1, from + 123)), error: null };
        },
      };
    },
  };
}

test('all pages are read past 1000 rows with stable ordering and a lower server cap', async () => {
  const client = fakeClient();
  const result = await fetchAdminData(client);
  assert.deepEqual(result.profiles, client.profiles);
  assert.deepEqual(result.reviews, client.reviews);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.ok(client.calls.filter(call => call.table === 'paper_reviews').every(call => call.order.join(',') === 'paper_id,user_id'));
  assert.ok(client.calls.filter(call => call.table === 'paper_reviews').length > 20);
  assert.ok(client.calls.filter(call => call.table).every(call => call.range[0] === 0));
});

test('non-admin cannot even start fetching profiles or reviews', async () => {
  const client = fakeClient({ allowed: false });
  await assert.rejects(fetchAdminData(client), /관리자/);
  assert.equal(client.calls.length, 1);
});

test('a failed permission check cannot be mistaken for authorization', async () => {
  const client = fakeClient({ rpcError: new Error('Auth failed') });
  await assert.rejects(fetchAdminData(client), /Auth failed/);
  assert.equal(client.calls.length, 1);
});

test('a later page failure rejects the snapshot rather than showing partial progress', async () => {
  await assert.rejects(fetchAdminData(fakeClient({ failPage: true })), /Page failed/);
});

test('deleting earlier rows cannot skip surviving reviews later in the cursor order', async () => {
  const client = fakeClient({ deleteDuringRead: true });
  const result = await fetchAdminData(client);
  for (const row of client.reviews) assert.ok(result.reviews.some(item => item.paper_id === row.paper_id && item.user_id === row.user_id));
});

test('revocation during a successful read discards all returned data', async () => {
  await assert.rejects(fetchAdminData(fakeClient({ revokeAfterRead: true })), /관리자/);
});

test('cursor values with quotes, commas, parentheses and backslashes are quoted as data', async () => {
  const client = fakeClient();
  client.reviews.forEach(row => { row.paper_id = '10.1234/a,(b)"\\' + row.paper_id; });
  const result = await fetchAdminData(client);
  assert.deepEqual(result.reviews, client.reviews);
  assert.ok(client.calls.some(call => call.filter?.includes('\\"')));
});
