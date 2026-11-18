import { NextRequest, NextResponse } from 'next/server';
import { asRecord, errorResponse, getAdminClient, getRequestUser, getSasPayConfig, getUserClient, sasPayRequest, syncSasPayCampaignPayment } from '@/lib/saspay-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const auth = await getRequestUser(request);
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const body = asRecord(await request.json());
    const campaignId = Number(body.campaignId);
    if (!Number.isSafeInteger(campaignId) || campaignId < 1) {
      return NextResponse.json({ error: 'campaignId invalide' }, { status: 400 });
    }

    const userClient = getUserClient(auth.token);
    const intentResult = await userClient.rpc('start_saspay_campaign_payment', { p_campaign_id: campaignId });
    if (intentResult.error) throw intentResult.error;
    const intent = asRecord(intentResult.data);
    const paymentId = String(intent.payment_id || '');
    if (!paymentId) throw new Error('Impossible de créer le paiement de la campagne');
    if (intent.status === 'succeeded') return NextResponse.json({ status: 'paid' });
    if (intent.status === 'review') return NextResponse.json({ status: 'review' });

    if (typeof intent.checkout_session_id === 'string' && intent.checkout_session_id) {
      getSasPayConfig();
      const status = await syncSasPayCampaignPayment(paymentId, intent.checkout_session_id);
      if (status !== 'pending') return NextResponse.json({ status });
    }

    if (typeof intent.checkout_url === 'string' && intent.checkout_url) {
      return NextResponse.json({ checkoutUrl: intent.checkout_url, status: 'pending' });
    }

    getSasPayConfig();
    const appBaseUrl = process.env.APP_BASE_URL?.replace(/\/+$/, '');
    if (!appBaseUrl) throw new Error('APP_BASE_URL doit être configurée côté serveur');
    const { data: profile, error: profileError } = await userClient
      .from('profiles')
      .select('display_name')
      .eq('id', auth.user.id)
      .single();
    if (profileError) throw profileError;
    const email = auth.user.email;
    if (!email) throw new Error('Une adresse e-mail est nécessaire pour payer la campagne');
    const name = profile.display_name?.trim() || email.split('@')[0] || 'Client StatutPay';

    const claimed = await userClient.rpc('claim_saspay_checkout', { p_payment_id: paymentId });
    if (claimed.error) throw claimed.error;
    if (claimed.data !== true) {
      return NextResponse.json({ error: 'Un paiement est déjà en cours de création. Réessayez dans quelques instants.' }, { status: 409 });
    }

    try {
      const providerResult = asRecord(await sasPayRequest('/checkout-sessions/', {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(intent.amount).toFixed(2),
          currency: intent.currency,
          country: intent.country,
          description: `Campagne StatutPay #${campaignId}`,
          customer_email: email,
          customer_name: name,
          customer_phone: auth.user.phone || '',
          return_url: `${appBaseUrl}/?saspay_payment_id=${encodeURIComponent(paymentId)}`,
          fee_charge_mode: 'ADD_ON',
          metadata: { statutpay_payment_id: paymentId, campaign_id: campaignId },
        }),
      }));

      const checkoutUrl = typeof providerResult.checkout_url === 'string' ? providerResult.checkout_url : '';
      const sessionId = typeof providerResult.id === 'string' ? providerResult.id : '';
      if (!checkoutUrl || !sessionId) throw new Error('SasPay n’a pas renvoyé la session de paiement attendue');
      const parsedUrl = new URL(checkoutUrl);
      if (parsedUrl.protocol !== 'https:' || !['pay.saspay.me', 'sandbox-checkout.saspay.me'].includes(parsedUrl.hostname)) {
        throw new Error('SasPay a renvoyé une adresse de paiement non autorisée');
      }

      const saved = await getAdminClient()
        .from('saspay_campaign_payments')
        .update({ checkout_session_id: sessionId, checkout_url: checkoutUrl, updated_at: new Date().toISOString() })
        .eq('id', paymentId)
        .eq('user_id', auth.user.id)
        .eq('status', 'pending')
        .select('id')
        .single();
      if (saved.error) throw saved.error;
      return NextResponse.json({ checkoutUrl, status: 'pending' });
    } catch (reason) {
      const status = (reason as { status?: number } | null)?.status;
      if (typeof status === 'number' && status < 500) {
        await userClient.rpc('release_saspay_checkout', { p_payment_id: paymentId });
      }
      throw reason;
    }
  } catch (reason) {
    const result = errorResponse(reason);
    console.error('SasPay checkout creation failed', result.status, result.error);
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
}
