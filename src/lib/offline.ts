import { sb } from './supabase';

const DB = 'statutpay';
const ST = 'proofs';

export interface Queued {
  id?: number; userId: string; campaignId: number; name: string; type: string; blob: Blob; createdAt: number;
  proofId?: number; stage?: 'h1' | 'h23';
}

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

export async function discardLegacyQueue(userId: string): Promise<number> {
  const legacy = (await listQueue(userId)).filter((item) => item.proofId === undefined || !item.stage);
  for (const item of legacy) {
    if (item.id !== undefined) await removeQueued(item.id);
  }
  return legacy.length;
}

async function removeQueued(id: number): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
  window.dispatchEvent(new Event('queue-changed'));
}

/** Envoie les preuves en attente. S'arrête au premier échec réseau. Retourne le nombre envoyé. */
export async function flushQueue(userId: string): Promise<number> {
  let sent = 0;
  for (const it of await listQueue(userId)) {
    if (it.proofId !== undefined && it.stage) {
      const ext = (it.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${userId}/${it.proofId}-${it.stage}-${it.createdAt}.${ext}`;
      const up = await sb.storage.from('proofs').upload(path, it.blob, { contentType: it.type });
      if (up.error && isNet(up.error)) break;
      if (up.error && !/exists|duplicate/i.test(up.error.message)) throw up.error;
      const submitted = await sb.rpc('submit_proof_stage', {
        p_proof_id: it.proofId, p_stage: it.stage, p_image_path: path,
      });
      if (submitted.error && isNet(submitted.error)) break;
      if (submitted.error) throw submitted.error;
      await removeQueued(it.id!);
      sent++;
      continue;
    }

    continue;
  }
  return sent;
}
