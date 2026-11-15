'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { BarChart } from './ui';

interface Rep { budget: number; spent: number; publishers: number; pending: number; rejected: number; avg: number; series: { d: string; views: number }[] }

export default function ReportPanel({ id }: { id: number }) {
  const { t, f } = useI18n();
  const [r, setR] = useState<Rep | null>(null);
  useEffect(() => { sb.rpc('campaign_report', { p_id: id }).then((x) => { if (!x.error) setR(x.data as Rep); }); }, [id]);
  if (!r) return <p className="m">…</p>;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="kpis">
        <div className="kpi"><b>{Number(r.spent).toLocaleString()}</b><span>{t('views')} / {Number(r.budget).toLocaleString()}</span></div>
        <div className="kpi"><b>{r.publishers}</b><span>{t('r_pub')}</span></div>
        <div className="kpi"><b>{Number(r.avg).toLocaleString()}</b><span>{t('r_avg')}</span></div>
        <div className="kpi"><b>{r.pending}</b><span>{t('r_pend')}</span></div>
        <div className="kpi"><b>{r.rejected}</b><span>{t('r_rej')}</span></div>
        <div className="kpi"><b>{f(r.spent)}</b><span>{t('spent')}</span></div>
      </div>
      <div style={{ marginTop: 12 }}>
        <BarChart title={t('r_series')} labels={r.series.map((s) => s.d)} values={r.series.map((s) => Number(s.views))} />
      </div>
    </div>
  );
}
