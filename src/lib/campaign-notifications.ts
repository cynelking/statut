import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const QUEUE = 'campaign_push_notifications';

export async function dispatchCampaignNotifications() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!url || !serviceKey || !publicKey || !privateKey) {
    throw new Error('Supabase or VAPID server credentials are not configured');
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@statutpay.app', publicKey, privateKey);

  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const reset = await admin.from(QUEUE)
    .update({ status: 'pending', locked_at: null })
    .eq('status', 'sending')
    .lt('locked_at', staleBefore);
  if (reset.error) throw reset.error;

  const pending = await admin.from(QUEUE)
    .select('campaign_id,attempts')
    .eq('status', 'pending')
    .lte('available_at', new Date().toISOString())
    .order('created_at')
    .limit(50);
  if (pending.error) throw pending.error;

  let sent = 0;
  let failed = 0;
  for (const queued of pending.data ?? []) {
    const claimedAt = new Date().toISOString();
    const claim = await admin.from(QUEUE)
      .update({ status: 'sending', locked_at: claimedAt, attempts: queued.attempts + 1 })
      .eq('campaign_id', queued.campaign_id)
      .eq('status', 'pending')
      .select('campaign_id')
      .maybeSingle();
    if (claim.error) throw claim.error;
    if (!claim.data) continue;

    const campaignResult = await admin.from('campaigns')
      .select('id,title,status,country,starts_at')
      .eq('id', queued.campaign_id)
      .maybeSingle();
    if (campaignResult.error) throw campaignResult.error;
    const campaign = campaignResult.data;
    if (!campaign || campaign.status !== 'active') {
      const cancelled = await admin.from(QUEUE)
        .update({ status: 'cancelled', locked_at: null })
        .eq('campaign_id', queued.campaign_id)
        .eq('status', 'sending');
      if (cancelled.error) throw cancelled.error;
      continue;
    }

    if (campaign.starts_at && new Date(campaign.starts_at).getTime() > Date.now()) {
      const deferred = await admin.from(QUEUE)
        .update({ status: 'pending', locked_at: null })
        .eq('campaign_id', queued.campaign_id)
        .eq('status', 'sending');
      if (deferred.error) throw deferred.error;
      continue;
    }

    const subscriptionsResult = await admin.from('push_subscriptions')
      .select('id,endpoint,p256dh,auth,country');
    if (subscriptionsResult.error) throw subscriptionsResult.error;
    const targets = (subscriptionsResult.data ?? []).filter((subscription) =>
      !campaign.country || subscription.country === campaign.country,
    );
    const dead: number[] = [];
    const errors: string[] = [];
    let delivered = 0;
    const payload = JSON.stringify({
      title: 'Nouvelle annonce sur StatutPay',
      body: campaign.title,
      url: '/',
      tag: `ad-${campaign.id}`,
    });

    await Promise.all(targets.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          payload,
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

    const completed = await admin.from(QUEUE)
      .update(errors.length
        ? { status: 'pending', locked_at: null, last_error: 'push_delivery_failed' }
        : { status: 'sent', locked_at: null, delivered_at: new Date().toISOString(), last_error: null })
      .eq('campaign_id', queued.campaign_id)
      .eq('status', 'sending');
    if (completed.error) throw completed.error;

    if (errors.length) {
      failed += errors.length;
      console.error(`Campaign push delivery failed for campaign ${campaign.id}`, errors);
    }
    sent += delivered;
  }

  return { sent, failed };
}
