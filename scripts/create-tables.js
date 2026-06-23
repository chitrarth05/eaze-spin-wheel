import { runQuery } from '../src/db.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
async function main() {
  const sql = await fs.readFile(path.join(__dirname, '..', 'sql', 'create_spin_wheel_tables.sql'), 'utf8');
  await runQuery(sql);
  console.log('Spin wheel tables created successfully.');
}
main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
