import { NextRequest, NextResponse } from 'next/server';
import { dispatchCampaignNotifications } from '@/lib/campaign-notifications';
import { getRequestUser } from '@/lib/alphapay-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const auth = await getRequestUser(req);
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const result = await dispatchCampaignNotifications();
    return NextResponse.json(result);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error('Campaign push dispatch failed', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
