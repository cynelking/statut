'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';

interface L { lvl: 'bronze' | 'silver' | 'gold'; pct: number; n_ok: number; n_ko: number }

export default function LevelCard({ dep }: { dep: number }) {
  const { t } = useI18n();
  const [l, setL] = useState<L | null>(null);
  useEffect(() => {
    sb.rpc('my_level').then((r) => { const row = (r.data as L[] | null)?.[0]; if (row) setL(row); });
  }, [dep]);
  if (!l) return null;
  const target = l.lvl === 'bronze' ? 5 : l.lvl === 'silver' ? 20 : 0;
  const left = Math.max(0, target - l.n_ok);
  return (
    <section className="card">
      <div className="row first">
        <div><h2 style={{ marginBottom: 4 }}>{t('lvl_t')}</h2><span className={'lvl ' + l.lvl}>{t('lvl_' + l.lvl)}</span></div>
        <b style={{ fontFamily: 'var(--fd)', fontSize: 22 }}>+{l.pct} %</b>
      </div>
      <p className="m" style={{ margin: '0 0 6px' }}>{l.pct > 0 ? `+${l.pct} % ${t('lvl_bonus')}` : t('lvl_rule')}</p>
      {target > 0 ? (
        <>
          <div className="bar"><i style={{ width: Math.min(100, Math.round((l.n_ok / target) * 100)) + '%' }} /></div>
          <p className="m" style={{ margin: '8px 0 0' }}>{left} {t('lvl_left')}</p>
        </>
      ) : (
        <p className="m" style={{ margin: 0 }}>{t('lvl_max')}</p>
      )}
    </section>
  );
}
