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
      phone TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_admin BOOLEAN NOT NULL DEFAULT false,
      email_verified BOOLEAN NOT NULL DEFAULT false,
      verification_code TEXT,
      verification_expires TIMESTAMPTZ,
      reset_token TEXT,
      reset_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Safe to re-run on an existing table from before these columns existed.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMPTZ;`);
  // Admins predate email verification and should never be locked out by it.
  await pool.query(`UPDATE users SET email_verified = true WHERE is_admin = true AND email_verified = false;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      court TEXT NOT NULL DEFAULT 'footvolley',
      date TEXT NOT NULL,
      hour INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(court, date, hour)
    );
  `);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS court TEXT NOT NULL DEFAULT 'footvolley';`);
  // Older DBs have a (date, hour) unique constraint from before courts existed - replace it
  // with one that includes court, but only once (this block runs on every startup).
  const { rows: existingConstraint } = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'bookings_court_date_hour_key'`
  );
  if (existingConstraint.length === 0) {
    await pool.query(`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_date_hour_key;`);
    await pool.query(`ALTER TABLE bookings ADD CONSTRAINT bookings_court_date_hour_key UNIQUE (court, date, hour);`);
  }
}

function mapUser(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    address: row.address,
    email: row.email,
    phone: row.phone,
    passwordHash: row.password_hash,
    status: row.status,
    isAdmin: row.is_admin,
    emailVerified: row.email_verified,
    verificationCode: row.verification_code,
    verificationExpires: row.verification_expires,
    resetToken: row.reset_token,
    resetExpires: row.reset_expires,
    createdAt: row.created_at
  };
}

function mapBooking(row) {
  return {
    id: row.id,
    court: row.court,
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

async function createUser({ firstName, lastName, address, email, phone, passwordHash, status, isAdmin, emailVerified, verificationCode, verificationExpires }) {
  const { rows } = await pool.query(
    `INSERT INTO users (first_name, last_name, address, email, phone, password_hash, status, is_admin, email_verified, verification_code, verification_expires)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [firstName, lastName, address, email, phone || '', passwordHash, status, !!isAdmin, !!emailVerified, verificationCode || null, verificationExpires || null]
  );
  return mapUser(rows[0]);
}

async function setUserStatus(id, status) {
  await pool.query('UPDATE users SET status = $1 WHERE id = $2', [status, id]);
}

async function setVerificationCode(id, code, expires) {
  await pool.query('UPDATE users SET verification_code = $1, verification_expires = $2 WHERE id = $3', [code, expires, id]);
}

async function markEmailVerified(id) {
  await pool.query(
    `UPDATE users SET email_verified = true, verification_code = NULL, verification_expires = NULL WHERE id = $1`,
    [id]
  );
}

async function setResetToken(id, token, expires) {
  await pool.query('UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3', [token, expires, id]);
}

async function getUserByResetToken(token) {
  const { rows } = await pool.query('SELECT * FROM users WHERE reset_token = $1', [token]);
  return rows[0] ? mapUser(rows[0]) : null;
}

async function updatePassword(id, passwordHash) {
  await pool.query(
    'UPDATE users SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2',
    [passwordHash, id]
  );
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1 AND is_admin = false', [id]);
}

async function createBooking(court, date, hour, userId) {
  const { rows } = await pool.query(
    `INSERT INTO bookings (court, date, hour, user_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (court, date, hour) DO NOTHING RETURNING *`,
    [court, date, hour, userId]
  );
  return rows[0] ? mapBooking(rows[0]) : null;
}

async function deleteBookingByOwner(court, date, hour, userId) {
  await pool.query(
    'DELETE FROM bookings WHERE court = $1 AND date = $2 AND hour = $3 AND user_id = $4',
    [court, date, hour, userId]
  );
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
  setVerificationCode,
  markEmailVerified,
  setResetToken,
  getUserByResetToken,
  updatePassword,
  deleteUser,
  createBooking,
  deleteBookingByOwner,
  deleteBookingById
};
