import { NextRequest, NextResponse } from 'next/server';
import webpush from 'web-push';
import { getAdminClient, getRequestUser } from '@/lib/alphapay-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const auth = await getRequestUser(request);
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const admin = getAdminClient();
    const profile = await admin.from('profiles').select('role').eq('id', auth.user.id).maybeSingle();
    if (profile.error) throw profile.error;
    if (profile.data?.role !== 'admin') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const body: unknown = await request.json();
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'invalid_announcement' }, { status: 400 });
    }
    const title = 'title' in body && typeof body.title === 'string' ? body.title.trim() : '';
    const message = 'body' in body && typeof body.body === 'string' ? body.body.trim() : '';
    const pinHours = 'pinHours' in body ? body.pinHours : 0;
    if (!title || title.length > 120 || !message || message.length > 2000) {
      return NextResponse.json({ error: 'invalid_announcement' }, { status: 400 });
    }
    if (typeof pinHours !== 'number' || ![0, 24, 72, 168, 720].includes(pinHours)) {
      return NextResponse.json({ error: 'invalid_announcement_pin_duration' }, { status: 400 });
    }

    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!publicKey || !privateKey) throw new Error('VAPID server credentials are not configured');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@statutpay.app', publicKey, privateKey);

    const subscriptions = await admin.from('push_subscriptions')
      .select('id,endpoint,p256dh,auth');
    if (subscriptions.error) throw subscriptions.error;

    const inserted = await admin.from('announcements')
      .insert({
        title,
        body: message,
        created_by: auth.user.id,
        pinned_until: pinHours ? new Date(Date.now() + pinHours * 60 * 60 * 1000).toISOString() : null,
      })
      .select('id')
      .single();
    if (inserted.error) throw inserted.error;

    let sent = 0;
    let failed = 0;
    const stale: number[] = [];
    const payload = JSON.stringify({
      title,
      body: message,
      url: '/',
      tag: `announcement-${inserted.data.id}`,
    });

    await Promise.all((subscriptions.data ?? []).map(async (subscription) => {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          payload,
        );
        sent += 1;
      } catch (reason) {
        const statusCode = (reason as { statusCode?: number } | null)?.statusCode;
        if (statusCode === 404 || statusCode === 410) stale.push(subscription.id);
        else {
          failed += 1;
          console.error('Announcement push delivery failed', reason);
        }
      }
    }));

    if (stale.length) {
      const removed = await admin.from('push_subscriptions').delete().in('id', stale);
      if (removed.error) console.error('Could not remove expired announcement push subscriptions', removed.error);
    }

    return NextResponse.json({ id: inserted.data.id, sent, failed });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error('Announcement publishing failed', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
