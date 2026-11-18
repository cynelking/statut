import { NextRequest, NextResponse } from 'next/server';
import { alphaPayRequest, asRecord, errorResponse, getAdminClient, getAlphaPayConfig, getRequestUser, getUserClient, syncAlphaPayWalletTopup } from '@/lib/alphapay-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const auth = await getRequestUser(request);
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const body = asRecord(await request.json());
    const amount = Number(body.amount);
    if (!Number.isSafeInteger(amount) || amount < 500 || amount > 1000000) {
      return NextResponse.json({ error: 'La recharge doit être comprise entre 500 et 1 000 000 F' }, { status: 400 });
    }

    const userClient = getUserClient(auth.token);
    const intentResult = await userClient.rpc('start_saspay_wallet_topup', { p_amount: amount });
    if (intentResult.error) throw intentResult.error;
    const intent = asRecord(intentResult.data);
    const topupId = String(intent.topup_id || '');
    if (!topupId) throw new Error('Impossible de créer la recharge du portefeuille');
    if (intent.status === 'succeeded') return NextResponse.json({ status: 'succeeded' });
    if (intent.status === 'review') return NextResponse.json({ status: 'review' });

    if (typeof intent.checkout_session_id === 'string' && intent.checkout_session_id) {
      getAlphaPayConfig();
      const status = await syncAlphaPayWalletTopup(topupId, intent.checkout_session_id);
      if (status !== 'pending') return NextResponse.json({ status });
    }
    if (typeof intent.checkout_url === 'string' && intent.checkout_url) {
      return NextResponse.json({ checkoutUrl: intent.checkout_url, status: 'pending' });
    }

    getAlphaPayConfig();
    const appBaseUrl = process.env.APP_BASE_URL?.replace(/\/+$/, '');
    if (!appBaseUrl) throw new Error('APP_BASE_URL doit être configurée côté serveur');
    const { data: profile, error: profileError } = await userClient
      .from('profiles')
      .select('display_name')
      .eq('id', auth.user.id)
      .single();
    if (profileError) throw profileError;
    const email = auth.user.email;
    if (!email) throw new Error('Une adresse e-mail est nécessaire pour recharger le portefeuille');
    const name = profile.display_name?.trim() || email.split('@')[0] || 'Client StatutPay';

    const claimed = await userClient.rpc('claim_saspay_wallet_checkout', { p_topup_id: topupId });
    if (claimed.error) throw claimed.error;
    if (claimed.data !== true) {
      return NextResponse.json({ error: 'Une recharge est déjà en cours de création. Réessayez dans quelques instants.' }, { status: 409 });
    }

    try {
      const providerResult = asRecord(await alphaPayRequest('/checkout-sessions/', {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(intent.amount).toFixed(2),
          currency: intent.currency,
          country: intent.country,
          description: 'Recharge portefeuille StatutPay',
          customer_email: email,
          customer_name: name,
          customer_phone: auth.user.phone || '',
          return_url: `${appBaseUrl}/?alphapay_topup_id=${encodeURIComponent(topupId)}`,
          fee_charge_mode: 'ADD_ON',
          metadata: { statutpay_wallet_topup_id: topupId },
        }),
      }));

      const checkoutUrl = typeof providerResult.checkout_url === 'string' ? providerResult.checkout_url : '';
      const sessionId = typeof providerResult.id === 'string' ? providerResult.id : '';
      if (!checkoutUrl || !sessionId) throw new Error('AlphaPay n’a pas renvoyé la session de paiement attendue');
      const parsedUrl = new URL(checkoutUrl);
      if (parsedUrl.protocol !== 'https:' || !['pay.alphapay.me', 'checkout.alphapay.me', 'sandbox-checkout.alphapay.me'].includes(parsedUrl.hostname)) {
        throw new Error(`AlphaPay a renvoyé une adresse de paiement non autorisée (hôte : ${parsedUrl.hostname || 'invalide'})`);
      }

      const saved = await getAdminClient()
        .from('saspay_wallet_topups')
        .update({ checkout_session_id: sessionId, checkout_url: checkoutUrl, updated_at: new Date().toISOString() })
        .eq('id', topupId)
        .eq('user_id', auth.user.id)
        .eq('status', 'pending')
        .select('id')
        .single();
      if (saved.error) throw saved.error;
      return NextResponse.json({ checkoutUrl, status: 'pending' });
    } catch (reason) {
      const status = (reason as { status?: number } | null)?.status;
      if (typeof status === 'number' && status < 500) {
        await userClient.rpc('release_saspay_wallet_checkout', { p_topup_id: topupId });
      }
      throw reason;
    }
  } catch (reason) {
    const result = errorResponse(reason);
    console.error('AlphaPay wallet top-up creation failed', result.status, result.error);
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
}
