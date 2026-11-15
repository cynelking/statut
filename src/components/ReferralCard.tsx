'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { AMB_AT, AMB_BONUS, Ctx, REF_LEVELS } from '@/lib/types';
import { Icon } from './ui';

interface S { invited: number; a1: number; a2: number; a3: number; bonus: number; amb: boolean }

export default function ReferralCard({ c }: { c: Ctx }) {
  const { t, f } = useI18n();
  const [s, setS] = useState<S>({ invited: 0, a1: 0, a2: 0, a3: 0, bonus: 0, amb: false });
  useEffect(() => {
    sb.rpc('my_referral_stats').then((r) => { const row = (r.data as S[] | null)?.[0]; if (row) setS(row); });
  }, []);
  const code = c.profile.ref_code;
  if (!code) return null;
  const link = `${window.location.origin}/?ref=${code}`;
  const text = `${t('ref_msg')} ${link}`;
  const counts = [s.a1, s.a2, s.a3];

  return (
    <section className="card">
      <h2>{t('ref_t')} {s.amb && <span className="lvl gold" style={{ fontSize: 13, marginLeft: 6 }}>{t('ref_amb')}</span>}</h2>
      <p className="m" style={{ margin: 0 }}>{t('ref_b')}</p>
      <div className="mini" style={{ marginTop: 12 }}>
        <span className="tag"><b>{s.invited}</b> {t('ref_inv')}</span>
        <span className="tag ok"><b>{f(s.bonus)}</b> {t('ref_bonus')}</span>
      </div>
      <h2 style={{ marginTop: 14, fontSize: 15 }}>{t('ref_levels')}</h2>
      {REF_LEVELS.map((amt, i) => (
        <div className={'row' + (i === 0 ? ' first' : '')} key={i} style={{ padding: '8px 0' }}>
          <span>{t('ref_l' + (i + 1))}</span>
          <span className="m"><b>{i === 0 && s.amb ? f(AMB_BONUS) : f(amt)}</b> · {counts[i]} {t('ref_act')}</span>
        </div>
      ))}
      {!s.amb && <p className="m" style={{ margin: '6px 0 0' }}>{t('ref_amb_b')} ({s.a1}/{AMB_AT})</p>}
      <div className="reflink">{link}</div>
      <div className="pair">
        <a className="p" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer"><Icon n="share" />{t('ref_share')}</a>
        <button className="s" onClick={() => c.run(async () => { await navigator.clipboard.writeText(link); c.say(t('ref_copied')); })}>{t('ref_copy')}</button>
      </div>
    </section>
  );
}
