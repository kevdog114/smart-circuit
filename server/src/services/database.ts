import { Pool, PoolClient } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.warn('[DB] DATABASE_URL not set, database features disabled');
      throw new Error('DATABASE_URL not configured');
    }
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('[DB] Unexpected error on idle client:', err.message);
    });

    console.log('[DB] Connection pool initialized');
  }
  return pool;
}

export async function ensureDatabaseReady(): Promise<boolean> {
  try {
    const p = getPool();
    const client = await p.connect();
    try {
      await client.query('SELECT 1');
      console.log('[DB] Database connection verified');
      return true;
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('[DB] Database unavailable, falling back to file storage:', err instanceof Error ? err.message : err);
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[DB] Connection pool closed');
  }
}

/**
 * Check if database is configured and available.
 */
export function isDatabaseAvailable(): boolean {
  return !!process.env.DATABASE_URL && !!pool;
}
