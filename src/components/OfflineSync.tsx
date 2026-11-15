'use client';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { flushQueue, listQueue } from '@/lib/offline';
import type { Ctx } from '@/lib/types';

export default function OfflineSync({ c }: { c: Ctx }) {
  const { t } = useI18n();
  const [n, setN] = useState(0);
  const cr = useRef(c);
  const busy = useRef(false);
  cr.current = c;
  const uid = c.user.id;

  useEffect(() => {
    const refresh = async () => { try { setN((await listQueue(uid)).length); } catch { /* IndexedDB indisponible */ } };
    const flush = async () => {
      if (busy.current || !navigator.onLine) return;
      busy.current = true;
      try {
        const sent = await flushQueue(uid);
        if (sent > 0) { await cr.current.reload(); cr.current.say(`${t('q_done')} ${sent}`); }
      } catch { /* on réessaiera */ } finally { busy.current = false; refresh(); }
    };
    const onOnline = () => { flush(); };
    refresh(); flush();
    window.addEventListener('online', onOnline);
    window.addEventListener('queue-changed', refresh);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('queue-changed', refresh); };
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (n === 0) return null;
  return (
    <div className="banner" role="status">
      <div><b>{t('q_title')} ({n})</b><span className="m">{t('q_body')}</span></div>
      <button className="p" onClick={() => window.dispatchEvent(new Event('online'))}>{t('q_send')}</button>
    </div>
  );
}
