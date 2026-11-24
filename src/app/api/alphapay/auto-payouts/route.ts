import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { asRecord, errorResponse, getAdminClient, getAlphaPayConfig } from '@/lib/alphapay-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isAuthorizedCron(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get('authorization') || '';
  const expected = secret ? `Bearer ${secret}` : '';
  return Boolean(secret)
    && authorization.length === expected.length
    && timingSafeEqual(Buffer.from(authorization), Buffer.from(expected));
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const { baseUrl } = getAlphaPayConfig();
    if (baseUrl !== 'https://api.alphapay.me/api/v1' || process.env.ALPHAPAY_PAYOUTS_ENABLED !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'AlphaPay payouts are not enabled for production' });
    }

    const admin = getAdminClient();
    const claimed = await admin.rpc('claim_due_auto_withdrawals');
    if (claimed.error) throw claimed.error;

    if (!Array.isArray(claimed.data)) throw new Error('La liste des retraits automatiques est invalide');
    const withdrawalIds = claimed.data.map((item: unknown) => {
      const id = Number(asRecord(item).withdrawal_id);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('Identifiant de retrait automatique invalide');
      return id;
    });
    const results: { withdrawalId: number; status?: string; error?: string }[] = [];
    let failed = false;

    for (const withdrawalId of withdrawalIds) {
      try {
        const response = await fetch(new URL('/api/alphapay/payout', request.url), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.CRON_SECRET}`,
          },
          body: JSON.stringify({ withdrawalId }),
          cache: 'no-store',
          signal: AbortSignal.timeout(45000),
        });
        const result = asRecord(await response.json());
        if (!response.ok) {
          failed = true;
          console.error('Automatic AlphaPay payout failed', withdrawalId, result.error || response.status);
          results.push({ withdrawalId, error: String(result.error || `HTTP ${response.status}`) });
          continue;
        }
        results.push({
          withdrawalId,
          status: typeof result.status === 'string' ? result.status : 'unknown',
          ...(typeof result.error === 'string' ? { error: result.error } : {}),
        });
      } catch (reason) {
        failed = true;
        const message = reason instanceof Error ? reason.message : String(reason);
        console.error('Automatic AlphaPay payout request failed', withdrawalId, message);
        results.push({ withdrawalId, error: message });
      }
    }

    return NextResponse.json(
      { processed: results.length, results },
      { status: failed ? 500 : 200 },
    );
  } catch (reason) {
    const result = errorResponse(reason);
    console.error('Automatic AlphaPay payout scheduler failed', result.status, result.error);
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
}
