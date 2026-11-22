'use client';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { discardLegacyQueue, flushQueue, listQueue } from '@/lib/offline';
import type { Ctx } from '@/lib/types';

export default function OfflineSync({ c }: { c: Ctx }) {
  const { t } = useI18n();
  const [n, setN] = useState(0);
  const [legacyCount, setLegacyCount] = useState(0);
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
        const sent = await flushQueue(uid);
        if (sent > 0) { await cr.current.reload(); cr.current.say(`${t('q_done')} ${sent}`); }
      } catch (reason) {
        if (reason instanceof Error && !/network|fetch|offline/i.test(reason.message)) {
          cr.current.say(reason.message === 'proof_legacy_queue' ? t('proof_legacy_queue') : reason.message);
        }
      } finally { busy.current = false; refresh(); }
    };
    const onOnline = () => { flush(); };
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
      {legacyCount > 0 && <button className="s" onClick={discardLegacy}>{t('proof_legacy_discard')}</button>}
      <button className="p" disabled={legacyCount === n} onClick={() => window.dispatchEvent(new Event('online'))}>{t('q_send')}</button>
    </div>
  );
}
