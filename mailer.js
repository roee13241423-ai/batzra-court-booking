// Render's free tier blocks outbound SMTP, so email is sent over Brevo's
// HTTPS transactional email API instead of SMTP.
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

async function sendMail({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.MAIL_FROM_EMAIL;

  if (!apiKey || !fromEmail) {
    console.warn(`שליחת מייל דולגה (BREVO_API_KEY/MAIL_FROM_EMAIL לא מוגדרים) - אל: ${to}, נושא: ${subject}`);
    return;
  }

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      sender: { email: fromEmail, name: 'מגרש מושב בצרה' },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Brevo API error ${res.status}: ${text}`);
  }
}

module.exports = { sendMail };
