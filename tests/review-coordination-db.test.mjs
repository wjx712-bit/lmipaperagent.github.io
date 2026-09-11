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

    const auditMigration = await readFile('supabase/migrations/202609110002_review_origin_backfill_audit.sql', 'utf8');
    const backfill = await readFile('supabase/maintenance/backfill_review_origins.sql', 'utf8');
    const assignments = [
      { user_id: member, expected_name: 'Researcher One', topic: adipose },
      { user_id: other, expected_name: 'Researcher Two', topic: liver },
    ];
    const supply = rows => db.query("select set_config('lmi.confirmed_review_origins', $1, false)", [JSON.stringify(rows)]);
    await db.exec('reset role');
    await db.query('update public.profiles set display_name=$1 where id=$2', ['Researcher One', member]);
    await db.query('update public.profiles set display_name=$1 where id=$2', ['Researcher Two', other]);
    await db.exec(auditMigration);
    await db.exec(auditMigration);
    await db.query("insert into public.paper_reviews(user_id,paper_id,score) values($1,'unassigned',2)", [pending]);
    const preBackfill = (await db.query('select * from public.paper_reviews order by user_id,paper_id')).rows;

    await t.test('owner-confirmed backfill only fills missing paths and preserves every other field', async () => {
      await supply(assignments);
      await db.exec(backfill);
      const after = (await db.query('select * from public.paper_reviews order by user_id,paper_id')).rows;
      assert.deepEqual(after.map(({ review_topic, ...row }) => row), preBackfill.map(({ review_topic, ...row }) => row));
      for (let i = 0; i < after.length; i++) {
        assert.equal(after[i].review_topic, preBackfill[i].review_topic ?? assignments.find(a => a.user_id === after[i].user_id)?.topic ?? null);
      }
      const log = (await db.query('select * from public.review_origin_backfill_log')).rows;
      assert.equal(log.length, 1);
      assert.equal(log[0].source, 'lab_owner_confirmation');
      assert.deepEqual(log[0].assignments, assignments);
      assert.equal(log[0].changes.length, 2);
      assert.ok(log[0].changes.every(row => Object.keys(row).sort().join(',') === 'paper_id,review_topic,user_id'));
      await db.exec(backfill);
      assert.equal((await db.query('select count(*)::int as n from public.review_origin_backfill_log')).rows[0].n, 1);
    });

    await t.test('invalid mappings abort atomically without weakening review protection', async () => {
      for (const input of [[], [...assignments, assignments[0]], [{ ...assignments[0], expected_name: 'Wrong person' }], [{ ...assignments[0], topic: 'Invalid' }], [{ ...assignments[0], user_id: blocked }]]) {
        await supply(input);
        await assert.rejects(db.exec(backfill), /assignment|mismatch|invalid topic/);
        await db.exec('rollback');
      }
      await db.query("insert into public.paper_reviews(user_id,paper_id,score) values($1,'rollback-probe',2)", [member]);
      await db.exec(`create function pg_temp.abort_origin_probe() returns trigger language plpgsql as $$
        begin raise exception 'Simulated maintenance failure'; end; $$;
        create trigger abort_origin_probe before update on public.paper_reviews
        for each row execute function pg_temp.abort_origin_probe();`);
      await supply(assignments);
      await assert.rejects(db.exec(backfill), /Simulated maintenance failure/);
      await db.exec('rollback');
      assert.equal((await db.query("select review_topic from public.paper_reviews where paper_id='rollback-probe'")).rows[0].review_topic, null);
      assert.equal((await db.query('select count(*)::int as n from public.review_origin_backfill_log')).rows[0].n, 1);
      await db.exec('drop trigger abort_origin_probe on public.paper_reviews');
      const triggers = (await db.query("select tgenabled from pg_trigger where tgrelid='public.paper_reviews'::regclass and not tgisinternal")).rows;
      assert.ok(triggers.every(row => row.tgenabled === 'O'));
      await asUser(member);
      await db.query("update public.paper_reviews set review_topic='__general__' where paper_id='legacy'");
      assert.equal((await db.query("select review_topic from public.paper_reviews where paper_id='legacy'")).rows[0].review_topic, adipose);
    });

    await t.test('correction provenance is admin-only and members cannot invoke owner maintenance', async () => {
      assert.equal((await db.query('select * from public.review_origin_backfill_log')).rows.length, 0);
      await supply([assignments[0]]);
      await assert.rejects(db.exec(backfill), /permission denied|must be owner/);
      await db.exec('rollback');
      const privateRows = (await db.query('select * from public.paper_reviews')).rows;
      assert.ok(privateRows.every(row => row.user_id === member));
      const data = (await db.query('select public.review_completion($1) as data', [['legacy']])).rows[0].data;
      assert.deepEqual(data.papers[0], { paper_id: 'legacy', topics: [adipose, liver], other_topics: [liver], other_unattributed: false });
      await asUser(admin);
      assert.equal((await db.query('select * from public.review_origin_backfill_log')).rows.length, 1);
      await assert.rejects(db.exec("insert into public.review_origin_backfill_log(source,assignments,changes) values('lab_owner_confirmation','[]','[]')"), /permission denied/);
      await asUser('', 'anon');
      await assert.rejects(db.exec('select * from public.review_origin_backfill_log'), /permission denied/);
    });
  } finally { await db.close(); }
});
