import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { alphaPayRequest, asRecord, errorResponse, getAdminClient, getAlphaPayConfig, getRequestUser, getUserClient, listAlphaPayNetworks } from '@/lib/alphapay-server';
import { COUNTRY_CALLING_CODES, currencyForCountry } from '@/lib/alphapay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function internationalPhone(value: string, country: string) {
  const digits = value.replace(/\D/g, '');
  const callingCode = COUNTRY_CALLING_CODES[country];
  if (!callingCode || digits.length < 6) throw new Error('Numéro Mobile Money invalide');
  return `+${digits.startsWith(callingCode) ? digits : callingCode + digits}`;
}

function pendingResponse(withdrawalId: number, error: string) {
  return NextResponse.json({ withdrawalId, status: 'pending', error }, { status: 202 });
}

function isCronRequest(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get('authorization') || '';
  const expected = secret ? `Bearer ${secret}` : '';
  return Boolean(secret)
    && authorization.length === expected.length
    && timingSafeEqual(Buffer.from(authorization), Buffer.from(expected));
}

export async function POST(request: NextRequest) {
  let createdWithdrawalId: number | null = null;
  try {
    const cronRequest = isCronRequest(request);
    const auth = cronRequest ? null : await getRequestUser(request);
    if (!cronRequest && !auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const userClient = auth ? getUserClient(auth.token) : null;
    const admin = getAdminClient();
    let profileRole: string | null = null;
    if (auth && userClient) {
      const { data: profile, error: profileError } = await userClient
        .from('profiles')
        .select('role')
        .eq('id', auth.user.id)
        .single();
      if (profileError) throw profileError;
      profileRole = profile.role;
    }

    const body = asRecord(await request.json());
    let withdrawalId = Number(body.withdrawalId);
    if (!Number.isSafeInteger(withdrawalId) || withdrawalId < 1) {
      if (!userClient || !auth) {
        return NextResponse.json({ error: 'withdrawalId requis' }, { status: 400 });
      }
      const amount = Number(body.amount);
      const country = typeof body.country === 'string' ? body.country : '';
      const network = typeof body.network === 'string' ? body.network : '';
      const phone = typeof body.phone === 'string' ? body.phone : '';
      const operator = typeof body.operator === 'string' ? body.operator : '';
      if (!Number.isSafeInteger(amount) || !country || !network || !phone || !operator) {
        return NextResponse.json({ error: 'Données de retrait invalides' }, { status: 400 });
      }
      const created = await userClient.rpc('request_withdrawal', {
        p_amount: amount,
        p_operator: operator,
        p_country: country,
        p_network: network,
        p_phone: phone,
      });
      if (created.error) throw created.error;
      withdrawalId = Number(created.data);
      if (!Number.isSafeInteger(withdrawalId) || withdrawalId < 1) {
        throw new Error('La demande de retrait a été enregistrée sans identifiant valide');
      }
      createdWithdrawalId = withdrawalId;
    }

    const { data: withdrawal, error: withdrawalError } = await admin.from('withdrawals')
      .select('user_id,automatic')
      .eq('id', withdrawalId)
      .maybeSingle();
    if (withdrawalError) throw withdrawalError;
    if (!withdrawal) return NextResponse.json({ error: 'Retrait introuvable' }, { status: 404 });
    if (cronRequest && !withdrawal.automatic) {
      return NextResponse.json({ error: 'Retrait automatique introuvable' }, { status: 404 });
    }
    if (auth && withdrawal.user_id !== auth.user.id && profileRole !== 'admin') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const { baseUrl } = getAlphaPayConfig();
    if (baseUrl !== 'https://api.alphapay.me/api/v1') {
      if (createdWithdrawalId !== null) {
        return pendingResponse(withdrawalId, 'Les payouts AlphaPay ne sont pas disponibles en sandbox; configurez l’API de production.');
      }
      return NextResponse.json({ error: 'Les payouts AlphaPay ne sont pas disponibles en sandbox; configurez l’API de production.' }, { status: 409 });
    }
    if (process.env.ALPHAPAY_PAYOUTS_ENABLED !== 'true') {
      if (createdWithdrawalId !== null) {
        return pendingResponse(withdrawalId, 'Les payouts AlphaPay sont désactivés. Activez-les après avoir autorisé l’IP fixe du serveur dans AlphaPay.');
      }
      return NextResponse.json({ error: 'Les payouts AlphaPay sont désactivés. Activez-les après avoir autorisé l’IP fixe du serveur dans AlphaPay.' }, { status: 503 });
    }

    const networks = await listAlphaPayNetworks();
    const payoutClient = cronRequest ? admin : userClient;
    if (!payoutClient) throw new Error('Client de paiement indisponible');
    const claimed = await payoutClient.rpc(
      cronRequest ? 'claim_auto_saspay_payout' : 'claim_saspay_payout',
      { p_withdrawal_id: withdrawalId },
    );
    if (claimed.error) throw claimed.error;
    const payout = asRecord(claimed.data);
    const country = String(payout.country || '');
    const network = String(payout.network || '');
    const recipientPhone = String(payout.phone || '');
    if (!networks.networks.some((item) => item.code === network && item.country === country && item.is_active)) {
      if (cronRequest) {
        const failed = await admin.rpc('fail_auto_saspay_payout', { p_withdrawal_id: withdrawalId });
        if (failed.error) throw failed.error;
      } else {
        const released = await admin.from('withdrawals')
          .update({ status: 'pending', saspay_idempotency_key: null })
          .eq('id', withdrawalId)
          .eq('status', 'processing')
          .is('saspay_payout_id', null);
        if (released.error) throw released.error;
      }
      const message = 'Le réseau de paiement n’est plus disponible. Demandez au diffuseur de refaire sa demande.';
      return createdWithdrawalId !== null
        ? pendingResponse(withdrawalId, message)
        : NextResponse.json({ error: message }, { status: 409 });
    }
    const callingCode = COUNTRY_CALLING_CODES[country];
    if (!callingCode || !recipientPhone) {
      if (cronRequest) {
        const failed = await admin.rpc('fail_auto_saspay_payout', { p_withdrawal_id: withdrawalId });
        if (failed.error) throw failed.error;
      } else {
        const released = await admin.from('withdrawals')
          .update({ status: 'pending', saspay_idempotency_key: null })
          .eq('id', withdrawalId)
          .eq('status', 'processing')
          .is('saspay_payout_id', null);
        if (released.error) throw released.error;
      }
      throw new Error('Pays ou numéro Mobile Money manquant');
    }

    if (payout.provider_payout_id) {
      const verified = asRecord(await alphaPayRequest(`/payouts/${encodeURIComponent(String(payout.provider_payout_id))}/verify/`));
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
      const payoutAmount = Number(payout.payout_amount ?? payout.amount);
      if (!Number.isSafeInteger(payoutAmount) || payoutAmount < 1) {
        throw new Error('Montant net du retrait invalide');
      }
      providerResult = asRecord(await alphaPayRequest('/payouts/initialize/', {
        method: 'POST',
        headers: { 'Idempotency-Key': String(payout.idempotency_key) },
        body: JSON.stringify({
          amount: payoutAmount.toFixed(2),
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
        if (cronRequest) {
          const failed = await admin.rpc('fail_auto_saspay_payout', { p_withdrawal_id: withdrawalId });
          if (failed.error) throw failed.error;
        } else {
          const released = await admin.from('withdrawals')
            .update({ status: 'pending', saspay_idempotency_key: null })
            .eq('id', withdrawalId)
            .eq('status', 'processing')
            .is('saspay_payout_id', null);
          if (released.error) throw released.error;
        }
      }
      throw reason;
    }

    const providerPayoutId = typeof providerResult.id === 'string' ? providerResult.id : '';
    if (!providerPayoutId) throw new Error('AlphaPay n’a pas renvoyé la référence du payout');
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
    console.error('AlphaPay payout request failed', result.status, result.error);
    if (createdWithdrawalId !== null) return pendingResponse(createdWithdrawalId, result.error);
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
}
