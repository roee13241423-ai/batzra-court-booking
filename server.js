require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { readDb, writeDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 6..23
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

// --- seed admin on first run ---
function seedAdmin() {
  const db = readDb();
  const hasAdmin = db.users.some(u => u.isAdmin);
  if (!hasAdmin && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    db.users.push({
      id: db.nextUserId++,
      firstName: 'מנהל',
      lastName: 'מערכת',
      address: '-',
      email: process.env.ADMIN_EMAIL.toLowerCase(),
      passwordHash,
      status: 'approved',
      isAdmin: true,
      createdAt: new Date().toISOString()
    });
    writeDb(db);
    console.log(`נוצר משתמש מנהל: ${process.env.ADMIN_EMAIL}`);
  }
}
seedAdmin();

// --- helpers ---
function currentUser(req) {
  if (!req.session.userId) return null;
  const db = readDb();
  return db.users.find(u => u.id === req.session.userId) || null;
}

function requireLogin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  if (user.status !== 'approved') return res.redirect('/pending');
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  if (!user.isAdmin) return res.status(403).send('אין הרשאה');
  req.user = user;
  next();
}

// --- routes ---
app.get('/', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  if (user.status !== 'approved') return res.redirect('/pending');
  res.redirect('/booking');
});

app.get('/register', (req, res) => {
  res.render('register', { error: null, form: {} });
});

app.post('/register', (req, res) => {
  const { firstName, lastName, address, email, password, confirmPassword } = req.body;
  const form = { firstName, lastName, address, email };

  if (!firstName || !lastName || !address || !email || !password) {
    return res.render('register', { error: 'יש למלא את כל השדות', form });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'הסיסמה חייבת להכיל לפחות 6 תווים', form });
  }
  if (password !== confirmPassword) {
    return res.render('register', { error: 'הסיסמאות אינן תואמות', form });
  }

  const db = readDb();
  const emailLower = email.toLowerCase().trim();
  if (db.users.some(u => u.email === emailLower)) {
    return res.render('register', { error: 'כבר קיימת הרשמה עם כתובת מייל זו', form });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const newUser = {
    id: db.nextUserId++,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    address: address.trim(),
    email: emailLower,
    passwordHash,
    status: 'pending',
    isAdmin: false,
    createdAt: new Date().toISOString()
  };
  db.users.push(newUser);
  writeDb(db);

  req.session.userId = newUser.id;
  res.redirect('/pending');
});

app.get('/pending', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login');
  if (user.status === 'approved') return res.redirect('/booking');
  res.render('pending', { user });
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const db = readDb();
  const user = db.users.find(u => u.email === (email || '').toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.render('login', { error: 'מייל או סיסמה שגויים' });
  }
  req.session.userId = user.id;
  if (user.status !== 'approved') return res.redirect('/pending');
  res.redirect('/booking');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/booking', requireLogin, (req, res) => {
  let offset = parseInt(req.query.offset, 10);
  if (isNaN(offset) || offset < 0) offset = 0;

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

  const db = readDb();
  const grid = {};
  days.forEach(day => {
    grid[day.dateStr] = {};
    HOURS.forEach(hour => {
      const booking = db.bookings.find(b => b.date === day.dateStr && b.hour === hour);
      if (booking) {
        const owner = db.users.find(u => u.id === booking.userId);
        grid[day.dateStr][hour] = {
          taken: true,
          mine: booking.userId === req.user.id,
          ownerName: owner ? `${owner.firstName} ${owner.lastName}` : ''
        };
      } else {
        grid[day.dateStr][hour] = { taken: false, isPast: isSlotPast(day.dateStr, hour) };
      }
    });
  });

  res.render('booking', { user: req.user, days, hours: HOURS, grid, offset });
});

app.post('/booking/:date/:hour', requireLogin, (req, res) => {
  const { date } = req.params;
  const hour = parseInt(req.params.hour, 10);
  let offset = parseInt(req.query.offset, 10);
  if (isNaN(offset) || offset < 0) offset = 0;

  if (!DATE_RE.test(date) || isNaN(hour) || !HOURS.includes(hour) || isSlotPast(date, hour)) {
    return res.status(400).send('משבצת לא תקינה');
  }
  const db = readDb();
  const exists = db.bookings.some(b => b.date === date && b.hour === hour);
  if (!exists) {
    db.bookings.push({
      id: db.nextBookingId++,
      date,
      hour,
      userId: req.user.id,
      createdAt: new Date().toISOString()
    });
    writeDb(db);
  }
  res.redirect(`/booking?offset=${offset}`);
});

app.post('/booking/:date/:hour/cancel', requireLogin, (req, res) => {
  const { date } = req.params;
  const hour = parseInt(req.params.hour, 10);
  let offset = parseInt(req.query.offset, 10);
  if (isNaN(offset) || offset < 0) offset = 0;

  const db = readDb();
  const idx = db.bookings.findIndex(b => b.date === date && b.hour === hour && b.userId === req.user.id);
  if (idx !== -1) {
    db.bookings.splice(idx, 1);
    writeDb(db);
  }
  res.redirect(`/booking?offset=${offset}`);
});

app.get('/admin', requireAdmin, (req, res) => {
  const db = readDb();
  const pending = db.users.filter(u => u.status === 'pending');
  const approved = db.users.filter(u => u.status === 'approved');
  const rejected = db.users.filter(u => u.status === 'rejected');
  const bookings = db.bookings
    .filter(b => !isSlotPast(b.date, b.hour))
    .slice()
    .sort((a, b) => a.date === b.date ? a.hour - b.hour : (a.date < b.date ? -1 : 1))
    .map(b => {
      const owner = db.users.find(u => u.id === b.userId);
      const [y, m, d] = b.date.split('-');
      return {
        ...b,
        ownerName: owner ? `${owner.firstName} ${owner.lastName}` : 'לא ידוע',
        dayName: DAY_NAMES[new Date(Number(y), Number(m) - 1, Number(d)).getDay()],
        dateLabel: `${d}/${m}/${y}`
      };
    });
  res.render('admin', { user: req.user, pending, approved, rejected, bookings });
});

app.post('/admin/bookings/:id/delete', requireAdmin, (req, res) => {
  const db = readDb();
  const id = parseInt(req.params.id, 10);
  db.bookings = db.bookings.filter(b => b.id !== id);
  writeDb(db);
  res.redirect('/admin');
});

app.post('/admin/users/:id/approve', requireAdmin, (req, res) => {
  const db = readDb();
  const u = db.users.find(u => u.id === parseInt(req.params.id, 10));
  if (u) { u.status = 'approved'; writeDb(db); }
  res.redirect('/admin');
});

app.post('/admin/users/:id/reject', requireAdmin, (req, res) => {
  const db = readDb();
  const u = db.users.find(u => u.id === parseInt(req.params.id, 10));
  if (u) { u.status = 'rejected'; writeDb(db); }
  res.redirect('/admin');
});

app.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
  const db = readDb();
  const id = parseInt(req.params.id, 10);
  db.users = db.users.filter(u => u.id !== id || u.isAdmin);
  db.bookings = db.bookings.filter(b => b.userId !== id);
  writeDb(db);
  res.redirect('/admin');
});

app.listen(PORT, () => {
  console.log(`השרת פועל על פורט ${PORT}`);
});
