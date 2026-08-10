require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const mailer = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 6..23
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COURTS = [
  { id: 'footvolley', name: 'פוצ\'יוולי' },
  { id: 'tennis', name: 'טניס' }
];
const DEFAULT_COURT = 'footvolley';
function isValidCourt(court) { return COURTS.some(c => c.id === court); }
const MAX_HOURS_PER_DAY_PER_COURT = 2;
const VERIFICATION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes

// --- date helpers (local time, no timezone conversion) ---
function pad(n) { return String(n).padStart(2, '0'); }

function formatDateStr(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const d = startOfDay(date);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isSlotPast(dateStr, hour) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const slotEnd = new Date(y, m - 1, d, hour + 1);
  return slotEnd <= new Date();
}

// --- weather (Open-Meteo, free, no API key) ---
const BATZRA_LAT = 32.32;
const BATZRA_LON = 34.94;
const WEATHER_CACHE_MS = 15 * 60 * 1000; // 15 minutes
const RAINY_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);
let weatherCache = { data: null, fetchedAt: 0 };

function describeWeatherCode(code) {
  if (code === 0) return { emoji: '☀️', label: 'בהיר' };
  if (code === 1 || code === 2) return { emoji: '🌤️', label: 'בהיר עם עננים בודדים' };
  if (code === 3) return { emoji: '☁️', label: 'מעונן' };
  if (code === 45 || code === 48) return { emoji: '🌫️', label: 'ערפילי' };
  if (RAINY_CODES.has(code)) {
    if (code >= 95) return { emoji: '⛈️', label: 'סופת רעמים' };
    if (code >= 71 && code <= 77) return { emoji: '❄️', label: 'שלג' };
    return { emoji: '🌧️', label: 'גשום' };
  }
  return { emoji: '🌡️', label: '' };
}

async function getWeather() {
  const now = Date.now();
  if (weatherCache.data && now - weatherCache.fetchedAt < WEATHER_CACHE_MS) {
    return weatherCache.data;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${BATZRA_LAT}&longitude=${BATZRA_LON}&current=temperature_2m,weather_code&timezone=Asia%2FJerusalem`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`מזג אוויר: תגובה לא תקינה ${res.status}`);
    const json = await res.json();
    const tempC = Math.round(json.current.temperature_2m);
    const code = json.current.weather_code;
    const { emoji, label } = describeWeatherCode(code);
    const isGoodForPlaying = tempC >= 22 && tempC <= 34 && !RAINY_CODES.has(code);
    const data = { tempC, emoji, label, isGoodForPlaying };
    weatherCache = { data, fetchedAt: now };
    return data;
  } catch (err) {
    console.error('שגיאה בשליפת מזג אוויר:', err.message);
    return weatherCache.data; // may be null; view handles that
  }
}

function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendVerificationEmail(user, code) {
  try {
    await mailer.sendMail({
      to: user.email,
      subject: 'קוד אימות - מגרש מושב בצרה',
      html: `
        <div dir="rtl" style="font-family: Arial, sans-serif;">
          <p>שלום ${user.firstName},</p>
          <p>קוד האימות שלך להרשמה לאתר שריון המגרש הוא:</p>
          <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">${code}</p>
          <p>הקוד בתוקף ל-15 דקות.</p>
        </div>
      `
    });
  } catch (err) {
    console.error('שגיאה בשליחת מייל אימות:', err.message);
  }
}

async function sendResetEmail(user, resetUrl) {
  try {
    await mailer.sendMail({
      to: user.email,
      subject: 'איפוס סיסמה - מגרש מושב בצרה',
      html: `
        <div dir="rtl" style="font-family: Arial, sans-serif;">
          <p>שלום ${user.firstName},</p>
          <p>קיבלנו בקשה לאיפוס הסיסמה שלך. ללחוץ על הקישור כדי לבחור סיסמה חדשה:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>הקישור בתוקף ל-30 דקות. אם לא ביקשת לאפס סיסמה, אפשר להתעלם מהמייל הזה.</p>
        </div>
      `
    });
  } catch (err) {
    console.error('שגיאה בשליחת מייל איפוס סיסמה:', err.message);
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 days
}));

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function applyRememberMe(req, remembered) {
  if (remembered) {
    req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 days
  } else {
    req.session.cookie.expires = false; // browser-session cookie, cleared on close
  }
}

// --- helpers ---
async function currentUser(req) {
  if (!req.session.userId) return null;
  return db.getUserById(req.session.userId);
}

function postLoginRedirect(user) {
  if (!user.emailVerified) return '/verify-email';
  if (user.status !== 'approved') return '/pending';
  return '/booking';
}

function requireLogin(fn) {
  return asyncRoute(async (req, res, next) => {
    const user = await currentUser(req);
    if (!user) return res.redirect('/login');
    if (!user.emailVerified) return res.redirect('/verify-email');
    if (user.status !== 'approved') return res.redirect('/pending');
    req.user = user;
    return fn(req, res, next);
  });
}

function requireAdmin(fn) {
  return asyncRoute(async (req, res, next) => {
    const user = await currentUser(req);
    if (!user) return res.redirect('/login');
    if (!user.isAdmin) return res.status(403).send('אין הרשאה');
    req.user = user;
    return fn(req, res, next);
  });
}

// --- routes ---
app.get('/', asyncRoute(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/login');
  res.redirect(postLoginRedirect(user));
}));

app.get('/register', (req, res) => {
  res.render('register', { error: null, form: {} });
});

app.post('/register', asyncRoute(async (req, res) => {
  const { firstName, lastName, address, phone, email, password, confirmPassword } = req.body;
  const form = { firstName, lastName, address, phone, email };

  if (!firstName || !lastName || !address || !phone || !email || !password) {
    return res.render('register', { error: 'יש למלא את כל השדות', form });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'הסיסמה חייבת להכיל לפחות 6 תווים', form });
  }
  if (password !== confirmPassword) {
    return res.render('register', { error: 'הסיסמאות אינן תואמות', form });
  }

  const emailLower = email.toLowerCase().trim();
  const existing = await db.getUserByEmail(emailLower);
  if (existing) {
    return res.render('register', { error: 'כבר קיימת הרשמה עם כתובת מייל זו', form });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const code = generateVerificationCode();
  const expires = new Date(Date.now() + VERIFICATION_TTL_MS);

  const newUser = await db.createUser({
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    address: address.trim(),
    phone: phone.trim(),
    email: emailLower,
    passwordHash,
    status: 'pending',
    isAdmin: false,
    emailVerified: false,
    verificationCode: code,
    verificationExpires: expires
  });

  sendVerificationEmail(newUser, code); // fire-and-forget: mail delivery shouldn't block registration

  req.session.userId = newUser.id;
  applyRememberMe(req, !!req.body.rememberMe);
  res.redirect('/verify-email');
}));

app.get('/verify-email', asyncRoute(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/login');
  if (user.emailVerified) return res.redirect(postLoginRedirect(user));
  res.render('verify-email', { user, error: null, sent: false });
}));

app.post('/verify-email', asyncRoute(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/login');
  if (user.emailVerified) return res.redirect(postLoginRedirect(user));

  const { code } = req.body;
  const expired = !user.verificationExpires || new Date(user.verificationExpires) < new Date();
  if (!code || !user.verificationCode || code.trim() !== user.verificationCode || expired) {
    return res.render('verify-email', { user, error: expired ? 'הקוד פג תוקף, יש לבקש קוד חדש' : 'קוד שגוי', sent: false });
  }

  await db.markEmailVerified(user.id);
  const updatedUser = await db.getUserById(user.id);
  res.redirect(postLoginRedirect(updatedUser));
}));

app.post('/verify-email/resend', asyncRoute(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/login');
  if (user.emailVerified) return res.redirect(postLoginRedirect(user));

  const code = generateVerificationCode();
  const expires = new Date(Date.now() + VERIFICATION_TTL_MS);
  await db.setVerificationCode(user.id, code, expires);
  sendVerificationEmail(user, code); // fire-and-forget, see /register

  res.render('verify-email', { user, error: null, sent: true });
}));

app.get('/pending', asyncRoute(async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/login');
  if (!user.emailVerified) return res.redirect('/verify-email');
  if (user.status === 'approved') return res.redirect('/booking');
  res.render('pending', { user });
}));

app.get('/login', (req, res) => {
  res.render('login', { error: null, resetSuccess: req.query.resetSuccess === '1' });
});

app.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body;
  const user = await db.getUserByEmail((email || '').toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.render('login', { error: 'מייל או סיסמה שגויים', resetSuccess: false });
  }
  req.session.userId = user.id;
  applyRememberMe(req, !!req.body.rememberMe);
  res.redirect(postLoginRedirect(user));
}));

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { error: null, sent: false, notFound: false });
});

app.post('/forgot-password', asyncRoute(async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const user = await db.getUserByEmail(email);

  if (!user) {
    return res.render('forgot-password', { error: null, sent: false, notFound: true });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TTL_MS);
  await db.setResetToken(user.id, token, expires);
  const resetUrl = `${req.protocol}://${req.get('host')}/reset-password/${token}`;
  sendResetEmail(user, resetUrl); // fire-and-forget, see /register

  res.render('forgot-password', { error: null, sent: true, notFound: false });
}));

app.get('/reset-password/:token', asyncRoute(async (req, res) => {
  const user = await db.getUserByResetToken(req.params.token);
  const expired = !user || !user.resetExpires || new Date(user.resetExpires) < new Date();
  if (expired) {
    return res.render('reset-password', { error: 'הקישור לא תקין או שפג תוקפו. יש לבקש קישור חדש.', token: null });
  }
  res.render('reset-password', { error: null, token: req.params.token });
}));

app.post('/reset-password/:token', asyncRoute(async (req, res) => {
  const user = await db.getUserByResetToken(req.params.token);
  const expired = !user || !user.resetExpires || new Date(user.resetExpires) < new Date();
  if (expired) {
    return res.render('reset-password', { error: 'הקישור לא תקין או שפג תוקפו. יש לבקש קישור חדש.', token: null });
  }

  const { password, confirmPassword } = req.body;
  if (!password || password.length < 6) {
    return res.render('reset-password', { error: 'הסיסמה חייבת להכיל לפחות 6 תווים', token: req.params.token });
  }
  if (password !== confirmPassword) {
    return res.render('reset-password', { error: 'הסיסמאות אינן תואמות', token: req.params.token });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  await db.updatePassword(user.id, passwordHash);
  res.redirect('/login?resetSuccess=1');
}));

app.get('/booking', requireLogin(async (req, res) => {
  let offset = parseInt(req.query.offset, 10);
  if (isNaN(offset) || offset < 0) offset = 0;
  const court = isValidCourt(req.query.court) ? req.query.court : DEFAULT_COURT;

  const weekStart = addDays(startOfWeek(new Date()), offset * 7);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    days.push({
      dateStr: formatDateStr(date),
      dayName: DAY_NAMES[date.getDay()],
      label: `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`
    });
  }

  const [allBookings, users, weather] = await Promise.all([db.getAllBookings(), db.getAllUsers(), getWeather()]);
  const bookings = allBookings.filter(b => b.court === court);
  const usersById = new Map(users.map(u => [u.id, u]));

  const today = new Date();
  const todayLabel = `יום ${DAY_NAMES[today.getDay()]}, ${pad(today.getDate())}/${pad(today.getMonth() + 1)}/${today.getFullYear()}`;

  const grid = {};
  days.forEach(day => {
    grid[day.dateStr] = {};
    HOURS.forEach(hour => {
      const booking = bookings.find(b => b.date === day.dateStr && b.hour === hour);
      if (booking) {
        const owner = usersById.get(booking.userId);
        grid[day.dateStr][hour] = {
          taken: true,
          mine: booking.userId === req.user.id,
          ownerName: owner ? `${owner.firstName} ${owner.lastName}` : '',
          ownerPhone: owner ? owner.phone : '',
          ownerEmail: owner ? owner.email : ''
        };
      } else {
        grid[day.dateStr][hour] = { taken: false, isPast: isSlotPast(day.dateStr, hour) };
      }
    });
  });

  const dailyLimitReached = req.query.error === 'limit';

  res.render('booking', { user: req.user, days, hours: HOURS, grid, offset, courts: COURTS, court, dailyLimitReached, weather, todayLabel });
}));

app.post('/booking/:date/:hour', requireLogin(async (req, res) => {
  const { date } = req.params;
  const hour = parseInt(req.params.hour, 10);
  let offset = parseInt(req.query.offset, 10);
  if (isNaN(offset) || offset < 0) offset = 0;
  const court = isValidCourt(req.query.court) ? req.query.court : DEFAULT_COURT;

  if (!DATE_RE.test(date) || isNaN(hour) || !HOURS.includes(hour) || isSlotPast(date, hour)) {
    return res.status(400).send('משבצת לא תקינה');
  }

  const existingCount = await db.countUserBookingsForDate(req.user.id, court, date);
  if (existingCount >= MAX_HOURS_PER_DAY_PER_COURT) {
    return res.redirect(`/booking?offset=${offset}&court=${court}&error=limit`);
  }

  await db.createBooking(court, date, hour, req.user.id);
  res.redirect(`/booking?offset=${offset}&court=${court}`);
}));

app.post('/booking/:date/:hour/cancel', requireLogin(async (req, res) => {
  const { date } = req.params;
  const hour = parseInt(req.params.hour, 10);
  let offset = parseInt(req.query.offset, 10);
  if (isNaN(offset) || offset < 0) offset = 0;
  const court = isValidCourt(req.query.court) ? req.query.court : DEFAULT_COURT;

  await db.deleteBookingByOwner(court, date, hour, req.user.id);
  res.redirect(`/booking?offset=${offset}&court=${court}`);
}));

app.get('/admin', requireAdmin(async (req, res) => {
  const [users, bookings] = await Promise.all([db.getAllUsers(), db.getAllBookings()]);
  const usersById = new Map(users.map(u => [u.id, u]));

  const pending = users.filter(u => u.status === 'pending');
  const approved = users.filter(u => u.status === 'approved');
  const rejected = users.filter(u => u.status === 'rejected');

  const upcoming = bookings
    .filter(b => !isSlotPast(b.date, b.hour))
    .sort((a, b) => a.date === b.date ? a.hour - b.hour : (a.date < b.date ? -1 : 1))
    .map(b => {
      const owner = usersById.get(b.userId);
      const [y, m, d] = b.date.split('-');
      return {
        ...b,
        ownerName: owner ? `${owner.firstName} ${owner.lastName}` : 'לא ידוע',
        courtName: (COURTS.find(c => c.id === b.court) || {}).name || b.court,
        dayName: DAY_NAMES[new Date(Number(y), Number(m) - 1, Number(d)).getDay()],
        dateLabel: `${d}/${m}/${y}`
      };
    });

  res.render('admin', { user: req.user, pending, approved, rejected, bookings: upcoming });
}));

app.post('/admin/bookings/:id/delete', requireAdmin(async (req, res) => {
  await db.deleteBookingById(parseInt(req.params.id, 10));
  res.redirect('/admin');
}));

app.post('/admin/users/:id/verify-email', requireAdmin(async (req, res) => {
  await db.markEmailVerified(parseInt(req.params.id, 10));
  res.redirect('/admin');
}));

app.post('/admin/users/:id/approve', requireAdmin(async (req, res) => {
  await db.setUserStatus(parseInt(req.params.id, 10), 'approved');
  res.redirect('/admin');
}));

app.post('/admin/users/:id/reject', requireAdmin(async (req, res) => {
  await db.setUserStatus(parseInt(req.params.id, 10), 'rejected');
  res.redirect('/admin');
}));

app.post('/admin/users/:id/delete', requireAdmin(async (req, res) => {
  await db.deleteUser(parseInt(req.params.id, 10));
  res.redirect('/admin');
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('שגיאת שרת');
});

async function start() {
  await db.init();

  const hasAdmin = await db.hasAdmin();
  if (!hasAdmin && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    await db.createUser({
      firstName: 'מנהל',
      lastName: 'מערכת',
      address: '-',
      phone: '',
      email: process.env.ADMIN_EMAIL.toLowerCase(),
      passwordHash,
      status: 'approved',
      isAdmin: true,
      emailVerified: true
    });
    console.log(`נוצר משתמש מנהל: ${process.env.ADMIN_EMAIL}`);
  }

  app.listen(PORT, () => {
    console.log(`השרת פועל על פורט ${PORT}`);
  });
}

start().catch(err => {
  console.error('כשל באתחול השרת:', err);
  process.exit(1);
});
