import { sb } from './supabase';

const VAPID = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
export type PushState = 'unsupported' | 'denied' | 'on' | 'off';

function toKey(b64: string): Uint8Array {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && Boolean(VAPID) && process.env.NODE_ENV === 'production'
    && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function saveSubscription(sub: PushSubscription, userId: string, country: string | null): Promise<void> {
  const keys = sub.toJSON().keys;
  if (!keys?.p256dh || !keys.auth) throw new Error('The push subscription is missing encryption keys');
  const token = (await sb.auth.getSession()).data.session?.access_token;
  if (!token) throw new Error('Connectez-vous pour activer les notifications');
  const response = await fetch('/api/push-subscription', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      endpoint: sub.endpoint,
      keys,
      country,
    }),
  });
  if (!response.ok) {
    const result = await response.json() as { error?: string };
    throw new Error(result.error || 'Impossible d’enregistrer l’abonnement aux notifications');
  }
}

export async function pushState(userId: string, country: string | null): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return 'off';
  await saveSubscription(sub, userId, country);
  return 'on';
}

export async function subscribePush(userId: string, country: string | null): Promise<'ok' | 'denied'> {
  if (!VAPID) return 'denied';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(VAPID) as BufferSource }));
  await saveSubscription(sub, userId, country);
  return 'ok';
}

export async function unsubscribePush(userId: string): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const token = (await sb.auth.getSession()).data.session?.access_token;
  if (!token) throw new Error('Connectez-vous pour désactiver les notifications');
  const response = await fetch('/api/push-subscription', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  if (!response.ok) {
    const result = await response.json() as { error?: string };
    throw new Error(result.error || 'Impossible de supprimer l’abonnement aux notifications');
  }
  await sub.unsubscribe();
}
