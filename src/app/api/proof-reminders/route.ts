import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { dispatchProofReminders } from '@/lib/proof-reminders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get('authorization') || '';
  const expected = secret ? `Bearer ${secret}` : '';
  const authorized = Boolean(secret)
    && authorization.length === expected.length
    && timingSafeEqual(Buffer.from(authorization), Buffer.from(expected));
  if (!authorized) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    return NextResponse.json(await dispatchProofReminders());
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error('Proof reminder dispatch failed', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
