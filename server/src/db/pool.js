import pg from 'pg';

export function getPool(config) {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

export function makeQuery(pool) {
  return (text, values) => pool.query(text, values);
}
