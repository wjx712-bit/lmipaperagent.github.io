import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('PostgreSQL migration preserves data, private RLS and anonymous topic completion', async (t) => {
  const db = new PGlite();
  const member = '00000000-0000-4000-8000-000000000001';
  const other = '00000000-0000-4000-8000-000000000002';
  const pending = '00000000-0000-4000-8000-000000000003';
  const blocked = '00000000-0000-4000-8000-000000000004';
  const admin = '00000000-0000-4000-8000-000000000005';
  const liver = 'Liver metabolism / MASLD';
  const adipose = 'Adipose tissue / adipocyte biology';
  const asUser = async (id, role = 'authenticated') => {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    await db.exec(`set role ${role}`);
  };
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth; grant usage on schema auth to authenticated, anon;
      create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
    await db.exec(await readFile('supabase/migrations/202608130001_auth_and_reviews.sql', 'utf8'));
    for (const [id, email] of [[member, 'one@example.test'], [other, 'two@example.test'], [pending, 'pending@example.test'], [blocked, 'blocked@example.test'], [admin, 'wjx712@gmail.com']]) {
      await db.query('insert into auth.users values ($1,$2,$3)', [id, email, '{}']);
    }
    await db.query("update public.profiles set status = 'approved' where id in ($1,$2)", [member, other]);
    await db.query("update public.profiles set status = 'blocked' where id = $1", [blocked]);
    await db.query('insert into public.paper_reviews(user_id,paper_id,score,note) values ($1,$2,1,$3),($4,$2,5,$5)', [member, 'legacy', 'Private one', other, 'Private two']);
    const before = (await db.query('select * from public.paper_reviews order by user_id')).rows;
    const policies = (await db.query('select * from pg_policies order by tablename,policyname')).rows;
    const migration = await readFile('supabase/migrations/202609110001_review_coordination.sql', 'utf8');
    await db.exec(migration);
    await db.exec(migration);

    await t.test('idempotent additive migration changes no previous values or RLS', async () => {
      const after = (await db.query('select * from public.paper_reviews order by user_id')).rows;
      assert.deepEqual(after.map(({ review_topic, ...row }) => row), before);
      assert.ok(after.every(row => row.review_topic === null));
      assert.deepEqual((await db.query('select * from pg_policies order by tablename,policyname')).rows, policies);
    });

    await asUser(other);
    await db.query('insert into public.paper_reviews(user_id,paper_id,score,note,review_topic) values ($1,$2,5,$3,$4)', [other, 'overlap', 'Hidden score and note', liver]);
    await asUser(member);
    await db.query('insert into public.paper_reviews(user_id,paper_id,score,review_topic) values ($1,$2,1,$3)', [member, 'own-only', adipose]);

    await t.test('members can read only own raw reviews but receive anonymous completion', async () => {
      const raw = (await db.query('select * from public.paper_reviews')).rows;
      assert.ok(raw.every(row => row.user_id === member));
      assert.equal(raw.length, 2);
      const data = (await db.query('select public.review_completion($1) as data', [['legacy', 'overlap', 'own-only', 'none']])).rows[0].data;
      assert.deepEqual(data, { version: 1, papers: [
        { paper_id: 'legacy', topics: [], other_topics: [], other_unattributed: true },
        { paper_id: 'overlap', topics: [liver], other_topics: [liver], other_unattributed: false },
        { paper_id: 'own-only', topics: [adipose], other_topics: [], other_unattributed: false },
      ] });
      assert.ok(!JSON.stringify(data).match(/Private|Hidden|score|note|user_id|email/));
      assert.equal((await db.query('select public.review_completion($1) as data', [[]])).rows[0].data.papers.length, 0);
    });

    await t.test('repeat edits and upserts keep first origin, including legacy NULL', async () => {
      await db.query("update public.paper_reviews set score=4,review_topic=$1 where paper_id='legacy'", [liver]);
      const row = (await db.query("select review_topic,score from public.paper_reviews where paper_id='legacy'")).rows[0];
      assert.deepEqual(row, { review_topic: null, score: 4 });
      await db.query("insert into public.paper_reviews(user_id,paper_id,score,review_topic) values($1,'own-only',3,$2) on conflict(user_id,paper_id) do update set score=excluded.score,review_topic=excluded.review_topic", [member, liver]);
      assert.equal((await db.query("select review_topic from public.paper_reviews where paper_id='own-only'")).rows[0].review_topic, adipose);
      await assert.rejects(db.exec("update public.paper_reviews set paper_id='changed' where paper_id='own-only'"), /identity cannot/);
      await assert.rejects(db.query("insert into public.paper_reviews(user_id,paper_id,score,review_topic) values($1,'bad',1,'unknown')", [member]), /check constraint/);
      assert.equal((await db.query('select count(*)::int as n from public.paper_reviews')).rows[0].n, 2);
    });

    await t.test('another member cannot write someone else\'s review', async () => {
      await assert.rejects(db.query("insert into public.paper_reviews(user_id,paper_id,score) values($1,'forbidden',1)", [other]), /row-level security/);
    });

    await t.test('logged out, pending and blocked callers are denied', async () => {
      for (const id of [pending, blocked]) {
        await asUser(id);
        await assert.rejects(db.query('select public.review_completion($1)', [['legacy']]), /Approved membership required/);
      }
      await asUser('', 'anon');
      await assert.rejects(db.query('select public.review_completion($1)', [['legacy']]), /permission denied/);
      await asUser(member);
      await assert.rejects(db.query('select public.review_completion($1)', [Array(10001).fill('a')]), /10000/);
      await assert.rejects(db.exec('select public.review_completion(null)'), /10000/);
    });

    await t.test('admin retains raw score, note and origin access', async () => {
      await asUser(admin);
      const all = (await db.query('select * from public.paper_reviews')).rows;
      assert.equal(all.length, 4);
      assert.ok(all.some(row => row.note === 'Hidden score and note' && row.review_topic === liver));
    });

    await t.test('large inventory returns complete scalar JSON, not a row-limited table', async () => {
      await asUser(other);
      await db.query("insert into public.paper_reviews(user_id,paper_id,score,review_topic) select $1, 'bulk-'||i,1,'__general__' from generate_series(1,1500) i", [other]);
      await asUser(member);
      const data = (await db.query("select public.review_completion(array(select 'bulk-'||i from generate_series(1,1500)i)) as data")).rows[0].data;
      assert.equal(data.papers.length, 1500);
    });
  } finally { await db.close(); }
});
