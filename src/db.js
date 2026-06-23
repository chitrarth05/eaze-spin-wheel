import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

function getSslConfig() {
  return process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env and set it.');
}

const pool = new Pool({ connectionString, ssl: getSslConfig() });

export function getDbPool() { return pool; }

export async function runQuery(text, params = []) {
  return pool.query(text, params);
}

export async function runInTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
