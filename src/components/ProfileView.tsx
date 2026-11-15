'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { Lang, useI18n } from '@/lib/i18n';
import { AVATARS, Ctx } from '@/lib/types';
import { Icon } from './ui';
import LangSelect from './LangSelect';
import ReferralCard from './ReferralCard';
import PushToggle from './PushToggle';
import ProfileOptions from './ProfileOptions';
import TransactionHistory from './TransactionHistory';

type Theme = 'auto' | 'light' | 'dark';

function applyTheme(theme: Theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}

function dateLabel(value: string | undefined, lang: Lang) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const locale = lang === 'en' ? 'en-US' : lang === 'pt' ? 'pt-PT' : 'fr-FR';
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ProfileView({ c, logout }: { c: Ctx; logout: () => void }) {
  const { t, f, lang } = useI18n();
  const [name, setName] = useState(c.profile.display_name ?? '');
  const [avatar, setAvatar] = useState(c.profile.avatar ?? '');
  const [theme, setTheme] = useState<Theme>('auto');

  useEffect(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') setTheme(saved);
  }, []);

  const approvedProofs = c.d.proofs.filter((proof) => proof.status === 'approved');
  const pendingProofs = c.d.proofs.filter((proof) => proof.status === 'pending').length;
  const rejectedProofs = c.d.proofs.filter((proof) => proof.status === 'rejected').length;
  const approvedViews = approvedProofs.reduce((sum, proof) => sum + proof.views, 0);
  const myCampaigns = c.d.camps.filter((campaign) => campaign.owner === c.user.id);
  const activeCampaigns = myCampaigns.filter((campaign) => campaign.status === 'active').length;
  const withdrawn = c.d.wd.reduce((sum, withdrawal) => sum + withdrawal.amount, 0);
  const paidWithdrawals = c.d.wd.filter((withdrawal) => withdrawal.status === 'paid');
  const pendingWithdrawals = c.d.wd.filter((withdrawal) => withdrawal.status === 'pending');
  const paidTotal = paidWithdrawals.reduce((sum, withdrawal) => sum + withdrawal.amount, 0);
  const pendingTotal = pendingWithdrawals.reduce((sum, withdrawal) => sum + withdrawal.amount, 0);
  const recentProofs = [...c.d.proofs]
    .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
    .slice(0, 3);
  const recentCampaigns = [...myCampaigns]
    .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
    .slice(0, 3);
  const campaignTitle = (id: number) => c.d.camps.find((campaign) => campaign.id === id)?.title ?? `#${id}`;

  function exportData() {
    const data = {
      exportedAt: new Date().toISOString(),
      account: {
        id: c.user.id,
        name: c.profile.display_name,
        phone: c.profile.phone,
        country: c.profile.country,
        email: c.user.email,
        role: c.profile.role,
        referralCode: c.profile.ref_code,
        createdAt: c.user.created_at,
      },
      summary: {
        balance: c.d.bal,
        totalEarned: c.d.bal + withdrawn,
        approvedProofs: approvedProofs.length,
        pendingProofs,
        rejectedProofs,
        approvedViews,
        totalWithdrawn: withdrawn,
      },
      proofs: c.d.proofs,
      campaigns: myCampaigns,
      withdrawals: c.d.wd,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `statutpay-profile-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    c.say(t('profile_exported'));
  }

  function saveProfile() {
    c.run(async () => {
      const result = await sb.rpc('update_profile', { p_name: name, p_avatar: avatar });
      if (result.error) throw result.error;
      await c.reload();
      c.say(t('saved_p'));
    });
  }

  return (
    <>
      <section className="profile-head card">
        <div className="profile-avatar" aria-hidden="true">{avatar || <Icon n="user" />}</div>
        <div className="profile-heading">
          <span className="m">{t('profile')}</span>
          <h1>{c.profile.display_name || c.profile.phone}</h1>
          <span className="tag">{c.profile.role === 'admin' ? t('r_m') : t('r_d')}</span>
        </div>
        <div className="profile-head-actions">
          <button className="s" type="button" onClick={() => c.go('d')}>{t('wd')}</button>
          <button className="p" type="button" onClick={() => c.go('f')}>{t('r_f')}</button>
        </div>
      </section>

      <section className="card">
        <h2>{t('profile_details')}</h2>
        <div className="profile-details">
          <div><span>{t('phone')}</span><b>{c.profile.phone}</b></div>
          <div><span>{t('country')}</span><b>{c.profile.country || '—'}</b></div>
          <div><span>{t('email')}</span><b>{c.user.email || '—'}</b></div>
          <div><span>{t('profile_member_since')}</span><b>{dateLabel(c.user.created_at, lang)}</b></div>
          <div><span>{t('profile_favorites')}</span><b>{c.d.favs.length}</b></div>
        </div>
      </section>

      <section className="profile-metrics" aria-label={t('profile_activity')}>
        <div className="profile-metric"><span>{t('bal')}</span><b>{f(c.d.bal)}</b></div>
        <div className="profile-metric"><span>{t('profile_total_earned')}</span><b>{f(c.d.bal + withdrawn)}</b></div>
        <div className="profile-metric"><span>{t('credit')}</span><b>{f(c.profile.credit)}</b></div>
        <div className="profile-metric"><span>{t('profile_approved')}</span><b>{approvedProofs.length}</b></div>
        <div className="profile-metric"><span>{t('profile_pending_proofs')}</span><b>{pendingProofs}</b></div>
        <div className="profile-metric"><span>{t('profile_rejected_proofs')}</span><b>{rejectedProofs}</b></div>
        <div className="profile-metric"><span>{t('profile_total_views')}</span><b>{f(approvedViews)}</b></div>
        <div className="profile-metric"><span>{t('profile_created_campaigns')}</span><b>{myCampaigns.length}</b></div>
        <div className="profile-metric"><span>{t('profile_active_campaigns')}</span><b>{activeCampaigns}</b></div>
        <div className="profile-metric"><span>{t('profile_favorites')}</span><b>{c.d.favs.length}</b></div>
      </section>

      <section className="card">
        <h2>{t('profile_activity')}</h2>
        <div className="grid2">
          <div>
            <h3 className="profile-subheading">{t('mine')}</h3>
            {recentProofs.length === 0 && <p className="m">{t('profile_no_activity')}</p>}
            {recentProofs.map((proof) => (
              <div className="row profile-activity-row" key={proof.id}>
                <div>
                  <b>{campaignTitle(proof.campaign_id)}</b>
                  <div className="m">{dateLabel(proof.created_at, lang)}</div>
                </div>
                <span className={'tag ' + (proof.status === 'approved' ? 'ok' : proof.status === 'rejected' ? 'bad' : 'w')}>
                  {t(proof.status === 'approved' ? 'ap' : proof.status === 'rejected' ? 'rj' : 'pd')}
                </span>
              </div>
            ))}
          </div>
          <div>
            <h3 className="profile-subheading">{t('myc')}</h3>
            {recentCampaigns.length === 0 && <p className="m">{t('profile_no_activity')}</p>}
            {recentCampaigns.map((campaign) => (
              <div className="row profile-activity-row" key={campaign.id}>
                <div>
                  <b>{campaign.title}</b>
                  <div className="m">{dateLabel(campaign.created_at, lang)} · {f(campaign.spent)} / {f(campaign.budget)}</div>
                </div>
                <span className={'tag ' + (campaign.status === 'active' ? 'ok' : campaign.status === 'pending' ? 'w' : '')}>
                  {t(`st_${campaign.status}`)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>{t('profile_finances')}</h2>
        <div className="profile-finance-grid">
          <div><span>{t('bal')}</span><b>{f(c.d.bal)}</b></div>
          <div><span>{t('profile_withdrawn')}</span><b>{f(paidTotal)}</b></div>
          <div><span>{t('profile_withdrawal_pending')}</span><b>{f(pendingTotal)}</b></div>
        </div>
      </section>

      <TransactionHistory />

      <section className="card">
        <h2>{t('profile_shortcuts')}</h2>
        <div className="profile-shortcuts">
          <button type="button" onClick={() => c.go('f')}>
            <span>{t('profile_favorites')}</span><b>{c.d.favs.length}</b>
          </button>
          <button type="button" onClick={() => c.go('a')}>
            <span>{t('myc')}</span><b>{myCampaigns.length}</b>
          </button>
          <button type="button" onClick={() => c.go('d')}>
            <span>{t('mine')}</span><b>{c.d.proofs.length}</b>
          </button>
        </div>
      </section>

      <ReferralCard c={c} />

      <section className="card">
        <h2>{t('profile_settings')}</h2>
        <label htmlFor="profile-name">{t('name')}</label>
        <input id="profile-name" maxLength={24} value={name} onChange={(event) => setName(event.target.value)} />
        <label>{t('avatar')}</label>
        <div className="av" role="radiogroup" aria-label={t('avatar')}>
          {AVATARS.map((item) => (
            <button key={item} type="button" role="radio" aria-checked={avatar === item} className={avatar === item ? 'on' : ''} onClick={() => setAvatar(avatar === item ? '' : item)}>
              {item}
            </button>
          ))}
        </div>
        <button className="p profile-save" type="button" onClick={saveProfile}>{t('save')}</button>
      </section>

      <section className="card">
        <h2>{t('profile_preferences')}</h2>
        <div className="profile-preferences">
          <div><b>{t('theme')}</b><div className="seg" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
            {(['auto', 'light', 'dark'] as const).map((value) => (
              <button key={value} type="button" className={'s' + (theme === value ? ' on' : '')} onClick={() => { setTheme(value); applyTheme(value); }}>
                {t(`th_${value}`)}
              </button>
            ))}
          </div></div>
          <div><b>{t('lang_l')}</b><LangSelect /></div>
        </div>
      </section>

      <PushToggle c={c} />
      <ProfileOptions c={c} onExport={exportData} />
      <button className="s profile-logout" type="button" onClick={logout}>
        <Icon n="x" />{t('logout_l')}
      </button>
    </>
  );
}
