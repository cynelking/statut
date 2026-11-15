import { sb } from './supabase';

const DB = 'statutpay';
const ST = 'proofs';

export interface Queued { id?: number; userId: string; campaignId: number; name: string; type: string; blob: Blob; createdAt: number }

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(ST, { keyPath: 'id', autoIncrement: true }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((res, rej) => {
    const t = db.transaction(ST, mode);
    const r = fn(t.objectStore(ST));
    t.oncomplete = () => { res(r.result); db.close(); };
    t.onerror = () => { rej(t.error); db.close(); };
  });
}

export const isNet = (e: unknown) => /fetch|network|failed to|load failed|offline/i.test((e as { message?: string })?.message ?? String(e));

export async function queueProof(q: Omit<Queued, 'id'>): Promise<void> {
  await tx('readwrite', (s) => s.add(q));
  window.dispatchEvent(new Event('queue-changed'));
}

export async function listQueue(userId: string): Promise<Queued[]> {
  const all = await tx<Queued[]>('readonly', (s) => s.getAll());
  return all.filter((x) => x.userId === userId);
}

async function removeQueued(id: number): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
  window.dispatchEvent(new Event('queue-changed'));
}

/** Envoie les preuves en attente. S'arrête au premier échec réseau. Retourne le nombre envoyé. */
export async function flushQueue(userId: string): Promise<number> {
  let sent = 0;
  for (const it of await listQueue(userId)) {
    const ext = (it.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${userId}/${it.campaignId}-${it.createdAt}.${ext}`;
    const up = await sb.storage.from('proofs').upload(path, it.blob, { contentType: it.type });
    if (up.error && isNet(up.error)) break;
    if (up.error && !/exists|duplicate/i.test(up.error.message)) { await removeQueued(it.id!); continue; }
    const ins = await sb.from('proofs').insert({ campaign_id: it.campaignId, user_id: userId, image_path: path });
    if (ins.error && isNet(ins.error)) break;
    await removeQueued(it.id!);
    if (!ins.error) sent++;
  }
  return sent;
}
