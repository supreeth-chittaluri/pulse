export type SendResult = { providerMessageId: string };

/**
 * A thing that can deliver a message.
 *
 * Every test in this package runs against a fake implementation. Real SMS costs
 * real money, so a test suite that could accidentally send one is a test suite
 * that will eventually send a hundred.
 */
export interface Notifier {
  readonly channel: 'sms';
  readonly from: string;
  send(to: string, body: string): Promise<SendResult>;
}

export class NotifierError extends Error {
  readonly status: number | null;
  /** False for a bad number or bad credentials -- retrying those just burns money. */
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'NotifierError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Masks a phone number for storage: "+15551234821" -> "+1******4821".
 *
 * The real destination lives in .env; there is no reason for the database, the
 * logs, or a screenshot of either to carry it in clear.
 */
export function maskNumber(number: string): string {
  const trimmed = number.trim();
  if (trimmed.length <= 6) return '*'.repeat(trimmed.length);
  const prefix = trimmed.startsWith('+') ? trimmed.slice(0, 2) : trimmed.slice(0, 1);
  const last4 = trimmed.slice(-4);
  return `${prefix}${'*'.repeat(Math.max(1, trimmed.length - prefix.length - 4))}${last4}`;
}
