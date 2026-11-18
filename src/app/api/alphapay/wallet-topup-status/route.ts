import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, getAdminClient, getRequestUser, syncAlphaPayWalletTopup } from '@/lib/alphapay-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const auth = await getRequestUser(request);
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const topupId = request.nextUrl.searchParams.get('id') || '';
    const admin = getAdminClient();
    const { data: topup, error } = await admin.from('saspay_wallet_topups')
      .select('id,user_id,status,checkout_session_id')
      .eq('id', topupId)
      .eq('user_id', auth.user.id)
      .single();
    if (error || !topup) return NextResponse.json({ error: 'Recharge introuvable' }, { status: 404 });
    if (topup.status !== 'pending') return NextResponse.json({ status: topup.status });
    if (!topup.checkout_session_id) return NextResponse.json({ status: 'pending' });

    const status = await syncAlphaPayWalletTopup(topup.id, topup.checkout_session_id);
    return NextResponse.json({ status });
  } catch (reason) {
    const result = errorResponse(reason);
    console.error('AlphaPay wallet top-up status check failed', result.status, result.error);
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
}
