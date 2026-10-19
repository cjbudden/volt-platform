/**
 * DELIVERY OF SECURITY CODES (sign-in codes, email and phone verification).
 *
 * These deliberately do NOT go through the notifications service: that stores
 * every message body (and shows it in the console inbox), and a sign-in code
 * must never be written down anywhere readable. They are sent directly and
 * only the fact of sending is logged.
 *
 * EMAIL  SMTP_URL + NOTIFY_FROM (the same settings notifications use).
 * SMS    SMS_PROVIDER=sns  AWS SNS (task role needs sns:Publish). Optional
 *                          SMS_SENDER_ID (alphanumeric sender, where the
 *                          destination country allows it) and SMS_ORIGINATION_NUMBER.
 *        SMS_PROVIDER=log  write the message to the API log (dev and staging only).
 *        unset             'log' outside production, otherwise SMS is unavailable.
 *
 * Outside production, SECURITY_CODE_ECHO=1 also returns the code in the API
 * response (`devCode`) so automated tests can complete the flow. It is ignored
 * when NODE_ENV=production.
 */
import { sendMail, parseSmtpUrl } from './mail/smtp';
import { ApiError } from '../util/http';

const prod = () => process.env.NODE_ENV === 'production';

export function echoCodes(): boolean {
  return !prod() && process.env.SECURITY_CODE_ECHO === '1';
}

export function emailAvailable(): boolean {
  return (!!process.env.SMTP_URL && !!process.env.NOTIFY_FROM) || !prod();
}

function smsProvider(): 'sns' | 'log' | null {
  const p = (process.env.SMS_PROVIDER ?? '').toLowerCase();
  if (p === 'sns') return 'sns';
  if (p === 'log') return prod() ? null : 'log';
  return prod() ? null : 'log';
}

export function smsAvailable(): boolean {
  return smsProvider() !== null;
}

const mask = (s: string) => s.replace(/\d(?=\d{2})/g, '•');

export async function sendSecurityEmail(to: string, subject: string, text: string): Promise<void> {
  const url = process.env.SMTP_URL, from = process.env.NOTIFY_FROM;
  if (url && from) {
    try { await sendMail(parseSmtpUrl(url), { from, to, subject, text }); }
    catch (e: any) {
      console.error('[security] email delivery failed', to, e?.message);
      throw new ApiError(502, 'The email could not be sent. Try again in a moment.');
    }
    return;
  }
  if (prod()) throw new ApiError(503, 'Email is not configured on this deployment (SMTP_URL, NOTIFY_FROM).');
  console.log(`[security] (dev, no SMTP) email to ${to}: ${subject}\n${text}`);
}

let sns: any = null;
export async function sendSecuritySms(to: string, text: string): Promise<void> {
  const p = smsProvider();
  if (!p) throw new ApiError(503, 'Text messages are not configured on this deployment (SMS_PROVIDER).');
  if (p === 'log') { console.log(`[security] (dev) SMS to ${to}: ${text}`); return; }
  try {
    const m = await import('@aws-sdk/client-sns');
    sns ??= new m.SNSClient({ region: process.env.SMS_REGION || process.env.AWS_REGION || 'ap-southeast-2' });
    const attrs: Record<string, any> = { 'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' } };
    if (process.env.SMS_SENDER_ID) attrs['AWS.SNS.SMS.SenderID'] = { DataType: 'String', StringValue: process.env.SMS_SENDER_ID };
    if (process.env.SMS_ORIGINATION_NUMBER) attrs['AWS.MM.SMS.OriginationNumber'] = { DataType: 'String', StringValue: process.env.SMS_ORIGINATION_NUMBER };
    await sns.send(new m.PublishCommand({ PhoneNumber: to, Message: text, MessageAttributes: attrs }));
    console.log(`[security] SMS sent to ${mask(to)}`);
  } catch (e: any) {
    console.error('[security] SMS delivery failed', mask(to), e?.name, e?.message);
    throw new ApiError(502, 'The text message could not be sent. Check the number or try again in a moment.');
  }
}
