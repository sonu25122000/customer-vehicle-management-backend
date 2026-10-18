import nodemailer from 'nodemailer';

// Outgoing email over SMTP — works with any provider (Gmail / Google Workspace app password, Zoho,
// Brevo, Amazon SES SMTP, ...). Configured with SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM
// (see .env.example). Without SMTP_HOST nothing is sent: in development the email is printed in the
// server log instead, in production it's skipped with a warning.

let transporter = null;

function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // Port 465 is SMTP over TLS; 587/25 upgrade with STARTTLS.
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return transporter;
}

// Sends one email. Resolves to true when it was handed to the SMTP server, false when email isn't
// configured. Throws if the SMTP server rejects it.
export async function sendEmail({ to, subject, html, text }) {
  const transport = getTransporter();
  if (!transport) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(`[email] SMTP_HOST is not set — "${subject}" to ${to} was not sent`);
    } else {
      console.log(`[email:console] To: ${to}\nSubject: ${subject}\n\n${text}`);
    }
    return false;
  }
  await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
    text,
  });
  return true;
}
