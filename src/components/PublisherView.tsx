'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { Ctx, DAILY_BONUS, DAILY_GOAL, MIN_WITHDRAW, Proof, withdrawalFee } from '@/lib/types';
import Leaderboard from './Leaderboard';
import ReferralCard from './ReferralCard';
import LevelCard from './LevelCard';
import RateForm from './RateForm';
import { isNet, queueProof } from '@/lib/offline';
import { COUNTRY_CODES, type AlphaPayCountry, type AlphaPayNetwork } from '@/lib/alphapay';
import TransactionHistory from './TransactionHistory';

export default function PublisherView({ c, view = 'dashboard' }: { c: Ctx; view?: 'dashboard' | 'wallet' }) {
  const { t, f } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [fileTarget, setFileTarget] = useState<{ proofId: number; stage: 'h1' | 'h23'; createdAt: number } | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [payCountries, setPayCountries] = useState<AlphaPayCountry[]>([]);
  const [payNetworks, setPayNetworks] = useState<AlphaPayNetwork[]>([]);
  const [withdrawCountry, setWithdrawCountry] = useState(COUNTRY_CODES[c.profile.country || ''] || '');
  const [withdrawNetwork, setWithdrawNetwork] = useState('');
  const [recipientPhone, setRecipientPhone] = useState(c.profile.phone);
  const [networkError, setNetworkError] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const sel = c.sel;
  const my = c.d.proofs;
  const approved = my.filter((p) => p.status === 'approved');
  const paidViews = approved.reduce((s, p) => s + p.views, 0);
  const pending = my.filter((p) => p.status === 'pending').length;
  const title = (id: number) => c.d.camps.find((x) => x.id === id)?.title ?? '#' + id;
  const today = new Date().toISOString().slice(0, 10);
  const todayN = my.filter((p) => p.created_at?.slice(0, 10) === today && p.status !== 'rejected').length;
  const reviewed = new Set(c.d.myReviews);
  const activeCountries = payCountries.filter((country) =>
    payNetworks.some((network) => network.country === country.iso_code && network.is_active),
  );
  const countryNetworks = payNetworks.filter((network) =>
    network.country === withdrawCountry && network.is_active,
  );
  const withdrawalFeeAmount = withdrawalFee(c.d.bal);
  const payoutAmount = Math.max(0, c.d.bal - withdrawalFeeAmount);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (view !== 'wallet') return;
    let active = true;
    void (async () => {
      const session = await sb.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) throw new Error('Connectez-vous pour charger les réseaux de retrait');
      const response = await fetch('/api/alphapay/networks', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await response.json() as { countries?: AlphaPayCountry[]; networks?: AlphaPayNetwork[]; error?: string };
      if (!response.ok) throw new Error(result.error || 'Impossible de charger les réseaux AlphaPay');
      if (!active) return;
      const countries = result.countries ?? [];
      const networks = result.networks ?? [];
      setPayCountries(countries);
      setPayNetworks(networks);
      const preferred = COUNTRY_CODES[c.profile.country || ''] || '';
      const firstCountry = countries.find((country) =>
        networks.some((network) => network.country === country.iso_code && network.is_active),
      )?.iso_code || '';
      const selectedCountry = countries.some((country) => country.iso_code === preferred) ? preferred : firstCountry;
      setWithdrawCountry(selectedCountry);
      setWithdrawNetwork(networks.find((network) => network.country === selectedCountry && network.is_active)?.code || '');
    })().catch((reason: unknown) => {
      if (active) setNetworkError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [c.profile.country, view]);

  function startProof() {
    c.run(async () => {
      if (sel === null) throw new Error(t('proof_campaign_missing'));
      const result = await sb.rpc('start_proof', { p_campaign_id: sel });
      if (result.error) throw result.error;
      c.pick(null); setFile(null); setFileTarget(null);
      await c.reload();
      c.say(t('proof_started'));
    });
  }
  function sendProof(proof: Proof, stage: 'h1' | 'h23') {
    c.run(async () => {
      if (!file || !fileTarget || fileTarget.proofId !== proof.id || fileTarget.stage !== stage
        || !file.type.startsWith('image/') || file.size > 5 * 1048576) throw new Error(t('nofile'));
      const submittedFile = file;
      const createdAt = fileTarget.createdAt;
      const queue = async () => {
        await queueProof({
          userId: c.user.id, campaignId: proof.campaign_id, proofId: proof.id, stage,
          name: submittedFile.name, type: submittedFile.type, blob: submittedFile, createdAt,
        });
        setFile(null);
        setFileTarget(null);
        c.say(t('q_saved'));
      };
      if (!navigator.onLine) return queue();
      const ext = (submittedFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${c.user.id}/${proof.id}-${stage}-${createdAt}.${ext}`;
      const up = await sb.storage.from('proofs').upload(path, submittedFile, { contentType: submittedFile.type });
      if (up.error) {
        if (isNet(up.error)) return queue();
        if (!/exists|duplicate/i.test(up.error.message)) throw up.error;
      }
      const submitted = await sb.rpc('submit_proof_stage', {
        p_proof_id: proof.id, p_stage: stage, p_image_path: path,
      });
      if (submitted.error) { if (isNet(submitted.error)) return queue(); throw submitted.error; }
      setFile(null);
      setFileTarget(null);
      await c.reload();
      c.say(t(stage === 'h1' ? 'proof_h1_sent' : 'proof_h23_sent'));
    });
  }
  function withdraw() {
    c.run(async () => {
      setWithdrawing(true);
      try {
        const selectedNetwork = countryNetworks.find((network) => network.code === withdrawNetwork);
        if (!selectedNetwork) throw new Error(t('saspay_network_required'));
        if (!recipientPhone.trim()) throw new Error(t('saspay_phone_required'));
        const token = (await sb.auth.getSession()).data.session?.access_token;
        if (!token) throw new Error(t('auth_login_hint'));
        let response: Response;
        try {
          response = await fetch('/api/alphapay/payout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              amount: c.d.bal,
              country: withdrawCountry,
              network: selectedNetwork.code,
              operator: selectedNetwork.name,
              phone: recipientPhone.trim(),
            }),
          });
        } catch (reason) {
          await c.reload();
          throw new Error(`${t('wd_check_status')} ${reason instanceof Error ? reason.message : String(reason)}`);
        }
        const result = await response.json() as { status?: string; error?: string };
        if (!response.ok) throw new Error(result.error || 'Impossible de traiter le retrait AlphaPay');
        await c.reload();
        if (result.status === 'pending' && result.error) {
          c.say(`${t('wd_saved_pending')} ${result.error}`);
          return;
        }
        c.say(t(result.status === 'paid' ? 'saspay_payout_paid'
          : result.status === 'failed' ? 'saspay_payout_failed' : 'saspay_payout_pending'));
      } finally {
        setWithdrawing(false);
      }
    });
  }
  function rate(proofId: number, stars: number, comment: string) {
    c.run(async () => {
      const r = await sb.rpc('submit_review', { p_proof: proofId, p_stars: stars, p_comment: comment });
      if (r.error) throw r.error;
      setRating(null);
      await c.reload();
      c.say(t('rated'));
    });
  }

  const displayName = c.profile.display_name?.trim() || c.profile.phone.replace(/^\+/, '');
  const activeCampaigns = c.d.camps.filter((campaign) => campaign.status === 'active');
  const recommendedCampaigns = activeCampaigns.filter((campaign) => campaign.spent < campaign.budget).slice(0, 3);
  const completedCount = c.d.proofs.filter((proof) => proof.status === 'approved').length;
  const recentProofs = [...my].sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? '')).slice(0, 3);
  const chartValues = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    const day = date.toISOString().slice(0, 10);
    return my
      .filter((proof) => proof.status === 'approved' && proof.created_at?.slice(0, 10) === day)
      .reduce((sum, proof) => sum + (proof.base_reward ?? proof.views) + proof.bonus, 0);
  });
  const chartMax = Math.max(1, ...chartValues);
  const chartPoints = chartValues.map((value, index) => {
    const x = 18 + index * 94;
    const y = 128 - (value / chartMax) * 100;
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className={`publisher-view publisher-view-${view}`}>
      {view === 'wallet' && (
        <>
          <div className="page-head">
            <div><div className="eyebrow">{t('wallet_title')}</div><h1>{t('wd')}</h1><p className="sub">{t('tx_description')}</p></div>
            <a className="p" href="#withdrawal-form">{t('wdb')} ↗</a>
          </div>
          <div className="wallet-hero">
            <div><small>{t('bal')}</small><h2>{f(c.d.bal)}</h2><small>{t('profile_total_earned')}: {f(c.d.bal + approved.reduce((sum, proof) => sum + proof.bonus, 0))}</small></div>
            <span className="wallet-hero-icon"><b>F</b></span>
          </div>
          <div className="quick-actions">
            <button className="quick" type="button" onClick={() => document.getElementById('withdrawal-form')?.scrollIntoView({ behavior: 'smooth' })}><span>↗</span>{t('wd')}</button>
            <button className="quick" type="button" onClick={() => document.getElementById('transaction-history')?.scrollIntoView({ behavior: 'smooth' })}><span>▤</span>{t('tx_history')}</button>
          </div>
          <div id="transaction-history"><TransactionHistory /></div>
        </>
      )}
      <div className="dashboard-head dashboard-only">
        <div>
          <span className="dashboard-eyebrow">{t('r_d')}</span>
          <h1>{displayName ? `Bonjour, ${displayName} 👋` : 'Bonjour 👋'}</h1>
          <p className="m">Voici les performances de votre activité aujourd’hui.</p>
        </div>
        <button className="dashboard-primary" type="button" onClick={() => c.go('f')}>＋ Voir les campagnes</button>
      </div>

      <div className="dashboard-kpis dashboard-only">
        <article className="dashboard-kpi">
          <span className="dashboard-kpi-icon">F</span>
          <span>{t('bal')}</span>
          <b>{f(c.d.bal)}</b>
          <small>Solde disponible</small>
        </article>
        <article className="dashboard-kpi">
          <span className="dashboard-kpi-icon">◉</span>
          <span>{t('views')}</span>
          <b>{paidViews.toLocaleString()}</b>
          <small>{pending} {t('pend')}</small>
        </article>
        <article className="dashboard-kpi">
          <span className="dashboard-kpi-icon">▣</span>
          <span>{t('camps')}</span>
          <b>{activeCampaigns.length}</b>
          <small>{completedCount} validations</small>
        </article>
        <article className="dashboard-kpi">
          <span className="dashboard-kpi-icon">★</span>
          <span>Votre progression</span>
          <b>{Math.min(100, Math.round((approved.length / 20) * 100))}%</b>
          <small>Niveau de confiance</small>
        </article>
      </div>

      <div className="dashboard-columns dashboard-only">
        <section className="card dashboard-chart">
          <div className="dashboard-card-title"><h2>Évolution de vos gains</h2><span className="m">7 derniers jours</span></div>
          <svg viewBox="0 0 580 150" role="img" aria-label="Évolution des gains sur 7 jours">
            {[30, 65, 100, 135].map((y) => <line key={y} x1="0" x2="580" y1={y} y2={y} stroke="var(--line)" strokeWidth="1" />)}
            {chartValues.length > 1 && (
              <>
                <polygon points={`18,140 ${chartPoints} 582,140`} fill="var(--brand)" opacity=".10" />
                <polyline points={chartPoints} fill="none" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
              </>
            )}
          </svg>
        </section>
        <section className="card dashboard-activity">
          <div className="dashboard-card-title"><h2>Activité récente</h2><button className="linkbtn" type="button" onClick={() => c.go('d')}>Tout voir</button></div>
          {recentProofs.length === 0 && <p className="m">Aucune activité pour le moment.</p>}
          {recentProofs.map((proof) => (
            <div className="dashboard-activity-row" key={proof.id}>
              <span className="dashboard-activity-icon">{proof.status === 'approved' ? '✓' : proof.status === 'rejected' ? '×' : '◷'}</span>
              <div><b>{title(proof.campaign_id)}</b><small>{proof.status === 'approved' ? 'Preuve validée' : proof.status === 'rejected' ? 'Preuve refusée' : 'Preuve en attente'}</small></div>
              <span className={'tag ' + (proof.status === 'approved' ? 'ok' : proof.status === 'rejected' ? 'bad' : 'w')}>
                {proof.status === 'approved' ? `+${(proof.base_reward ?? proof.views) + proof.bonus} F` : proof.status}
              </span>
            </div>
          ))}
        </section>
      </div>

      <section className="card dashboard-only dashboard-recommendations">
        <div className="dashboard-card-title"><h2>{t('camps')}</h2><button className="s" type="button" onClick={() => c.go('f')}>{t('r_f')}</button></div>
        {recommendedCampaigns.length === 0 && <p className="m">{t('none')}</p>}
        <div className="campaign-list">
          {recommendedCampaigns.map((campaign) => (
            <div className="campaign-item" key={campaign.id}>
              <div className="product-thumb"><b>{campaign.type === 'img' ? '▧' : campaign.type === 'vid' ? '▷' : '≡'}</b></div>
              <div>
                <strong>{campaign.title}</strong>
                <div className="m">{t(campaign.type)} · {f(Math.max(0, campaign.budget - campaign.spent))} {t('rest')}</div>
                <div className="progress"><span style={{ width: `${Math.min(100, Math.round((campaign.spent / campaign.budget) * 100))}%` }} /></div>
              </div>
              <button className="s on" type="button" onClick={() => c.go('f')}>{t('post')}</button>
            </div>
          ))}
        </div>
      </section>

      <section className="card dashboard-only">
        <h2>{t('daily_t')} · {Math.min(todayN, DAILY_GOAL)}/{DAILY_GOAL}</h2>
        <div className="bar" style={{ marginTop: 0 }}><i style={{ width: Math.min(100, Math.round((todayN / DAILY_GOAL) * 100)) + '%' }} /></div>
        <p className="m" style={{ margin: '8px 0 0' }}>{todayN >= DAILY_GOAL ? t('daily_done') : t('daily_b')} (+{f(DAILY_BONUS)})</p>
      </section>

      <div className="dashboard-only"><LevelCard dep={approved.length} /></div>

      {sel !== null && (
        <section className="card dashboard-only">
          <h2>{t('proof')} · {title(sel)}</h2>
          <p className="m">{t('proof_start_hint')}</p>
          <button className="p" onClick={startProof}>{t('proof_start_button')}</button>
          <button className="s" style={{ marginTop: 10 }} onClick={() => c.pick(null)}>{t('ib_no')}</button>
        </section>
      )}

      <section className="card dashboard-only">
        <h2>{t('mine')}</h2>
        {my.length === 0 && <p className="m">{t('none')}</p>}
        {my.map((p, i) => (
          <div className={'row' + (i === 0 ? ' first' : '')} key={p.id}>
            <div className="proof-submission">
              <b>{title(p.campaign_id)}</b>
              {p.posted_at && <small className="m">{t('proof_posted_at')} · {new Date(p.posted_at).toLocaleString()}</small>}
              {p.posted_at && p.status === 'pending' ? (() => {
                const postedAt = Date.parse(p.posted_at || '');
                const h1At = postedAt + 60 * 60 * 1000;
                const h23At = postedAt + 23 * 60 * 60 * 1000;
                const expiresAt = postedAt + 24 * 60 * 60 * 1000;
                const remaining = (target: number) => {
                  const minutes = Math.max(0, Math.ceil((target - clock) / 60_000));
                  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
                };
                const stage = (key: 'h1' | 'h23', label: string, imagePath: string | null, availableAt: number, deadline: number, requiresFirst: boolean) => {
                  const elapsed = clock >= deadline;
                  const available = clock >= availableAt && !elapsed;
                  const stageExpired = elapsed || (requiresFirst && !p.image_path && clock >= h23At);
                  return (
                    <div className="proof-stage" key={key}>
                      <b>{label}</b>
                      {imagePath
                        ? <span className="tag ok">{t('proof_uploaded')}</span>
                        : stageExpired
                          ? <span className="tag bad">{t('proof_expired_stage')}</span>
                          : !available
                            ? <small className="m">{t('proof_available_in')} {remaining(availableAt)}</small>
                            : requiresFirst && !p.image_path
                              ? <small className="m">{t('proof_h1_required')}</small>
                              : <>
                                <label htmlFor={`proof-${key}-${p.id}`}>{t('file')}</label>
                                <input id={`proof-${key}-${p.id}`} type="file" accept="image/*" onChange={(event) => {
                                  setFile(event.target.files?.[0] ?? null);
                                  setFileTarget({ proofId: p.id, stage: key, createdAt: Date.now() });
                                }} />
                                <button className="s" type="button"
                                  disabled={!file || fileTarget?.proofId !== p.id || fileTarget?.stage !== key}
                                  onClick={() => sendProof(p, key)}>{t('send')}</button>
                              </>
                      }
                    </div>
                  );
                };
                return (
                  <div className="proof-timeline">
                    {stage('h1', t('proof_h1_title'), p.image_path, h1At, h23At, false)}
                    {stage('h23', t('proof_h23_title'), p.final_image_path ?? null, h23At, expiresAt, true)}
                    {p.final_image_path && <small className="m">{t('proof_waiting_review')}</small>}
                  </div>
                );
              })() : (
                <div className="actions">
                  {p.status === 'approved' && !reviewed.has(p.id) && (
                    <button className="s" onClick={() => setRating(rating === p.id ? null : p.id)}>★ {t('rate_adv')}</button>
                  )}
                  <span className={'tag ' + (p.status === 'approved' ? 'ok' : p.status === 'rejected' ? 'bad' : 'w')}>
                    {p.status === 'approved' ? `${t('ap')} · ${(p.base_reward ?? p.views) + p.bonus} F`
                      : p.rejection_reason === 'deadline' ? t('proof_deadline_missed')
                        : p.status === 'rejected' ? t('rj') : t('pd')}
                  </span>
                </div>
              )}
            </div>
            {rating === p.id && <RateForm title={`${t('rate_adv')} · ${title(p.campaign_id)}`} onSubmit={(s, cm) => rate(p.id, s, cm)} onCancel={() => setRating(null)} />}
          </div>
        ))}
      </section>

      <div className="dashboard-only"><ReferralCard c={c} /></div>
      <div className="dashboard-only"><Leaderboard /></div>

      <section className="card wallet-only" id="withdrawal-form">
        <h2>{t('wd')}</h2>
        {networkError && <p className="err" role="alert">{networkError}</p>}
        <label htmlFor="withdraw-country">{t('country')}</label>
        <select id="withdraw-country" value={withdrawCountry} onChange={(e) => {
          const nextCountry = e.target.value;
          setWithdrawCountry(nextCountry);
          setWithdrawNetwork(payNetworks.find((network) => network.country === nextCountry && network.is_active)?.code || '');
        }}>
          {activeCountries.map((country) => <option key={country.iso_code} value={country.iso_code}>{country.name} · {country.default_currency}</option>)}
        </select>
        <label htmlFor="withdraw-network">{t('op')}</label>
        <select id="withdraw-network" value={withdrawNetwork} onChange={(e) => setWithdrawNetwork(e.target.value)}>
          {countryNetworks.map((network) => <option key={network.code} value={network.code}>{network.name}</option>)}
        </select>
        <label htmlFor="withdraw-phone">{t('saspay_recipient_phone')}</label>
        <input id="withdraw-phone" type="tel" autoComplete="tel" value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} />
        <p className="m">{t('wdmin')}</p>
        <p className="m">{t('wd_fee_schedule')}</p>
        <p className="m">
          {t('wd_gross_label')}: <b>{f(c.d.bal)}</b> · {t('wd_fee_label')}: <b>{f(withdrawalFeeAmount)}</b> · {t('wd_net_label')}: <b>{f(payoutAmount)}</b>
        </p>
        <p className="m">{t('wd_proof_only')}</p>
        <button className="p" disabled={withdrawing || c.d.bal < MIN_WITHDRAW || !withdrawNetwork || !!networkError} onClick={withdraw}>{withdrawing ? '…' : `${t('wdb')} ${f(payoutAmount)}`}</button>
        <p className="m">{t('saspay_payout_auto_note')}</p>
      </section>
    </div>
  );
}
