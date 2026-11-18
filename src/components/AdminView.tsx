'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { Ctx, FEE } from '@/lib/types';
import { BarChart } from './ui';
import AdminPromos from './AdminPromos';
import AdminUsers from './AdminUsers';
import AdminActivity from './AdminActivity';

interface Stats {
  users: number; users7: number; ca: number; cp: number; cd: number; fees: number; views: number;
  paid_out: number; pending_wd: number; bonus_total: number; balances: number; promo_cost: number; perks: number; boosted: number;
  series: { d: string; users: number; views: number }[];
}

export default function AdminView({ c }: { c: Ctx }) {
  const { t, f } = useI18n();
  const [view, setView] = useState<'dash' | 'manage' | 'users' | 'activity'>('dash');
  const [st, setSt] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState('');
  const [views, setViews] = useState<Record<number, string>>({});
  const [payoutBusy, setPayoutBusy] = useState<number | null>(null);
  const { camps, aP, aW } = c.d;
  const toActivate = camps.filter((x) => x.status === 'pending' && x.payment_provider !== 'saspay');
  const toReviewPayment = camps.filter((x) => x.status === 'pending' && x.payment_status === 'review');
  const title = (id: number) => camps.find((x) => x.id === id)?.title ?? '#' + id;

  useEffect(() => {
    if (view !== 'dash') return;
    let current = true;
    setSt(null);
    setStatsError('');
    const loadStats = async () => {
      try {
        const result = await sb.rpc('admin_stats');
        if (!current) return;
        if (result.error) setStatsError(result.error.message);
        else setSt(result.data as Stats);
      } catch (reason) {
        if (current) setStatsError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void loadStats();
    return () => { current = false; };
  }, [view, aP.length, aW.length, camps.length]);

  const done = async () => { await c.reload(); c.say(t('done')); };

  function activate(id: number) {
    c.run(async () => {
      const r = await sb.rpc('activate_campaign', { p_id: id });
      if (r.error) throw r.error;
      await c.reload();
      let msg = t('actd');
      try {
        const token = (await sb.auth.getSession()).data.session?.access_token;
        const res = await fetch('/api/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token ?? '') },
          body: JSON.stringify({ campaignId: id }),
        });
        if (res.ok) msg += ` ${t('notified')} ${((await res.json()) as { sent: number }).sent}`;
      } catch { /* notifications facultatives */ }
      c.say(msg);
    });
  }
  function resolvePaymentReview(id: number) {
    c.run(async () => {
      const r = await sb.rpc('admin_resolve_saspay_payment_review', { p_campaign_id: id });
      if (r.error) throw r.error;
      await c.reload();
      c.say(t('saspay_review_done'));
    });
  }
  function seeProof(path: string) {
    c.run(async () => {
      const r = await sb.storage.from('proofs').createSignedUrl(path, 120);
      if (r.error) throw r.error;
      window.open(r.data.signedUrl, '_blank', 'noopener');
    });
  }
  function review(id: number, ok: boolean) {
    c.run(async () => {
      const n = Number(views[id] || 0);
      if (ok && !n) throw new Error(t('nv'));
      const r = await sb.rpc('review_proof', { p_id: id, p_views: n, p_ok: ok });
      if (r.error) throw r.error;
      await done();
    });
  }
  function processPayout(id: number) {
    c.run(async () => {
      setPayoutBusy(id);
      try {
        const token = (await sb.auth.getSession()).data.session?.access_token;
        if (!token) throw new Error(t('auth_login_hint'));
        const response = await fetch('/api/saspay/payout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ withdrawalId: id }),
        });
        const result = await response.json() as { status?: string; error?: string };
        if (!response.ok) throw new Error(result.error || 'Impossible de traiter le payout SasPay');
        await c.reload();
        c.say(t(result.status === 'paid' ? 'saspay_payout_paid'
          : result.status === 'failed' ? 'saspay_payout_failed' : 'saspay_payout_pending'));
      } finally {
        setPayoutBusy(null);
      }
    });
  }

  return (
    <>
      <div className="admin-tabs" role="tablist" aria-label={t('manage')}>
        <button className={'s' + (view === 'dash' ? ' on' : '')} role="tab" aria-selected={view === 'dash'} onClick={() => setView('dash')}>{t('dash')}</button>
        <button className={'s' + (view === 'manage' ? ' on' : '')} role="tab" aria-selected={view === 'manage'} onClick={() => setView('manage')}>
          {t('manage')}{aP.length + aW.length + toActivate.length + toReviewPayment.length > 0
            ? ` (${aP.length + aW.length + toActivate.length + toReviewPayment.length})` : ''}
        </button>
        <button className={'s' + (view === 'users' ? ' on' : '')} role="tab" aria-selected={view === 'users'} onClick={() => setView('users')}>{t('k_users')}</button>
        <button className={'s' + (view === 'activity' ? ' on' : '')} role="tab" aria-selected={view === 'activity'} onClick={() => setView('activity')}>{t('admin_activity')}</button>
      </div>

      {view === 'dash' && (
        <>
          {statsError && <p className="card err" role="alert">{statsError}</p>}
          {!st && !statsError && <p className="m">…</p>}
          {st && (
            <>
              <div className="kpis">
                <div className="kpi"><b>{st.users}</b><span>{t('k_users')}</span><small>+{st.users7} {t('k_users7')}</small></div>
                <div className="kpi"><b>{f(st.fees)}</b><span>{t('k_fees')}</span></div>
                <div className="kpi"><b>{Number(st.views).toLocaleString()}</b><span>{t('k_views')}</span></div>
                <div className="kpi"><b>{st.ca}</b><span>{t('k_camps')}</span></div>
                <div className="kpi"><b>{st.cp}</b><span>{t('k_cpend')}</span></div>
                <div className="kpi"><b>{f(st.balances)}</b><span>{t('k_bal')}</span></div>
                <div className="kpi"><b>{f(st.pending_wd)}</b><span>{t('k_wd')}</span></div>
                <div className="kpi"><b>{f(st.paid_out)}</b><span>{t('k_paid')}</span></div>
                <div className="kpi"><b>{f(st.bonus_total)}</b><span>{t('k_bonus')}</span></div>
                <div className="kpi"><b>{f(st.promo_cost)}</b><span>{t('k_promo')}</span></div>
                <div className="kpi"><b>{f(st.perks)}</b><span>{t('k_perks')}</span></div>
                <div className="kpi"><b>{st.boosted}</b><span>{t('k_boost')}</span></div>
              </div>
              <section className="card">
                <BarChart title={t('c_users')} labels={st.series.map((s) => s.d)} values={st.series.map((s) => Number(s.users))} />
              </section>
              <section className="card">
                <BarChart title={t('c_views')} labels={st.series.map((s) => s.d)} values={st.series.map((s) => Number(s.views))} />
              </section>
            </>
          )}
        </>
      )}

      {view === 'manage' && (
        <>
          <AdminPromos c={c} />
          <section className="card">
            <h2>{t('cq')}</h2>
            {toActivate.length > 0 && <p className="note">{t('admin_check_payment')}</p>}
            {toActivate.length === 0 && <p className="m">{t('none')}</p>}
            {toActivate.map((x, i) => (
              <div className={'row' + (i === 0 ? ' first' : '')} key={x.id}>
                <div><b>{x.title}</b><div className="m">{f(x.budget + FEE)} · {x.country ?? t('all_c')}</div></div>
                <button className="s" onClick={() => activate(x.id)}>{t('act')}</button>
              </div>
            ))}
          </section>

          {toReviewPayment.length > 0 && (
            <section className="card">
              <h2>{t('saspay_review_title')}</h2>
              <p className="note">{t('saspay_review_note')}</p>
              {toReviewPayment.map((campaign) => (
                <div className="row" key={campaign.id}>
                  <div><b>{campaign.title}</b><div className="m">{f(campaign.budget)} · {campaign.country ?? t('all_c')}</div></div>
                  <button className="s" onClick={() => resolvePaymentReview(campaign.id)}>{t('saspay_review_action')}</button>
                </div>
              ))}
            </section>
          )}

          <section className="card">
            <h2>{t('queue')}</h2>
            <p className="note">{t('adminnote')}</p>
            {aP.length === 0 && <p className="m">{t('none')}</p>}
            {aP.map((p) => (
              <div className="row" key={p.id}>
                <div><b>{p.profiles?.phone}</b><div className="m">{title(p.campaign_id)}</div></div>
                <div className="actions">
                  <button className="s" onClick={() => seeProof(p.image_path)}>{t('see')}</button>
                  <input inputMode="numeric" placeholder={t('nv')} aria-label={t('nv')} value={views[p.id] ?? ''} onChange={(e) => setViews({ ...views, [p.id]: e.target.value.replace(/\D/g, '') })} />
                  <button className="s" onClick={() => review(p.id, true)}>{t('ok')}</button>
                  <button className="s" onClick={() => review(p.id, false)}>{t('no')}</button>
                </div>
              </div>
            ))}
          </section>

          <section className="card">
            <h2>{t('wq')}</h2>
            {aW.length === 0 && <p className="m">{t('none')}</p>}
            {aW.map((w, i) => (
              <div className={'row' + (i === 0 ? ' first' : '')} key={w.id}>
                <div>
                  <b>{w.profiles?.phone}</b>
                  <div className="m">{w.operator} · {w.recipient_network || '—'} · {w.recipient_country || '—'} · {w.recipient_phone || w.profiles?.phone} · {f(w.amount)}</div>
                  {w.status === 'processing' && <span className="tag w">{t('saspay_payout_pending')}</span>}
                </div>
                <button className="s" disabled={payoutBusy === w.id} onClick={() => processPayout(w.id)}>
                  {payoutBusy === w.id ? '…' : t('saspay_payout_action')}
                </button>
              </div>
            ))}
          </section>
        </>
      )}
      {view === 'users' && <AdminUsers />}
      {view === 'activity' && <AdminActivity />}
    </>
  );
}
