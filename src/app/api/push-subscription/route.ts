import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getRequestUser } from '@/lib/alphapay-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SubscriptionBody = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  country?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === 'fcm.googleapis.com'
        || url.hostname === 'web.push.apple.com'
        || url.hostname === 'notify.windows.com'
        || url.hostname.endsWith('.notify.windows.com')
        || url.hostname === 'push.services.mozilla.com'
        || url.hostname.endsWith('.push.services.mozilla.com'));
  } catch {
    return false;
  }
}

async function readBody(request: NextRequest): Promise<SubscriptionBody | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body as SubscriptionBody : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const auth = await getRequestUser(request);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await readBody(request);
  const p256dh = body?.keys?.p256dh;
  const keyAuth = body?.keys?.auth;
  if (!body || !validEndpoint(body.endpoint)
    || typeof p256dh !== 'string' || typeof keyAuth !== 'string'
    || (body.country !== null && body.country !== undefined && typeof body.country !== 'string')) {
    return NextResponse.json({ error: 'invalid_subscription' }, { status: 400 });
  }

  const result = await getAdminClient().from('push_subscriptions').upsert({
    endpoint: body.endpoint,
    p256dh,
    auth: keyAuth,
    country: typeof body.country === 'string' ? body.country : null,
    user_id: auth.user.id,
  }, { onConflict: 'endpoint' });
  if (result.error) {
    console.error('Push subscription save failed', result.error);
    return NextResponse.json({ error: 'subscription_save_failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const auth = await getRequestUser(request);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await readBody(request);
  if (!body || !validEndpoint(body.endpoint)) {
    return NextResponse.json({ error: 'invalid_subscription' }, { status: 400 });
  }

  const result = await getAdminClient().from('push_subscriptions')
    .delete()
    .eq('endpoint', body.endpoint)
    .eq('user_id', auth.user.id);
  if (result.error) {
    console.error('Push subscription removal failed', result.error);
    return NextResponse.json({ error: 'subscription_remove_failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
