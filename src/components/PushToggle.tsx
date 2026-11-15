'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { PushState, pushState, subscribePush, unsubscribePush } from '@/lib/push';
import type { Ctx } from '@/lib/types';
import { Icon } from './ui';

export default function PushToggle({ c }: { c: Ctx }) {
  const { t } = useI18n();
  const [st, setSt] = useState<PushState>('unsupported');
  useEffect(() => { pushState().then(setSt).catch(() => {}); }, []);
  if (st === 'unsupported') return null;

  function toggle() {
    c.run(async () => {
      if (st === 'on') {
        await unsubscribePush(); setSt('off'); c.say(t('push_stopped'));
      } else {
        const r = await subscribePush(c.profile.country);
        if (r === 'denied') { setSt('denied'); throw new Error(t('push_denied')); }
        setSt('on'); c.say(t('push_done'));
      }
    });
  }

  return (
    <section className="card">
      <div className="row first">
        <div className="rl">
          <i className="ic"><Icon n="bell" /></i>
          <div><b>{t('push_t')}</b><div className="m">{st === 'denied' ? t('push_denied') : t('push_b')}</div></div>
        </div>
        {st !== 'denied' && <button className="s" onClick={toggle}>{st === 'on' ? t('push_off') : t('push_on')}</button>}
      </div>
    </section>
  );
}
