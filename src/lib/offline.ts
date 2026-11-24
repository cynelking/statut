import { sb } from './supabase';

const DB = 'statutpay';
const ST = 'proofs';

export interface Queued {
  id?: number; userId: string; campaignId: number; name: string; type: string; blob: Blob; createdAt: number;
  proofId?: number; stage?: 'h1' | 'h23';
}

export type QueueProgress = {
  proofId: number;
  stage: 'h1' | 'h23';
  state: 'uploading' | 'submitting' | 'waiting' | 'sent' | 'failed';
  error?: string;
};

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
export async function flushQueue(userId: string, onProgress?: (progress: QueueProgress) => void): Promise<number> {
  let sent = 0;
  for (const it of await listQueue(userId)) {
    const proofId = it.proofId;
    const stage = it.stage;
    if (proofId !== undefined && stage) {
      const ext = (it.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${userId}/${proofId}-${stage}-${it.createdAt}.${ext}`;
      const report = (state: QueueProgress['state'], error?: string) => {
        onProgress?.({ proofId, stage, state, ...(error ? { error } : {}) });
      };
      try {
        report('uploading');
        const up = await sb.storage.from('proofs').upload(path, it.blob, { contentType: it.type });
        if (up.error && isNet(up.error)) { report('waiting', up.error.message); break; }
        if (up.error && !/exists|duplicate/i.test(up.error.message)) {
          report('failed', up.error.message);
          throw up.error;
        }
        report('submitting');
        const submitted = await sb.rpc('submit_proof_stage', {
          p_proof_id: proofId, p_stage: stage, p_image_path: path,
        });
        if (submitted.error && isNet(submitted.error)) { report('waiting', submitted.error.message); break; }
        if (submitted.error) {
          report('failed', submitted.error.message);
          throw submitted.error;
        }
        await removeQueued(it.id!);
        report('sent');
        sent++;
      } catch (reason) {
        if (isNet(reason)) { report('waiting', (reason as { message?: string })?.message ?? String(reason)); break; }
        throw reason;
      }
      continue;
    }

    continue;
  }
  return sent;
}
