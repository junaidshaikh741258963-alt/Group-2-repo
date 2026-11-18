import mysql from "mysql2/promise";

let pool: mysql.Pool | null = null;
let initPromise: Promise<void> | null = null;

const DB_HOST = process.env.DB_HOST || "localhost";
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD ?? "";
const DB_NAME = process.env.DB_NAME || "travel_planner";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS trips (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36),
    origin_name VARCHAR(255),
    destination_name VARCHAR(255),
    origin_lat DOUBLE,
    origin_lng DOUBLE,
    dest_lat DOUBLE,
    dest_lng DOUBLE,
    distance DOUBLE,
    duration DOUBLE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `INSERT IGNORE INTO users (id, email, password, name) VALUES ('guest', 'guest@local', '-', 'Guest')`,
];

async function createSchema(): Promise<void> {
  const conn = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await conn.query(`USE \`${DB_NAME}\``);
    for (const statement of SCHEMA) {
      await conn.query(statement);
    }
  } finally {
    await conn.end();
  }
}

export function initDb(): Promise<void> {
  if (!initPromise) {
    initPromise = createSchema().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export function getPool(): mysql.Pool {
  if (pool) return pool;

  pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
  });

  return pool;
}

export async function query<T = mysql.RowDataPacket[]>(
  sql: string,
  params?: (string | number | null)[]
): Promise<T> {
  await initDb();
  const db = getPool();
  const [rows] = await db.execute(sql, params || []);
  return rows as T;
}
