'use client';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { discardLegacyQueue, flushQueue, listQueue, type QueueProgress } from '@/lib/offline';
import type { Ctx } from '@/lib/types';

export default function OfflineSync({ c }: { c: Ctx }) {
  const { t } = useI18n();
  const [n, setN] = useState(0);
  const [legacyCount, setLegacyCount] = useState(0);
  const [upload, setUpload] = useState<QueueProgress | null>(null);
  const [sendError, setSendError] = useState('');
  const cr = useRef(c);
  const busy = useRef(false);
  cr.current = c;
  const uid = c.user.id;

  useEffect(() => {
    const refresh = async () => {
      try {
        const queued = await listQueue(uid);
        setN(queued.length);
        setLegacyCount(queued.filter((item) => item.proofId === undefined || !item.stage).length);
      } catch { /* IndexedDB indisponible */ }
    };
    const flush = async () => {
      if (busy.current || !navigator.onLine) return;
      busy.current = true;
      try {
        const sent = await flushQueue(uid, (progress) => setUpload(progress));
        if (sent > 0) {
          setSendError('');
          await cr.current.reload();
          cr.current.say(`${t('q_done')} ${sent}`);
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        const networkError = /network|fetch|offline/i.test(message);
        const displayError = message === 'proof_legacy_queue' ? t('proof_legacy_queue')
          : networkError ? t('proof_upload_network_error') : message;
        setSendError(displayError);
        if (!networkError) cr.current.say(displayError);
      } finally { busy.current = false; refresh(); }
    };
    const onOnline = () => { setSendError(''); void flush(); };
    refresh(); flush();
    window.addEventListener('online', onOnline);
    window.addEventListener('queue-changed', refresh);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('queue-changed', refresh); };
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  const discardLegacy = () => {
    if (!window.confirm(t('proof_legacy_confirm'))) return;
    c.run(async () => {
      await discardLegacyQueue(uid);
      const queued = await listQueue(uid);
      setN(queued.length);
      setLegacyCount(queued.filter((item) => item.proofId === undefined || !item.stage).length);
      c.say(t('proof_legacy_discarded'));
    });
  };

  if (n === 0) return null;
  return (
    <div className="banner" role="status">
      <div><b>{t('q_title')} ({n})</b><span className="m">{legacyCount > 0 ? t('proof_legacy_queue') : t('q_body')}</span></div>
      {upload && <span className="proof-sync-progress" role="status" aria-live="polite">
        {upload.stage === 'h1' ? t('proof_h1_title') : t('proof_h23_title')} · {
          t(upload.state === 'uploading' ? 'proof_upload_uploading'
            : upload.state === 'submitting' ? 'proof_upload_submitting'
              : upload.state === 'sent' ? 'proof_upload_complete'
                : upload.state === 'failed' ? 'proof_upload_error' : 'proof_upload_network_error')
        }
      </span>}
      {sendError && <span className="proof-sync-error" role="alert">{t('proof_upload_error')}: {sendError}</span>}
      {legacyCount > 0 && <button className="s" onClick={discardLegacy}>{t('proof_legacy_discard')}</button>}
      <button className="p" disabled={legacyCount === n} onClick={() => { setSendError(''); window.dispatchEvent(new Event('online')); }}>{t('q_send')}</button>
    </div>
  );
}
