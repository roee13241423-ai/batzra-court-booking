const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('חסר משתנה סביבה DATABASE_URL - יש להגדיר חיבור למסד נתונים Postgres');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      address TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_admin BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      hour INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(date, hour)
    );
  `);
}

function mapUser(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    address: row.address,
    email: row.email,
    passwordHash: row.password_hash,
    status: row.status,
    isAdmin: row.is_admin,
    createdAt: row.created_at
  };
}

function mapBooking(row) {
  return {
    id: row.id,
    date: row.date,
    hour: row.hour,
    userId: row.user_id,
    createdAt: row.created_at
  };
}

async function getAllUsers() {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
  return rows.map(mapUser);
}

async function getAllBookings() {
  const { rows } = await pool.query('SELECT * FROM bookings ORDER BY id');
  return rows.map(mapBooking);
}

async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] ? mapUser(rows[0]) : null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

async function hasAdmin() {
  const { rows } = await pool.query('SELECT 1 FROM users WHERE is_admin = true LIMIT 1');
  return rows.length > 0;
}

async function createUser({ firstName, lastName, address, email, passwordHash, status, isAdmin }) {
  const { rows } = await pool.query(
    `INSERT INTO users (first_name, last_name, address, email, password_hash, status, is_admin)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [firstName, lastName, address, email, passwordHash, status, isAdmin]
  );
  return mapUser(rows[0]);
}

async function setUserStatus(id, status) {
  await pool.query('UPDATE users SET status = $1 WHERE id = $2', [status, id]);
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1 AND is_admin = false', [id]);
}

async function createBooking(date, hour, userId) {
  const { rows } = await pool.query(
    `INSERT INTO bookings (date, hour, user_id) VALUES ($1, $2, $3)
     ON CONFLICT (date, hour) DO NOTHING RETURNING *`,
    [date, hour, userId]
  );
  return rows[0] ? mapBooking(rows[0]) : null;
}

async function deleteBookingByOwner(date, hour, userId) {
  await pool.query('DELETE FROM bookings WHERE date = $1 AND hour = $2 AND user_id = $3', [date, hour, userId]);
}

async function deleteBookingById(id) {
  await pool.query('DELETE FROM bookings WHERE id = $1', [id]);
}

module.exports = {
  init,
  getAllUsers,
  getAllBookings,
  getUserByEmail,
  getUserById,
  hasAdmin,
  createUser,
  setUserStatus,
  deleteUser,
  createBooking,
  deleteBookingByOwner,
  deleteBookingById
};
