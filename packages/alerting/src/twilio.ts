import { NotifierError, type Notifier, type SendResult } from './notifier.ts';

export type TwilioOptions = {
  accountSid: string;
  authToken: string;
  from: string;
  timeoutMs?: number;
};

/**
 * Twilio over its REST API directly, rather than the SDK.
 *
 * Sending an SMS is one authenticated form POST. The official package pulls in
 * a large dependency tree to wrap that, and this is the one code path in the
 * project where an unexpected retry costs money -- so it is worth being able to
 * read the whole thing.
 */
export function createTwilioNotifier(options: TwilioOptions): Notifier {
  const { accountSid, authToken, from, timeoutMs = 15_000 } = options;
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;

  return {
    channel: 'sms',
    from,

    async send(to: string, body: string): Promise<SendResult> {
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const form = new URLSearchParams({ To: to, From: from, Body: body });

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Basic ${auth}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // A network failure is genuinely retryable; the message may not have
        // been accepted at all.
        throw new NotifierError(`Twilio request failed: ${(err as Error).message}`, null, true);
      }

      const text = await response.text();
      let payload: { sid?: string; message?: string; code?: number } = {};
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        /* Twilio returned something unexpected; fall through to the raw text */
      }

      if (!response.ok) {
        // 4xx means the request itself is wrong -- bad credentials, an
        // unverified number, a malformed To. Retrying spends money to fail
        // again, so only 429 and 5xx are marked retryable.
        const retryable = response.status === 429 || response.status >= 500;
        throw new NotifierError(
          `Twilio ${response.status}: ${payload.message ?? text.slice(0, 200)}` +
            (payload.code ? ` (code ${payload.code})` : ''),
          response.status,
          retryable,
        );
      }

      if (!payload.sid) {
        throw new NotifierError('Twilio accepted the request but returned no sid', null, false);
      }
      return { providerMessageId: payload.sid };
    },
  };
}
