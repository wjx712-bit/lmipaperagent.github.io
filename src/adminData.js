const PAGE_SIZE = 500;
// PostgREST filter literals: https://postgrest.org/en/stable/references/api/url_grammar.html
const quoted = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export async function readAllRows(client, table, columns, order) {
  const rows = [];
  let cursor = null;
  for (;;) {
    let query = client.from(table).select(columns);
    for (const column of order) query = query.order(column, { ascending: true });
    if (cursor) {
      if (order.length === 1) query = query.gt(order[0], cursor[0]);
      else query = query.or(`${order[0]}.gt.${quoted(cursor[0])},and(${order[0]}.eq.${quoted(cursor[0])},${order[1]}.gt.${quoted(cursor[1])})`);
    }
    const { data, error } = await query.range(0, PAGE_SIZE - 1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Invalid administrator data response');
    if (!data.length) return rows;
    const next = order.map((column) => data.at(-1)[column]);
    if (next.some((value) => typeof value !== 'string' || !value) || JSON.stringify(next) === JSON.stringify(cursor)) throw new Error('Invalid administrator pagination cursor');
    // Keyset pagination avoids shifting offsets when an already-read record is deleted.
    cursor = next;
    rows.push(...data);
  }
}

async function requireAdmin(client) {
  const { data: allowed, error } = await client.rpc('is_lmi_admin');
  if (error) throw error;
  if (allowed !== true) throw new Error('관리자 권한을 확인할 수 없습니다. 다시 로그인해 주세요.');
}

export async function fetchAdminData(client) {
  await requireAdmin(client);
  const [profiles, reviews] = await Promise.all([
    readAllRows(client, 'profiles', 'id,email,display_name,avatar_url,status,role,created_at', ['id']),
    readAllRows(client, 'paper_reviews', 'user_id,paper_id,doi,score,note,created_at,updated_at', ['paper_id', 'user_id']),
  ]);
  await requireAdmin(client);
  return { profiles, reviews, fetchedAt: new Date().toISOString() };
}
