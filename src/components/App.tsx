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
import TransactionHistory from './TransactionHistory';
import PushToggle from './PushToggle';
import { FAQ } from '@/lib/faq';
import { ADMIN } from '@/lib/types';

const EMPTY: Data = { bal: 0, walletBalance: 0, camps: [], proofs: [], wd: [], aP: [], aW: [], walletTopupsReview: [], favs: [], myReviews: [], ratings: {} };
type WorkspacePage = 'dashboard' | 'feed' | 'advertiser' | 'campaigns' | 'wallet' | 'create' | 'admin' | 'profile' | 'notifications' | 'help';

export default function App() {
  const { t, lang } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [d, setD] = useState<Data>(EMPTY);
  const [page, setPage] = useState<WorkspacePage>('dashboard');
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
  }, [page]);

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
    if (prof?.role !== 'admin') setPage((current) => current === 'admin' ? 'dashboard' : current);

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
      setPage('dashboard');
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
  const workspaceItems: { id: WorkspacePage; icon: string; label: string }[] = [
    { id: 'dashboard', icon: 'home', label: t('nav_home') },
    { id: 'feed', icon: 'f', label: t('nav_feed') },
    { id: 'advertiser', icon: 'a', label: t('nav_advertiser') },
    { id: 'campaigns', icon: 'campaign', label: t('nav_campaigns') },
    { id: 'wallet', icon: 'wallet', label: t('nav_wallet') },
    { id: 'create', icon: 'plus', label: t('nav_create') },
    ...(admin ? [{ id: 'admin' as const, icon: 'm', label: t('nav_admin') }] : []),
    { id: 'profile', icon: 'p', label: t('nav_profile') },
  ];
  const navigate = (next: WorkspacePage) => setPage(admin || next !== 'admin' ? next : 'dashboard');
  const navigateTab = (next: Tab) => {
    const destinations: Record<Tab, WorkspacePage> = {
      d: 'dashboard', f: 'feed', a: 'advertiser', m: 'admin', p: 'profile',
    };
    navigate(destinations[next]);
  };
  const activeLabel = workspaceItems.find((item) => item.id === page)?.label
    ?? (page === 'notifications' ? t('push_t') : page === 'help' ? t('help') : t('profile'));

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
    const ctx: Ctx = {
      user, profile, d, reload, say, run, sel, pick: setSel, go: navigateTab,
      goWallet: () => navigate('wallet'), goCampaigns: () => navigate('campaigns'), toggleFav,
    };
    body = (
      <>
        <OfflineSync c={ctx} />
        {page === 'feed' ? <FeedView c={ctx} />
          : page === 'dashboard' ? <PublisherView c={ctx} view="dashboard" />
            : page === 'wallet' ? <PublisherView c={ctx} view="wallet" />
              : page === 'advertiser' ? <AdvertiserView c={ctx} view="overview" onNavigate={navigate} />
                : page === 'campaigns' ? <AdvertiserView c={ctx} view="campaigns" onNavigate={navigate} />
                  : page === 'create' ? <AdvertiserView c={ctx} view="create" onNavigate={navigate} />
                    : page === 'profile' ? <ProfileView c={ctx} logout={() => { run(async () => { await sb.auth.signOut(); }); }} />
                      : page === 'notifications' ? <section className="page-screen">
                        <div className="page-head"><div><div className="eyebrow">{t('profile')}</div><h1>{t('push_t')}</h1><p className="sub">{t('tx_description')}</p></div></div>
                        <PushToggle c={ctx} />
                        <TransactionHistory />
                      </section>
                        : page === 'help' ? <section className="page-screen">
                          <div className="page-head"><div><div className="eyebrow">{t('help')}</div><h1>{t('faq_t')}</h1><p className="sub">{t('contact')}</p></div></div>
                          <section className="card">
                            <a className="p" href={`https://wa.me/${ADMIN.replace(/\D/g, '')}?text=${encodeURIComponent(t('help_msg') + ' ' + profile.phone)}`} target="_blank" rel="noopener noreferrer">{t('contact')}</a>
                            <h2 style={{ marginTop: 20 }}>{t('faq_t')}</h2>
                            {(FAQ[lang] ?? FAQ.fr).map((item) => (
                              <details className="faq" key={item.q}><summary>{item.q}</summary><p>{item.a}</p></details>
                            ))}
                          </section>
                        </section>
                        : page === 'admin' && admin ? <AdminView c={ctx} /> : <PublisherView c={ctx} view="dashboard" />}
      </>
    );
  }

  return (
    <>
      <header className={`app-header${user ? '' : ' app-header-guest'}`}>
        <div className="logo">
          {user && !recovery
            ? <><div className="brand-mark">S</div><strong>Statut<span>Pay</span></strong></>
            : <Image src="/brand-logo.png" alt="StatutPay" width={1513} height={405} priority />}
        </div>
        {user && !recovery && (
          <>
            <div className="workspace-label">{t('nav_workspace')}</div>
            <nav className="desktop-nav" aria-label={t('navigation')}>
              {workspaceItems.map((item) => (
                <button key={item.id} className={page === item.id ? 'on' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
                  <Icon n={item.icon} /><span>{item.label}</span>
                </button>
              ))}
            </nav>
          </>
        )}
        {user && !recovery && <div className="workspace-footer">StatutPay 2.0<br />{t('nav_footer')}</div>}
        <div className="hr">
          <InstallButton />
          {user && !recovery && <button className="iconbtn" aria-label={t('push_t')} title={t('push_t')} onClick={() => navigate('notifications')}><Icon n="bell" /></button>}
          <button className="iconbtn" aria-label={t('help')} title={t('help')} onClick={() => user && !recovery ? navigate('help') : setSheet('help')}><Icon n="help" /></button>
          {user && profile && (
            <button className="iconbtn avbtn" aria-label={t('profile')} title={t('profile')} onClick={() => navigate('profile')}>
              {profile.avatar ? <span aria-hidden="true">{profile.avatar}</span> : <Icon n="user" />}
            </button>
          )}
          <LangSelect />
        </div>
      </header>
      <main className={user && !recovery ? 'app-main-auth' : ''}>
        {user && !recovery && (
          <div className="workspace-topbar" aria-label="Fil d’Ariane">
            <div>StatutPay <span>/</span> <b>{activeLabel}</b></div>
          </div>
        )}
        <ScrollEffects />
        <InstallBanner />
        {body}
      </main>
      {user && !recovery && (
        <nav className="mobile-nav" aria-label="Navigation principale">
          {workspaceItems.filter((item) => item.id !== 'admin').map((item) => (
            <button key={item.id} className={page === item.id ? 'on' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
              <Icon n={item.icon} /><span>{item.label}</span>
            </button>
          ))}
          {admin && (
            <button className={page === 'admin' ? 'on' : ''} aria-current={page === 'admin' ? 'page' : undefined} onClick={() => navigate('admin')}>
              <Icon n="m" /><span>{t('r_m')}</span>
            </button>
          )}
        </nav>
      )}
      {sheet === 'help' && <HelpSheet profile={profile} onClose={() => setSheet(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
