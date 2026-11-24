import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const QUEUE = 'proof_reminder_notifications';
const HOUR_MS = 60 * 60 * 1000;

type Reminder = { id: number; proof_id: number; user_id: string; stage: 'h1' | 'h23'; attempts: number };
type ProofState = {
  id: number;
  user_id: string;
  status: string;
  posted_at: string | null;
  image_path: string | null;
  final_image_path: string | null;
};

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!url || !key || !publicKey || !privateKey) {
    throw new Error('Supabase or VAPID server credentials are not configured');
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@statutpay.app', publicKey, privateKey);
  return createClient(url, key, { auth: { persistSession: false } });
}

async function setStatus(admin: ReturnType<typeof getAdmin>, id: number, status: 'sent' | 'pending' | 'cancelled', options: {
  deliveredAt?: string;
  error?: string | null;
  remindAt?: string;
}) {
  const update: Record<string, unknown> = {
    status,
    locked_at: null,
    delivered_at: options.deliveredAt ?? null,
    last_error: options.error ?? null,
  };
  if (options.remindAt) update.remind_at = options.remindAt;
  const result = await admin.from(QUEUE).update(update).eq('id', id).eq('status', 'sending');
  if (result.error) throw result.error;
}

export async function dispatchProofReminders() {
  const admin = getAdmin();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const reset = await admin.from(QUEUE)
    .update({ status: 'pending', locked_at: null })
    .eq('status', 'sending')
    .lt('locked_at', staleBefore);
  if (reset.error) throw reset.error;

  const pending = await admin.from(QUEUE)
    .select('id,proof_id,user_id,stage,attempts')
    .eq('status', 'pending')
    .lte('remind_at', now.toISOString())
    .order('remind_at')
    .limit(50);
  if (pending.error) throw pending.error;

  let sent = 0;
  let failed = 0;
  let cancelled = 0;
  for (const queued of (pending.data ?? []) as Reminder[]) {
    const claim = await admin.from(QUEUE)
      .update({ status: 'sending', locked_at: new Date().toISOString(), attempts: queued.attempts + 1 })
      .eq('id', queued.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (claim.error) throw claim.error;
    if (!claim.data) continue;

    const proofResult = await admin.from('proofs')
      .select('id,user_id,status,posted_at,image_path,final_image_path')
      .eq('id', queued.proof_id)
      .maybeSingle();
    if (proofResult.error) throw proofResult.error;
    const proof = proofResult.data as ProofState | null;
    if (!proof || proof.user_id !== queued.user_id || proof.status !== 'pending' || !proof.posted_at) {
      await setStatus(admin, queued.id, 'cancelled', {});
      cancelled += 1;
      continue;
    }

    const stagePending = queued.stage === 'h1'
      ? !proof.image_path
      : Boolean(proof.image_path) && !proof.final_image_path;
    const deadline = Date.parse(proof.posted_at) + (queued.stage === 'h1' ? 23 : 24) * HOUR_MS;
    if (!stagePending || Date.now() >= deadline) {
      await setStatus(admin, queued.id, 'cancelled', {});
      cancelled += 1;
      continue;
    }

    const subscriptions = await admin.from('push_subscriptions')
      .select('id,endpoint,p256dh,auth')
      .eq('user_id', queued.user_id);
    if (subscriptions.error) throw subscriptions.error;
    if (!subscriptions.data?.length) {
      await setStatus(admin, queued.id, 'pending', {
        error: 'no_push_subscription',
        remindAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      continue;
    }

    const dead: number[] = [];
    const errors: string[] = [];
    const title = queued.stage === 'h1' ? 'Rappel : preuve H+1' : 'Rappel : preuve H+23';
    const body = queued.stage === 'h1'
      ? 'La fenêtre H+1 se ferme dans moins de 15 minutes. Ouvrez StatutPay pour envoyer la capture.'
      : 'La fenêtre H+23 se ferme dans moins de 15 minutes. Ouvrez StatutPay pour envoyer la capture.';
    let delivered = 0;
    await Promise.all(subscriptions.data.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          JSON.stringify({
            title,
            body,
            url: '/',
            tag: `proof-reminder-${queued.proof_id}-${queued.stage}`,
          }),
        );
        delivered += 1;
      } catch (reason) {
        const statusCode = (reason as { statusCode?: number } | null)?.statusCode;
        if (statusCode === 404 || statusCode === 410) dead.push(subscription.id);
        else errors.push(reason instanceof Error ? reason.message : String(reason));
      }
    }));

    if (dead.length) {
      const removed = await admin.from('push_subscriptions').delete().in('id', dead);
      if (removed.error) throw removed.error;
    }

    if (delivered > 0) {
      await setStatus(admin, queued.id, 'sent', { deliveredAt: new Date().toISOString() });
      sent += delivered;
    } else if (errors.length) {
      await setStatus(admin, queued.id, 'pending', { error: 'push_delivery_failed' });
      failed += errors.length;
      console.error(`Proof reminder delivery failed for proof ${queued.proof_id}`, errors);
    } else {
      await setStatus(admin, queued.id, 'cancelled', {});
      cancelled += 1;
    }
  }

  return { sent, failed, cancelled };
}
