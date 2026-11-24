'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import type { User } from '@supabase/supabase-js';
import { configured, sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import type { AgencyWorkspace, Campaign, Ctx, Data, Profile, Proof, Tab, Withdrawal } from '@/lib/types';
import { Icon } from './ui';
import AuthView from './AuthView';
import ResetView from './ResetView';
import FeedView from './FeedView';
import PublisherView from './PublisherView';
import AdvertiserView from './AdvertiserView';
import AgencyInvitations from './AgencyInvitations';
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
type WorkspacePage = 'dashboard' | 'feed' | 'advertiser' | 'agency' | 'campaigns' | 'wallet' | 'create' | 'admin' | 'profile' | 'notifications' | 'help';

export default function App() {
  const { t, lang } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [d, setD] = useState<Data>(EMPTY);
  const [teamMemberships, setTeamMemberships] = useState<AgencyWorkspace[]>([]);
  const [selectedAgencyWorkspaceId, setSelectedAgencyWorkspaceId] = useState<string | null>(null);
  const [agencyAdvertiserId, setAgencyAdvertiserId] = useState<number | null>(null);
  const [page, setPage] = useState<WorkspacePage>('dashboard');
  const [agencyPageMode, setAgencyPageMode] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [profileLoadError, setProfileLoadError] = useState('');
  const [toast, setToast] = useState('');
  const [sheet, setSheet] = useState<null | 'help'>(null);
  const processedTeamInvite = useRef<string | null>(null);

  const agencyWorkspaces = useMemo<AgencyWorkspace[]>(() => [
    ...(profile?.role === 'agency' ? [{
      id: profile.id,
      name: profile.display_name?.trim() || profile.phone || 'StatutPay',
      role: 'owner' as const,
    }] : []),
    ...teamMemberships,
  ], [profile, teamMemberships]);
  const activeAgencyWorkspace = agencyWorkspaces.find((workspace) => workspace.id === selectedAgencyWorkspaceId)
    ?? agencyWorkspaces[0] ?? null;
  const agencyWorkspaceId = activeAgencyWorkspace?.id ?? null;
  const agencyWorkspaceRole = activeAgencyWorkspace?.role ?? null;

  const say = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 3200);
  }, []);
  const selectAgencyWorkspace = useCallback((id: string) => {
    setSelectedAgencyWorkspaceId(id);
    if (user?.id) localStorage.setItem(`agency-workspace:${user.id}`, id);
  }, [user?.id]);
  const selectAgencyAdvertiser = useCallback((id: number | null) => {
    setAgencyAdvertiserId(id);
    if (!user?.id || !agencyWorkspaceId) return;
    const key = `agency-advertiser:${user.id}:${agencyWorkspaceId}`;
    if (id === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(id));
  }, [user?.id, agencyWorkspaceId]);

  useEffect(() => {
    if (!user?.id) {
      setSelectedAgencyWorkspaceId(null);
      setAgencyAdvertiserId(null);
      return;
    }
    if (agencyWorkspaces.length === 0) {
      setSelectedAgencyWorkspaceId(null);
      setAgencyAdvertiserId(null);
      return;
    }
    const storedWorkspace = localStorage.getItem(`agency-workspace:${user.id}`);
    const nextWorkspaceId = agencyWorkspaces.find((workspace) => workspace.id === selectedAgencyWorkspaceId)?.id
      ?? agencyWorkspaces.find((workspace) => workspace.id === storedWorkspace)?.id
      ?? agencyWorkspaces[0].id;
    if (nextWorkspaceId !== selectedAgencyWorkspaceId) setSelectedAgencyWorkspaceId(nextWorkspaceId);
    localStorage.setItem(`agency-workspace:${user.id}`, nextWorkspaceId);
  }, [user?.id, agencyWorkspaces, selectedAgencyWorkspaceId]);

  useEffect(() => {
    if (!user?.id || !agencyWorkspaceId) {
      setAgencyAdvertiserId(null);
      return;
    }
    const storedValue = localStorage.getItem(`agency-advertiser:${user.id}:${agencyWorkspaceId}`)
      ?? (agencyWorkspaceRole === 'owner' ? localStorage.getItem(`agency-advertiser:${user.id}`) : null);
    const stored = Number(storedValue);
    setAgencyAdvertiserId(Number.isSafeInteger(stored) && stored > 0 ? stored : null);
  }, [user?.id, agencyWorkspaceId, agencyWorkspaceRole]);

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
    const expiredProofs = await sb.rpc('expire_proofs');
    if (expiredProofs.error) throw expiredProofs.error;
    const expired = await sb.rpc('expire_campaigns');
    if (expired.error) throw expired.error;
    const [p, bal, walletBalance, c, pr, w, fv, rt, mr, memberships] = await Promise.all([
      sb.from('profiles').select('*').eq('id', u.id).single(),
      sb.rpc('my_balance'),
      sb.rpc('my_wallet_balance'),
      sb.from('campaigns').select('*').order('id', { ascending: false }),
      sb.from('proofs').select('*').eq('user_id', u.id),
      sb.from('withdrawals').select('*').eq('user_id', u.id),
      sb.from('favorites').select('campaign_id'),
      sb.rpc('ratings'),
      sb.from('reviews').select('proof_id').eq('from_user', u.id),
      sb.from('agency_team_members').select('agency_id,agency_name,role')
        .eq('user_id', u.id).eq('status', 'accepted'),
    ]);
    if (p.error) throw p.error;
    if (memberships.error) throw memberships.error;
    const prof = (p.data ?? null) as Profile | null;
    if (!prof) throw new Error('No profile is associated with this account.');
    setTeamMemberships(((memberships.data ?? []) as { agency_id: string; agency_name: string; role: 'manager' | 'reader' }[])
      .map((membership) => ({ id: membership.agency_id, name: membership.agency_name, role: membership.role })));

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
        sb.from('proofs').select('*,profiles(phone)').eq('status', 'pending')
          .not('image_path', 'is', null).or('posted_at.is.null,final_image_path.not.is.null'),
        sb.from('withdrawals').select('*,profiles(phone)').in('status', ['pending', 'processing']),
        sb.rpc('admin_wallet_topups_for_review'),
      ]);
      if (a.error) throw a.error;
      if (b.error) throw b.error;
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
      setTeamMemberships([]);
      setProfileLoadError('');
      setPage('dashboard');
      setAgencyPageMode(false);
      processedTeamInvite.current = null;
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
    if (!user?.id) return;
    let active = true;
    let changeVersion = 0;
    const channel = sb.channel(`campaign-budget-live:${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, (payload) => {
        if (!active) return;
        changeVersion += 1;
        if (payload.eventType === 'DELETE') {
          const deletedId = Number((payload.old as { id?: number }).id);
          setD((current) => ({ ...current, camps: current.camps.filter((campaign) => campaign.id !== deletedId) }));
          return;
        }

        const campaign = payload.new as Campaign;
        setD((current) => {
          const camps = current.camps.filter((existing) => existing.id !== campaign.id);
          camps.push(campaign);
          camps.sort((a, b) => b.id - a.id);
          return { ...current, camps };
        });
      })
      .subscribe((status, error) => {
        if (!active) return;
        if (status === 'SUBSCRIBED') {
          const subscribedVersion = changeVersion;
          void sb.from('campaigns').select('*').order('id', { ascending: false }).then((result) => {
            if (!active || result.error) {
              if (active && result.error) console.error('Realtime campaign refresh failed', result.error);
              return;
            }
            if (changeVersion === subscribedVersion) {
              setD((current) => ({ ...current, camps: (result.data ?? []) as Campaign[] }));
            }
          });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.error('Campaign budget realtime subscription failed', error ?? status);
        }
      });

    return () => {
      active = false;
      void sb.removeChannel(channel);
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user || !profile || typeof window === 'undefined') return;
    const token = new URL(window.location.href).searchParams.get('team_invite');
    if (!token || processedTeamInvite.current === token) return;
    processedTeamInvite.current = token;
    void (async () => {
      try {
        const result = await sb.rpc('accept_agency_team_invitation_by_token', { p_token: token });
        if (result.error) throw result.error;
        const agencyId = String(result.data);
        const url = new URL(window.location.href);
        url.searchParams.delete('team_invite');
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
        await load(user);
        selectAgencyWorkspace(agencyId);
        setAgencyPageMode(true);
        setPage('agency');
        say(t('agency_team_joined'));
      } catch (reason) {
        say(reason instanceof Error ? reason.message : String(reason));
      }
    })();
  }, [user, profile, load, selectAgencyWorkspace, say, t]);

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
      const result = await response.json() as { status?: string; purpose?: string; error?: string };
      if (!response.ok) throw new Error(result.error || 'Impossible de vérifier le paiement AlphaPay');
      await load(user);
      if (!active) return;
      if (topupId) {
        say(t(result.status === 'succeeded' ? 'saspay_topup_paid'
          : result.status === 'review' ? 'saspay_topup_review'
            : result.status === 'failed' ? 'saspay_topup_failed' : 'saspay_topup_pending'));
        return;
      }
      if (result.purpose === 'budget_increase') {
        say(t(result.status === 'succeeded' ? 'campaign_budget_increase_success'
          : result.status === 'refunded' ? 'campaign_budget_increase_refunded'
            : result.status === 'review' ? 'saspay_return_review'
              : result.status === 'failed' ? 'saspay_return_failed' : 'saspay_return_pending'));
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
  const agency = profile?.role === 'agency';
  const showAgencyWorkspace = agency || agencyPageMode;
  const tabs: Tab[] = admin ? ['d', 'a', 'm', 'p']
    : agency ? ['a', ...(teamMemberships.length ? ['g' as const] : []), 'p']
      : ['f', 'd', ...(teamMemberships.length ? ['g' as const] : []), 'a', 'p'];
  const navigate = (next: WorkspacePage) => {
    if (next === 'agency') setAgencyPageMode(true);
    else if (next === 'advertiser') {
      setAgencyPageMode(false);
      if (agency && profile) selectAgencyWorkspace(profile.id);
    } else if (next === 'dashboard') {
      setAgencyPageMode(false);
      if (agency && profile) selectAgencyWorkspace(profile.id);
    } else if (next !== 'campaigns' && next !== 'create') {
      setAgencyPageMode(false);
    }
    setPage(admin || next !== 'admin' ? next : 'dashboard');
  };
  const activeTab: Tab = page === 'feed' ? (admin ? 'd' : 'f')
    : page === 'agency' ? 'g'
      : page === 'advertiser' || page === 'campaigns' || page === 'wallet' || page === 'create' ? 'a'
      : page === 'admin' ? 'm'
        : page === 'profile' || page === 'notifications' || page === 'help' ? 'p' : agency ? 'a' : 'd';
  const navigateTab = (next: Tab) => {
    const destinations: Record<Tab, WorkspacePage> = {
      d: 'dashboard', f: 'feed', a: 'advertiser', g: 'agency', m: 'admin', p: 'profile',
    };
    navigate(destinations[next]);
  };

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
      user, profile, d, agencyWorkspaces,
      agencyWorkspaceId: showAgencyWorkspace ? agencyWorkspaceId : null,
      agencyWorkspaceRole: showAgencyWorkspace ? agencyWorkspaceRole : null,
      selectAgencyWorkspace,
      agencyAdvertiserId, selectAgencyAdvertiser, reload, say, run, sel, pick: setSel, go: navigateTab,
      goWallet: () => navigate('wallet'), goCampaigns: () => navigate('campaigns'), toggleFav,
    };
    body = (
      <>
        <OfflineSync c={ctx} />
        {profile.role !== 'admin' && <AgencyInvitations c={ctx} />}
        {page === 'feed' ? <FeedView c={ctx} />
          : page === 'agency' ? <AdvertiserView c={ctx} view="overview" onNavigate={navigate} />
          : page === 'dashboard' && agency ? <AdvertiserView c={ctx} view="overview" onNavigate={navigate} />
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
        <div className="logo"><Image src="/brand-logo.png" alt="StatutPay" width={1513} height={405} priority /></div>
        {user && !recovery && (
          <nav className="desktop-nav" aria-label={t('navigation')}>
            {tabs.map((tab) => (
              <button key={tab} className={activeTab === tab ? 'on' : ''} aria-current={activeTab === tab ? 'page' : undefined} onClick={() => navigateTab(tab)}>
                <Icon n={tab} /><span>{tab === 'a' && agency ? t('agency_account') : t('r_' + tab)}</span>
              </button>
            ))}
          </nav>
        )}
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
        <ScrollEffects />
        <InstallBanner />
        {body}
      </main>
      {user && !recovery && (
        <nav className="mobile-nav" aria-label="Navigation principale">
          {tabs.map((tab) => (
            <button key={tab} className={activeTab === tab ? 'on' : ''} aria-current={activeTab === tab ? 'page' : undefined} onClick={() => navigateTab(tab)}>
              <Icon n={tab} /><span>{tab === 'a' && agency ? t('agency_account') : t('r_' + tab)}</span>
            </button>
          ))}
        </nav>
      )}
      {sheet === 'help' && <HelpSheet profile={profile} onClose={() => setSheet(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
