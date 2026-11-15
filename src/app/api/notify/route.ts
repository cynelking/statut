import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!url || !service || !pub || !priv) return NextResponse.json({ error: 'not_configured' }, { status: 501 });

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: u } = await admin.auth.getUser(token);
  if (!u.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { data: prof } = await admin.from('profiles').select('role').eq('id', u.user.id).single();
  if (prof?.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { campaignId?: number };
  const { data: c } = await admin.from('campaigns').select('id,title,status,country').eq('id', body.campaignId ?? -1).single();
  if (!c || c.status !== 'active') return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const { data: subs } = await admin.from('push_subscriptions').select('id,endpoint,p256dh,auth,country');
  const targets = (subs ?? []).filter((s) => !c.country || s.country === c.country);

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@statutpay.app', pub, priv);
  const payload = JSON.stringify({ title: 'Nouvelle annonce sur StatutPay', body: c.title, url: '/', tag: 'ad-' + c.id });
  const dead: number[] = [];
  let sent = 0;
  await Promise.all(targets.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) dead.push(s.id);
    }
  }));
  if (dead.length) await admin.from('push_subscriptions').delete().in('id', dead);
  return NextResponse.json({ sent });
}
