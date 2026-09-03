// lib/gmail.js — Gmail powers via SMTP (send) + IMAP (read)
// Dormant until GMAIL_USER + GMAIL_APP_PASSWORD are set in .env
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

export function isGmailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function smtp() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

export async function sendEmail(to, subject, body) {
  if (!isGmailConfigured()) throw new Error('Gmail is not connected yet. Ask the bot owner to add GMAIL_USER and GMAIL_APP_PASSWORD.');
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error(`"${to}" doesn't look like a valid email address.`);

  const info = await smtp().sendMail({
    from: `"Z.ai Discord Agent" <${process.env.GMAIL_USER}>`,
    to,
    subject: subject || '(no subject)',
    text: body,
    html: body.replace(/\n/g, '<br>'),
  });
  return `Message sent to ${to} — id ${info.messageId}`;
}

/** Fetch recent inbox messages (basic search + preview) */
export async function readInbox(query = '', limit = 5) {
  if (!isGmailConfigured()) throw new Error('Gmail is not connected yet. Ask the bot owner to add GMAIL_USER and GMAIL_APP_PASSWORD.');

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
  });
  await client.connect();

  try {
    const lock = await client.getMailboxLock('INBOX');
    const out = [];
    try {
      // recent messages first; simple subject/text search when query given
      const searchOpts = query
        ? { or: [{ subject: query }, { header: 'from', value: query }] }
        : { since: new Date(Date.now() - 30 * 86400000) };

      const uids = await client.search(searchOpts, { uid: true });
      const recent = (uids || []).slice(-limit).reverse();

      for (const uid of recent) {
        const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true, uid: true });
        if (!msg) continue;
        let preview = '';
        // extract text body preview (first text part)
        try {
          for await (const part of client.fetch(uid, { bodyParts: ['text'] }, { uid: true })) {
            preview = String(part.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
            break;
          }
        } catch { /* preview optional */ }

        out.push({
          from: msg.envelope?.from?.map((a) => `${a.name || ''} <${a.address}>`).join(', ') || 'unknown',
          subject: msg.envelope?.subject || '(no subject)',
          date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : '',
          preview,
        });
      }
    } finally {
      lock.release();
    }
    return out;
  } finally {
    await client.logout().catch(() => {});
  }
}
