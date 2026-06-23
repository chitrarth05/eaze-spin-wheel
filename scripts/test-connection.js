import { runQuery } from '../src/db.js';
async function main() {
  const r = await runQuery('SELECT NOW() AS t, current_database() AS db');
  console.log('Connected:', r.rows[0]);
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
