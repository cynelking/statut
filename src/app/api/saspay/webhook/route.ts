import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { asRecord, getAdminClient, getSasPayConfig, sasPayRequest } from '@/lib/saspay-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOLERANCE_SECONDS = 300;

function validSignature(rawBody: string, signature: string, timestamp: string, secret: string) {
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function applyCampaignTransaction(
  admin: ReturnType<typeof getAdminClient>,
  transactionId: string,
  eventData: Record<string, unknown>,
  eventStatus: 'SUCCESS' | 'FAILED',
) {
  const amount = Number(eventData.amount);
  const currency = typeof eventData.currency === 'string' ? eventData.currency : '';
  if (!Number.isFinite(amount) || !currency) return false;

  const { data: candidates, error } = await admin.from('saspay_campaign_payments')
    .select('id,amount,currency,country,checkout_session_id')
    .eq('status', 'pending')
    .not('checkout_session_id', 'is', null)
    .eq('currency', currency)
    .eq('amount', amount)
    .limit(1000);
  if (error) throw error;

  const eventCountry = typeof eventData.country === 'string' ? eventData.country : '';
  const likely = (candidates ?? []).filter((candidate) =>
    !eventCountry || candidate.country === eventCountry,
  );
  if (!likely.length) return false;

  for (let offset = 0; offset < likely.length; offset += 5) {
    const batch = likely.slice(offset, offset + 5);
    const matches = await Promise.all(batch.map(async (candidate) => {
      if (!candidate.checkout_session_id) return null;
      const session = asRecord(await sasPayRequest(
        `/checkout-sessions/${encodeURIComponent(candidate.checkout_session_id)}/status/`,
      ));
      return session.transaction_id === transactionId
        && session.transaction_status === eventStatus
        ? candidate
        : null;
    }));
    const match = matches.find((candidate) => candidate !== null);
    if (!match) continue;

    const verified = asRecord(await sasPayRequest(`/payments/${encodeURIComponent(transactionId)}/verify/`));
    const status = verified.status === 'SUCCESS' || verified.status === 'FAILED'
      ? verified.status
      : eventStatus;
    const result = await admin.rpc('complete_saspay_campaign_payment', {
      p_payment_id: match.id,
      p_provider_transaction_id: transactionId,
      p_status: status,
      p_net_amount: Number(verified.net_amount || 0),
      p_currency: String(verified.currency || ''),
    });
    if (result.error) throw result.error;
    return true;
  }
  return false;
}

async function applyWalletTopupTransaction(
  admin: ReturnType<typeof getAdminClient>,
  transactionId: string,
  eventData: Record<string, unknown>,
  eventStatus: 'SUCCESS' | 'FAILED',
) {
  const amount = Number(eventData.amount);
  const currency = typeof eventData.currency === 'string' ? eventData.currency : '';
  if (!Number.isFinite(amount) || !currency) return false;

  const { data: candidates, error } = await admin.from('saspay_wallet_topups')
    .select('id,amount,currency,country,checkout_session_id')
    .in('status', ['pending', 'failed'])
    .not('checkout_session_id', 'is', null)
    .eq('currency', currency)
    .eq('amount', amount)
    .limit(1000);
  if (error) throw error;

  const eventCountry = typeof eventData.country === 'string' ? eventData.country : '';
  const likely = (candidates ?? []).filter((candidate) =>
    !eventCountry || candidate.country === eventCountry,
  );
  if (!likely.length) return false;

  for (let offset = 0; offset < likely.length; offset += 5) {
    const batch = likely.slice(offset, offset + 5);
    const matches = await Promise.all(batch.map(async (candidate) => {
      if (!candidate.checkout_session_id) return null;
      const session = asRecord(await sasPayRequest(
        `/checkout-sessions/${encodeURIComponent(candidate.checkout_session_id)}/status/`,
      ));
      return session.transaction_id === transactionId
        && session.transaction_status === eventStatus
        ? candidate
        : null;
    }));
    const match = matches.find((candidate) => candidate !== null);
    if (!match) continue;

    const verified = asRecord(await sasPayRequest(`/payments/${encodeURIComponent(transactionId)}/verify/`));
    const status = verified.status === 'SUCCESS' || verified.status === 'FAILED'
      ? verified.status : eventStatus;
    const result = await admin.rpc('complete_saspay_wallet_topup', {
      p_topup_id: match.id,
      p_provider_transaction_id: transactionId,
      p_status: status,
      p_net_amount: Number(verified.net_amount || 0),
      p_currency: String(verified.currency || ''),
    });
    if (result.error) throw result.error;
    return true;
  }
  return false;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-webhook-signature') || '';
  const timestamp = request.headers.get('x-webhook-timestamp') || '';
  const eventHeader = request.headers.get('x-webhook-event') || '';
  const secret = process.env.SASPAY_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 });
  if (!validSignature(rawBody, signature, timestamp, secret)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  try {
    const payload = asRecord(JSON.parse(rawBody));
    const event = typeof payload.event === 'string' ? payload.event : '';
    const data = asRecord(payload.data);
    if (!event || event !== eventHeader) return NextResponse.json({ error: 'invalid_event' }, { status: 400 });

    const transactionId = typeof data.id === 'string' ? data.id : '';
    const status = typeof data.status === 'string' ? data.status : '';
    if (event.startsWith('transaction.') && transactionId) {
      const admin = getAdminClient();
      const { data: withdrawal, error } = await admin.from('withdrawals')
        .select('id')
        .eq('saspay_payout_id', transactionId)
        .maybeSingle();
      if (error) throw error;

      if (withdrawal) {
        if (status === 'SUCCESS' || status === 'FAILED' || status === 'PENDING') {
          const result = await admin.rpc('complete_saspay_payout', {
            p_provider_payout_id: transactionId,
            p_status: status,
          });
          if (result.error) throw result.error;
        }
      } else if (data.flow_direction === 'OUTBOUND' || data.type === 'RETRAIT') {
        console.warn('SasPay payout webhook received before its withdrawal reference was saved', transactionId);
        return NextResponse.json({ error: 'payout_not_mapped_yet' }, { status: 503 });
      } else if (status === 'SUCCESS' || status === 'FAILED') {
        const { baseUrl } = getSasPayConfig();
        const campaignMatched = await applyCampaignTransaction(
          admin,
          transactionId,
          data,
          status,
        );
        const topupMatched = campaignMatched ? false : await applyWalletTopupTransaction(
          admin,
          transactionId,
          data,
          status,
        );
        if (!campaignMatched && !topupMatched && baseUrl === 'https://sandbox-api.saspay.me/api/v1') {
          console.info('SasPay sandbox transaction webhook did not match a pending StatutPay payment', transactionId);
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error('SasPay webhook processing failed', message);
    return NextResponse.json({ error: 'webhook_processing_failed' }, { status: 500 });
  }
}
