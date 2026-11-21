'use client';
import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import type { User } from '@supabase/supabase-js';
import { configured, sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import type { Campaign, Ctx, Data, Profile, Proof, Tab, Withdrawal } from '@/lib/types';
import { Icon } from './ui';
import AuthView from './AuthView';
import ResetView from './ResetView';
import FeedView from './FeedView';
import PublisherView from './PublisherView';
import AdvertiserView from './AdvertiserView';
import AdminView from './AdminView';
import InstallButton from './InstallButton';
import InstallBanner from './InstallBanner';
import { HelpSheet } from './Sheets';
import ProfileView from './ProfileView';
import LangSelect from './LangSelect';
import OfflineSync from './OfflineSync';
import ScrollEffects from './ScrollEffects';
import LandingView from './LandingView';

const EMPTY: Data = { bal: 0, walletBalance: 0, camps: [], proofs: [], wd: [], aP: [], aW: [], walletTopupsReview: [], favs: [], myReviews: [], ratings: {} };

export default function App() {
  const { t } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [d, setD] = useState<Data>(EMPTY);
  const [tab, setTab] = useState<Tab>('d');
  const [sel, setSel] = useState<number | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [profileLoadError, setProfileLoadError] = useState('');
  const [toast, setToast] = useState('');
  const [sheet, setSheet] = useState<null | 'help'>(null);

  const say = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 3200);
  }, []);

  const run = useCallback((fn: () => Promise<void>) => {
    fn().catch((e: unknown) => say((e as { message?: string })?.message ?? String(e)));
  }, [say]);

  useEffect(() => {
    const th = localStorage.getItem('theme');
    if (th === 'light' || th === 'dark') document.documentElement.setAttribute('data-theme', th);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  useEffect(() => {
    if (!configured) return;
    const { data } = sb.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setUser(session?.user ?? null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const load = useCallback(async (u: User) => {
    const expired = await sb.rpc('expire_campaigns');
    if (expired.error) throw expired.error;
    const [p, bal, walletBalance, c, pr, w, fv, rt, mr] = await Promise.all([
      sb.from('profiles').select('*').eq('id', u.id).single(),
      sb.rpc('my_balance'),
      sb.rpc('my_wallet_balance'),
      sb.from('campaigns').select('*').order('id', { ascending: false }),
      sb.from('proofs').select('*').eq('user_id', u.id),
      sb.from('withdrawals').select('*').eq('user_id', u.id),
      sb.from('favorites').select('campaign_id'),
      sb.rpc('ratings'),
      sb.from('reviews').select('proof_id').eq('from_user', u.id),
    ]);
    if (p.error) throw p.error;
    const prof = (p.data ?? null) as Profile | null;
    if (!prof) throw new Error('No profile is associated with this account.');

    const ratings: Data['ratings'] = {};
    for (const r of ((rt.data ?? []) as { uid: string; dir: string; score: number; n: number }[])) {
      if (r.dir === 'pub_to_adv') ratings[r.uid] = { score: Number(r.score), n: r.n };
    }
    if (bal.error) throw bal.error;
    if (walletBalance.error) throw walletBalance.error;
    let aP: Proof[] = [];
    let aW: Withdrawal[] = [];
    let walletTopupsReview: Data['walletTopupsReview'] = [];
    if (prof?.role === 'admin') {
      const [a, b, topups] = await Promise.all([
        sb.from('proofs').select('*,profiles(phone)').eq('status', 'pending'),
        sb.from('withdrawals').select('*,profiles(phone)').in('status', ['pending', 'processing']),
        sb.rpc('admin_wallet_topups_for_review'),
      ]);
      aP = (a.data ?? []) as unknown as Proof[];
      aW = (b.data ?? []) as unknown as Withdrawal[];
      if (topups.error) throw topups.error;
      walletTopupsReview = (topups.data ?? []) as Data['walletTopupsReview'];
    }
    setProfile(prof);
    setD({
      bal: (bal.data as number | null) ?? 0,
      walletBalance: (walletBalance.data as number | null) ?? 0,
      camps: (c.data ?? []) as Campaign[],
      proofs: (pr.data ?? []) as Proof[],
      wd: (w.data ?? []) as Withdrawal[],
      favs: ((fv.data ?? []) as { campaign_id: number }[]).map((x) => x.campaign_id),
      myReviews: ((mr.data ?? []) as { proof_id: number }[]).map((x) => x.proof_id),
      ratings,
      aP,
      aW,
      walletTopupsReview,
    });
    if (prof?.role !== 'admin') setTab((x) => (x === 'm' ? 'f' : x));

    if (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
      const session = await sb.auth.getSession();
      const token = session.data.session?.access_token;
      if (token) {
        void fetch('/api/notify', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }).then(async (response) => {
          if (!response.ok) console.error('Campaign push dispatch failed', await response.text());
        }).catch((reason: unknown) => console.error('Campaign push dispatch failed', reason));
      }
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setProfile(null);
      setD(EMPTY);
      setProfileLoadError('');
      return;
    }
    setProfileLoadError('');
    const id = setTimeout(() => {
      load(user).catch((reason: unknown) => {
        setProfileLoadError(reason instanceof Error ? reason.message : String(reason));
      });
    }, 0);
    return () => clearTimeout(id);
  }, [user?.id, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(async () => { if (user) await load(user); }, [user, load]);
  const retryProfileLoad = useCallback(() => {
    if (!user) return;
    setProfileLoadError('');
    load(user).catch((reason: unknown) => {
      setProfileLoadError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [user, load]);

  useEffect(() => {
    if (!user || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const paymentId = url.searchParams.get('alphapay_payment_id');
    const topupId = url.searchParams.get('alphapay_topup_id');
    if (!paymentId && !topupId) return;

    let active = true;
    void (async () => {
      const session = await sb.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) return;
      url.searchParams.delete('alphapay_payment_id');
      url.searchParams.delete('alphapay_topup_id');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);

      const endpoint = paymentId ? 'payment-status' : 'wallet-topup-status';
      const id = paymentId || topupId;
      const response = await fetch(`/api/alphapay/${endpoint}?id=${encodeURIComponent(id || '')}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await response.json() as { status?: string; error?: string };
      if (!response.ok) throw new Error(result.error || 'Impossible de vérifier le paiement AlphaPay');
      await load(user);
      if (!active) return;
      if (topupId) {
        say(t(result.status === 'succeeded' ? 'saspay_topup_paid'
          : result.status === 'review' ? 'saspay_topup_review'
            : result.status === 'failed' ? 'saspay_topup_failed' : 'saspay_topup_pending'));
        return;
      }
      say(t(result.status === 'succeeded' ? 'saspay_return_paid'
        : result.status === 'review' ? 'saspay_return_review'
          : result.status === 'failed' ? 'saspay_return_failed' : 'saspay_return_pending'));
    })().catch((reason: unknown) => {
      if (active) say(reason instanceof Error ? reason.message : String(reason));
    });

    return () => { active = false; };
  }, [user, load, say, t]);

  const toggleFav = useCallback((id: number) => {
    if (!user) return;
    const has = d.favs.includes(id);
    setD((x) => ({ ...x, favs: has ? x.favs.filter((i) => i !== id) : [...x.favs, id] }));
    run(async () => {
      const r = has
        ? await sb.from('favorites').delete().eq('campaign_id', id)
        : await sb.from('favorites').insert({ campaign_id: id });
      if (r.error) { await load(user); throw r.error; }
    });
  }, [user, d.favs, run, load]);

  const admin = profile?.role === 'admin';
  const tabs: Tab[] = admin ? ['f', 'd', 'a', 'm', 'p'] : ['f', 'd', 'a', 'p'];

  let body: React.ReactNode;
  if (!user) body = (
    <>
      <LandingView />
      <section className="landing-auth" id="auth" aria-label={t('auth_choose')}>
        {configured ? <AuthView run={run} /> : <div className="card err">{t('cfg')}</div>}
      </section>
    </>
  );
  else if (recovery) body = <ResetView run={run} say={say} done={() => setRecovery(false)} />;
  else if (!profile && profileLoadError) body = (
    <section className="card err" role="alert">
      <p>{t('app_load_failed')}</p>
      <p className="m">{profileLoadError}</p>
      <button className="s" type="button" onClick={retryProfileLoad}>{t('admin_refresh')}</button>
    </section>
  );
  else if (!profile) body = <p className="m">…</p>;
  else {
    const ctx: Ctx = { user, profile, d, reload, say, run, sel, pick: setSel, go: setTab, toggleFav };
    body = (
      <>
        <OfflineSync c={ctx} />
        {tab === 'f' ? <FeedView c={ctx} /> : tab === 'd' ? <PublisherView c={ctx} /> : tab === 'a' ? <AdvertiserView c={ctx} /> : tab === 'p' ? <ProfileView c={ctx} logout={() => { run(async () => { await sb.auth.signOut(); }); }} /> : <AdminView c={ctx} />}
      </>
    );
  }

  return (
    <>
      <header className="app-header">
        <div className="logo"><Image src="/brand-logo.png" alt="StatutPay" width={1513} height={405} priority /></div>
        <nav className="desktop-nav" aria-label="Navigation principale">
          {user && !recovery && tabs.map((r) => (
            <button key={r} className={tab === r ? 'on' : ''} aria-current={tab === r ? 'page' : undefined} onClick={() => setTab(r)}>
              <Icon n={r} /><span>{t('r_' + r)}</span>
            </button>
          ))}
        </nav>
        <div className="hr">
          <InstallButton />
          <button className="iconbtn" aria-label={t('help')} title={t('help')} onClick={() => setSheet('help')}><Icon n="help" /></button>
          {user && profile && (
            <button className="iconbtn avbtn" aria-label={t('profile')} title={t('profile')} onClick={() => setTab('p')}>
              {profile.avatar ? <span aria-hidden="true">{profile.avatar}</span> : <Icon n="user" />}
            </button>
          )}
          <LangSelect />
        </div>
      </header>
      <main>
        <ScrollEffects />
        <InstallBanner />
        {body}
      </main>
      {user && !recovery && (
        <nav className="mobile-nav" aria-label="Navigation principale">
          {tabs.map((r) => (
            <button key={r} className={tab === r ? 'on' : ''} aria-current={tab === r ? 'page' : undefined} onClick={() => setTab(r)}>
              <Icon n={r} /><span>{t('r_' + r)}</span>
            </button>
          ))}
        </nav>
      )}
      {sheet === 'help' && <HelpSheet profile={profile} onClose={() => setSheet(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
