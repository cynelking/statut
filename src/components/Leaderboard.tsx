'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';

interface Row { pos: number; label: string; views: number; me: boolean }

export default function Leaderboard() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { sb.rpc('leaderboard').then((r) => setRows((r.data ?? []) as Row[])); }, []);
  return (
    <section className="card">
      <h2>{t('top_t')}</h2>
      {rows.length === 0 && <p className="m">{t('top_none')}</p>}
      {rows.map((r, i) => (
        <div key={r.pos} className={'rank' + (i === 0 ? ' first p1' : '') + (r.me ? ' me' : '')}>
          <span className="n">{r.pos}</span>
          <span>{r.me ? t('you') : r.label}</span>
          <span className="v">{Number(r.views).toLocaleString()} F</span>
        </div>
      ))}
    </section>
  );
}
