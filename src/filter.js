export const LIST_ADDRESS = 'cs3157@lists.cs.columbia.edu';
export const GMAIL_FILTER = `to:${LIST_ADDRESS} -subject:ANN`;
export const NO_SUBJECT = '(No subject)';
export const TEST_MESSAGE_TEXT =
  '[ListRelay test] This is a test message from ListRelay. It was not triggered by an email.';

const MAX_SUBJECT_LENGTH = 3000;
const OUTGOING_LABELS = new Set(['SENT', 'DRAFT']);

export function buildGmailQuery(filter, sinceMs) {
  return `${filter} after:${Math.floor(sinceMs / 1000)}`;
}

/**
 * Mirrors Gmail's word-based `subject:ANN` match (case-insensitive, whole token),
 * so "[ANN] HW1" matches but "Annual review" does not.
 */
export function subjectMatchesAnn(subject) {
  return /(^|[^\p{L}\p{N}])ann(?=[^\p{L}\p{N}]|$)/iu.test(subject ?? '');
}

const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

export function decodeMimeWords(input) {
  const joined = input.replace(/(\?=)\s+(?==\?)/g, '$1');
  return joined.replace(ENCODED_WORD, (whole, charset, encoding, text) => {
    try {
      const bytes =
        encoding.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text
                .replace(/_/g, ' ')
                .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
              'latin1',
            );
      return new TextDecoder(charset.split('*')[0].toLowerCase()).decode(bytes);
    } catch {
      return whole;
    }
  });
}

export function normalizeSubject(raw) {
  const cleaned = decodeMimeWords(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return NO_SUBJECT;
  return cleaned.length > MAX_SUBJECT_LENGTH ? `${cleaned.slice(0, MAX_SUBJECT_LENGTH - 1)}…` : cleaned;
}

/** Escapes Slack control characters so subjects can never form mentions or links. */
export function toSlackText(subject) {
  return subject.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function parseEmailAddress(header) {
  if (!header) return null;
  const angled = header.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = angled ? angled[1] : header.match(/[^\s<>"',;]+@[^\s<>"',;]+/)?.[0];
  return bare ? bare.toLowerCase() : null;
}

export function isOutgoing(message, accountEmail) {
  if ((message.labelIds ?? []).some((label) => OUTGOING_LABELS.has(label))) return true;
  const from = parseEmailAddress(message.from);
  return Boolean(from && accountEmail && from === accountEmail.toLowerCase());
}
