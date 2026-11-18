import { NextRequest, NextResponse } from 'next/server';
import { asRecord, errorResponse, getAdminClient, getRequestUser, getSasPayConfig, getUserClient, listSasPayNetworks, sasPayRequest } from '@/lib/saspay-server';
import { COUNTRY_CALLING_CODES, currencyForCountry } from '@/lib/saspay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function internationalPhone(value: string, country: string) {
  const digits = value.replace(/\D/g, '');
  const callingCode = COUNTRY_CALLING_CODES[country];
  if (!callingCode || digits.length < 6) throw new Error('Numéro Mobile Money invalide');
  return `+${digits.startsWith(callingCode) ? digits : callingCode + digits}`;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getRequestUser(request);
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const userClient = getUserClient(auth.token);
    const { data: profile, error: profileError } = await userClient
      .from('profiles')
      .select('role')
      .eq('id', auth.user.id)
      .single();
    if (profileError || profile?.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

    const { baseUrl } = getSasPayConfig();
    if (baseUrl !== 'https://api.saspay.me/api/v1') {
      return NextResponse.json({ error: 'Les payouts ne sont pas disponibles en sandbox; configurez l’API SasPay de production.' }, { status: 409 });
    }
    if (process.env.SASPAY_PAYOUTS_ENABLED !== 'true') {
      return NextResponse.json({ error: 'Les payouts SasPay sont désactivés. Activez-les uniquement après avoir autorisé l’IP fixe du serveur dans SasPay.' }, { status: 503 });
    }

    const body = asRecord(await request.json());
    const withdrawalId = Number(body.withdrawalId);
    if (!Number.isSafeInteger(withdrawalId) || withdrawalId < 1) {
      return NextResponse.json({ error: 'withdrawalId invalide' }, { status: 400 });
    }

    const networks = await listSasPayNetworks();
    const claimed = await userClient.rpc('claim_saspay_payout', { p_withdrawal_id: withdrawalId });
    if (claimed.error) throw claimed.error;
    const payout = asRecord(claimed.data);
    const country = String(payout.country || '');
    const network = String(payout.network || '');
    const recipientPhone = String(payout.phone || '');
    if (!networks.networks.some((item) => item.code === network && item.country === country && item.is_active)) {
      const admin = getAdminClient();
      await admin.from('withdrawals')
        .update({ status: 'pending', saspay_idempotency_key: null })
        .eq('id', withdrawalId)
        .eq('status', 'processing')
        .is('saspay_payout_id', null);
      return NextResponse.json({ error: 'Le réseau de paiement n’est plus disponible. Demandez au diffuseur de refaire sa demande.' }, { status: 409 });
    }
    const callingCode = COUNTRY_CALLING_CODES[country];
    if (!callingCode || !recipientPhone) {
      await getAdminClient().from('withdrawals')
        .update({ status: 'pending', saspay_idempotency_key: null })
        .eq('id', withdrawalId)
        .eq('status', 'processing')
        .is('saspay_payout_id', null);
      throw new Error('Pays ou numéro Mobile Money manquant');
    }

    const admin = getAdminClient();
    if (payout.provider_payout_id) {
      const verified = asRecord(await sasPayRequest(`/payouts/${encodeURIComponent(String(payout.provider_payout_id))}/verify/`));
      const status = typeof verified.status === 'string' ? verified.status : '';
      if (status === 'SUCCESS' || status === 'FAILED' || status === 'PENDING') {
        const result = await admin.rpc('complete_saspay_payout', {
          p_provider_payout_id: String(payout.provider_payout_id),
          p_status: status,
        });
        if (result.error) throw result.error;
        return NextResponse.json({ status: result.data });
      }
      return NextResponse.json({ status: 'processing' });
    }

    const { data: beneficiary, error: beneficiaryError } = await admin.auth.admin.getUserById(String(payout.user_id));
    if (beneficiaryError) throw beneficiaryError;
    const userProfile = await admin.from('profiles')
      .select('display_name')
      .eq('id', String(payout.user_id))
      .single();
    if (userProfile.error) throw userProfile.error;

    let providerResult: Record<string, unknown>;
    try {
      providerResult = asRecord(await sasPayRequest('/payouts/initialize/', {
        method: 'POST',
        headers: { 'Idempotency-Key': String(payout.idempotency_key) },
        body: JSON.stringify({
          amount: Number(payout.amount).toFixed(2),
          currency: currencyForCountry(country),
          country,
          description: `Retrait StatutPay #${withdrawalId}`,
          customer: {
            email: beneficiary.user.email || '',
            first_name: userProfile.data.display_name || 'Diffuseur',
            phone: internationalPhone(recipientPhone, country),
          },
          method: network,
          recipient: { msisdn: recipientPhone },
          metadata: { statutpay_withdrawal_id: withdrawalId },
        }),
      }));
    } catch (reason) {
      const status = (reason as { status?: number } | null)?.status;
      if (typeof status === 'number' && status < 500) {
        await admin.from('withdrawals')
          .update({ status: 'pending', saspay_idempotency_key: null })
          .eq('id', withdrawalId)
          .eq('status', 'processing')
          .is('saspay_payout_id', null);
      }
      throw reason;
    }

    const providerPayoutId = typeof providerResult.id === 'string' ? providerResult.id : '';
    if (!providerPayoutId) throw new Error('SasPay n’a pas renvoyé la référence du payout');
    const saved = await admin.from('withdrawals')
      .update({ saspay_payout_id: providerPayoutId })
      .eq('id', withdrawalId)
      .eq('status', 'processing');
    if (saved.error) throw saved.error;

    const status = typeof providerResult.status === 'string' ? providerResult.status : 'PENDING';
    if (status === 'SUCCESS' || status === 'FAILED' || status === 'PENDING') {
      const result = await admin.rpc('complete_saspay_payout', {
        p_provider_payout_id: providerPayoutId,
        p_status: status,
      });
      if (result.error) throw result.error;
      return NextResponse.json({ status: result.data });
    }
    return NextResponse.json({ status: 'processing' });
  } catch (reason) {
    const result = errorResponse(reason);
    console.error('SasPay payout request failed', result.status, result.error);
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
}
