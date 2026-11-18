import { NextRequest, NextResponse } from 'next/server';
import { dispatchCampaignNotifications } from '@/lib/campaign-notifications';
import { errorResponse, getAdminClient, getRequestUser, syncAlphaPayCampaignPayment } from '@/lib/alphapay-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const auth = await getRequestUser(request);
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const paymentId = request.nextUrl.searchParams.get('id') || '';
    const admin = getAdminClient();
    const { data: payment, error } = await admin.from('saspay_campaign_payments')
      .select('id,user_id,status,amount,currency,checkout_session_id')
      .eq('id', paymentId)
      .eq('user_id', auth.user.id)
      .single();
    if (error || !payment) return NextResponse.json({ error: 'Paiement introuvable' }, { status: 404 });
    if (payment.status !== 'pending') return NextResponse.json({ status: payment.status });
    if (!payment.checkout_session_id) return NextResponse.json({ status: 'pending' });

    const status = await syncAlphaPayCampaignPayment(payment.id, payment.checkout_session_id);
    if (status === 'succeeded') {
      try {
        await dispatchCampaignNotifications();
      } catch (reason) {
        console.error('Campaign push dispatch after AlphaPay status check failed', reason);
      }
    }
    return NextResponse.json({ status });
  } catch (reason) {
    const result = errorResponse(reason);
    console.error('AlphaPay payment status check failed', result.status, result.error);
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
}
