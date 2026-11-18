import { createClient, type User } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import type { SasPayCountry, SasPayNetwork } from '@/lib/saspay';

const API_BASES = [
  'https://sandbox-api.saspay.me/api/v1',
  'https://api.saspay.me/api/v1',
];

export function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase server credentials are not configured');
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function getRequestUser(request: NextRequest): Promise<{ user: User; token: string } | null> {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!token || !url || !key) return null;

  const client = createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return { user: data.user, token };
}

export function getUserClient(token: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase public credentials are not configured');
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export function getSasPayConfig() {
  const baseUrl = (process.env.SASPAY_API_BASE_URL || API_BASES[0]).replace(/\/+$/, '');
  const apiKey = process.env.SASPAY_API_KEY;
  if (!API_BASES.includes(baseUrl)) throw new Error('SASPAY_API_BASE_URL is not an allowed SasPay API URL');
  if (!apiKey) throw new Error('SASPAY_API_KEY is not configured');
  return { baseUrl, apiKey };
}

export async function sasPayRequest(path: string, init: RequestInit = {}) {
  const { baseUrl, apiKey } = getSasPayConfig();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`SasPay returned an invalid response (HTTP ${response.status})`);
  }

  if (!response.ok) {
    const body = asRecord(payload);
    const details = asRecord(body.error);
    const message = typeof details.message === 'string'
      ? details.message
      : typeof body.message === 'string' ? body.message : `SasPay request failed (HTTP ${response.status})`;
    const error = new Error(message) as Error & { status: number; code?: string };
    error.status = response.status;
    error.code = typeof details.code === 'string'
      ? details.code
      : typeof body.code === 'string' ? body.code : undefined;
    throw error;
  }

  return unwrapSasPayData(payload);
}

export async function listSasPayNetworks() {
  const countryResult = await sasPayRequest('/countries/');
  if (!Array.isArray(countryResult)) throw new Error('SasPay countries response is invalid');
  const countries = (countryResult as (SasPayCountry & { id: string })[])
    .filter((country) => country && typeof country.iso_code === 'string')
    .map(({ iso_code, name, default_currency }) => ({ iso_code, name, default_currency }));
  const idsToCodes = new Map(
    (countryResult as (SasPayCountry & { id: string })[])
      .filter((country) => country && typeof country.id === 'string')
      .map((country) => [country.id, country.iso_code]),
  );
  const networks: SasPayNetwork[] = [];

  for (let page = 1; page <= 20; page++) {
    const result = asRecord(await sasPayRequest(`/networks/?page=${page}&page_size=100`));
    const entries = Array.isArray(result.results) ? result.results : [];
    for (const raw of entries) {
      const network = asRecord(raw);
      const countryId = typeof network.country === 'string' ? network.country : '';
      const code = typeof network.code === 'string' ? network.code : '';
      const name = typeof network.name === 'string' ? network.name : '';
      if (code && name && countryId) {
        networks.push({
          code,
          name,
          country: idsToCodes.get(countryId) || countryId,
          is_active: network.is_active === true,
        });
      }
    }
    if (!result.next || entries.length < 100) break;
  }

  return { countries, networks };
}

export async function syncSasPayCampaignPayment(paymentId: string, sessionId: string) {
  const admin = getAdminClient();
  const session = asRecord(await sasPayRequest(
    `/checkout-sessions/${encodeURIComponent(sessionId)}/status/`,
  ));
  if (session.status === 'EXPIRED' || session.status === 'CANCELLED') {
    const expired = await admin.rpc('expire_saspay_campaign_payment', { p_payment_id: paymentId });
    if (expired.error) throw expired.error;
    return 'failed';
  }

  const transactionId = typeof session.transaction_id === 'string' ? session.transaction_id : '';
  const transactionStatus = typeof session.transaction_status === 'string' ? session.transaction_status : '';
  if (!transactionId || (transactionStatus !== 'SUCCESS' && transactionStatus !== 'FAILED')) return 'pending';

  const verified = asRecord(await sasPayRequest(`/payments/${encodeURIComponent(transactionId)}/verify/`));
  const status = verified.status === 'SUCCESS' || verified.status === 'FAILED'
    ? verified.status : transactionStatus;
  const result = await admin.rpc('complete_saspay_campaign_payment', {
    p_payment_id: paymentId,
    p_provider_transaction_id: transactionId,
    p_status: status,
    p_net_amount: Number(verified.net_amount || 0),
    p_currency: String(verified.currency || ''),
  });
  if (result.error) throw result.error;
  return String(result.data);
}

export async function syncSasPayWalletTopup(topupId: string, sessionId: string) {
  const admin = getAdminClient();
  const session = asRecord(await sasPayRequest(
    `/checkout-sessions/${encodeURIComponent(sessionId)}/status/`,
  ));
  if (session.status === 'EXPIRED' || session.status === 'CANCELLED') {
    const expired = await admin.rpc('expire_saspay_wallet_topup', { p_topup_id: topupId });
    if (expired.error) throw expired.error;
    return 'failed';
  }

  const transactionId = typeof session.transaction_id === 'string' ? session.transaction_id : '';
  const transactionStatus = typeof session.transaction_status === 'string' ? session.transaction_status : '';
  if (!transactionId || (transactionStatus !== 'SUCCESS' && transactionStatus !== 'FAILED')) return 'pending';

  const verified = asRecord(await sasPayRequest(`/payments/${encodeURIComponent(transactionId)}/verify/`));
  const status = verified.status === 'SUCCESS' || verified.status === 'FAILED'
    ? verified.status : transactionStatus;
  const result = await admin.rpc('complete_saspay_wallet_topup', {
    p_topup_id: topupId,
    p_provider_transaction_id: transactionId,
    p_status: status,
    p_net_amount: Number(verified.net_amount || 0),
    p_currency: String(verified.currency || ''),
  });
  if (result.error) throw result.error;
  return String(result.data);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function unwrapSasPayData(payload: unknown): unknown {
  const record = asRecord(payload);
  return record.data === undefined ? payload : record.data;
}

export function errorResponse(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const status = (reason as { status?: number } | null)?.status;
  return { error: message, status: typeof status === 'number' ? status : 500 };
}
