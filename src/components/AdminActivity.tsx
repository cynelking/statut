'use client';
import { useCallback, useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';

interface Activity {
  id: number;
  actor_phone: string | null;
  target_type: 'campaign' | 'proof' | 'withdrawal';
  target_id: number;
  old_status: string;
  new_status: string;
  created_at: string;
}

function formatDate(value: string, lang: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const locale = lang === 'en' ? 'en-US' : lang === 'pt' ? 'pt-PT' : 'fr-FR';
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function AdminActivity() {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await sb.from('admin_activity')
        .select('id,actor_phone,target_type,target_id,old_status,new_status,created_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (result.error) {
        setError(result.error.message);
        setItems([]);
      } else {
        setItems((result.data ?? []) as Activity[]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function statusLabel(status: string) {
    if (status === 'approved') return t('ap');
    if (status === 'rejected') return t('rj');
    if (status === 'active') return t('st_active');
    if (status === 'done') return t('st_done');
    if (status === 'paid') return t('admin_status_paid');
    return t('pd');
  }

  function targetLabel(type: Activity['target_type']) {
    if (type === 'campaign') return t('myc');
    if (type === 'proof') return t('proof');
    return t('wd');
  }

  return (
    <section className="card">
      <div className="admin-section-head">
        <h2>{t('admin_activity')}</h2>
        <button className="s" type="button" onClick={() => { void load(); }}>{t('admin_refresh')}</button>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {loading && <p className="m">…</p>}
      {!loading && !error && items.length === 0 && <p className="m">{t('admin_activity_empty')}</p>}
      {!loading && !error && items.map((item) => (
        <div className="row admin-activity-row" key={item.id}>
          <div className="admin-user-info">
            <b>{targetLabel(item.target_type)} #{item.target_id}</b>
            <span className="m">
              {item.actor_phone || t('admin_actor')} · {formatDate(item.created_at, lang)}
            </span>
          </div>
          <span className="tag">{statusLabel(item.old_status)} → {statusLabel(item.new_status)}</span>
        </div>
      ))}
    </section>
  );
}
