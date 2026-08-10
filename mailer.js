const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
  return transporter;
}

async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    console.warn(`שליחת מייל דולגה (GMAIL_USER/GMAIL_APP_PASSWORD לא מוגדרים) - אל: ${to}, נושא: ${subject}`);
    return;
  }
  await t.sendMail({
    from: `מגרש מושב בצרה <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html
  });
}

module.exports = { sendMail };
