import nodemailer from 'nodemailer';

export function createMailer({
  from,
  mode,
  production = false,
  smtpHost,
  smtpPassword,
  smtpPort,
  smtpRequireTls = true,
  smtpSecure,
  smtpUser,
  transportFactory = nodemailer.createTransport,
}) {
  if (!['console', 'smtp'].includes(mode) || (production && mode !== 'smtp')) {
    throw new Error('MAIL_TRANSPORT must be smtp in production or console in development');
  }
  if (
    mode === 'smtp'
    && (typeof smtpHost !== 'string' || !smtpHost || !Number.isInteger(smtpPort)
      || smtpPort < 1 || smtpPort > 65_535)
  ) {
    throw new Error('SMTP_HOST and SMTP_PORT must identify a valid SMTP server');
  }
  const transport = mode === 'smtp'
    ? transportFactory({
      auth: smtpUser ? { pass: smtpPassword, user: smtpUser } : undefined,
      host: smtpHost,
      port: smtpPort,
      requireTLS: !smtpSecure && smtpRequireTls,
      secure: smtpSecure,
    })
    : null;

  async function deliver({ email, subject, text }) {
    if (!transport) {
      console.info(`[development mail] ${subject} for ${email}: ${text}`);
      return;
    }
    await transport.sendMail({ from, subject, text, to: email });
  }

  return {
    sendAccountVerified({ email }) {
      return deliver({
        email,
        subject: 'Your roriwalrus account is verified',
        text: 'Your email is verified. You can now sign in to roriwalrus.',
      });
    },
    sendPasswordReset({ email, url }) {
      return deliver({
        email,
        subject: 'Reset your roriwalrus password',
        text: `Use this one-time link within one hour to reset your password:\n\n${url}`,
      });
    },
    sendVerification({ email, url }) {
      return deliver({
        email,
        subject: 'Verify your roriwalrus account',
        text: `Use this one-time link within 24 hours to verify your account:\n\n${url}`,
      });
    },
  };
}