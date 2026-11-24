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

type ProofTransfer = {
  proofId: number;
  stage: 'h1' | 'h23';
  state: 'validating' | 'uploading' | 'submitting' | 'queued' | 'complete' | 'error';
  error?: string;
};

export default function PublisherView({ c, view = 'dashboard' }: { c: Ctx; view?: 'dashboard' | 'wallet' }) {
  const { t, f } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [fileTarget, setFileTarget] = useState<{ proofId: number; stage: 'h1' | 'h23'; createdAt: number } | null>(null);
  const [proofTransfer, setProofTransfer] = useState<ProofTransfer | null>(null);
  const [screenCaptureAvailable, setScreenCaptureAvailable] = useState(false);
  const [screenCapturing, setScreenCapturing] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [payCountries, setPayCountries] = useState<AlphaPayCountry[]>([]);
  const [payNetworks, setPayNetworks] = useState<AlphaPayNetwork[]>([]);
  const [withdrawCountry, setWithdrawCountry] = useState(COUNTRY_CODES[c.profile.country || ''] || '');
  const [withdrawNetwork, setWithdrawNetwork] = useState('');
  const [recipientPhone, setRecipientPhone] = useState(c.profile.phone);
  const [autoWithdrawalEnabled, setAutoWithdrawalEnabled] = useState(false);
  const [autoWithdrawalAmount, setAutoWithdrawalAmount] = useState('');
  const [autoWithdrawalCountry, setAutoWithdrawalCountry] = useState(COUNTRY_CODES[c.profile.country || ''] || '');
  const [autoWithdrawalNetwork, setAutoWithdrawalNetwork] = useState('');
  const [autoWithdrawalPhone, setAutoWithdrawalPhone] = useState(c.profile.phone);
  const [autoWithdrawalLastError, setAutoWithdrawalLastError] = useState('');
  const [autoWithdrawalSaving, setAutoWithdrawalSaving] = useState(false);
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
  const autoCountryNetworks = payNetworks.filter((network) =>
    network.country === autoWithdrawalCountry && network.is_active,
  );
  const autoWithdrawalGross = Number(autoWithdrawalAmount) || 0;
  const autoWithdrawalFee = withdrawalFee(autoWithdrawalGross);
  const autoWithdrawalNet = Math.max(0, autoWithdrawalGross - autoWithdrawalFee);
  const withdrawalFeeAmount = withdrawalFee(c.d.bal);
  const payoutAmount = Math.max(0, c.d.bal - withdrawalFeeAmount);
  const proofUploadInProgress = proofTransfer !== null
    && (proofTransfer.state === 'validating' || proofTransfer.state === 'uploading' || proofTransfer.state === 'submitting');

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setScreenCaptureAvailable(typeof navigator !== 'undefined'
      && typeof navigator.mediaDevices?.getDisplayMedia === 'function');
  }, []);

  useEffect(() => {
    if (view !== 'wallet') return;
    let active = true;
    void (async () => {
      const session = await sb.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) throw new Error('Connectez-vous pour charger les réseaux de retrait');
      const [response, autoSettings] = await Promise.all([
        fetch('/api/alphapay/networks', { headers: { Authorization: `Bearer ${token}` } }),
        sb.from('withdrawal_auto_settings')
          .select('enabled,amount,operator,recipient_country,recipient_network,recipient_phone,last_error')
          .eq('user_id', c.user.id)
          .maybeSingle(),
      ]);
      const result = await response.json() as { countries?: AlphaPayCountry[]; networks?: AlphaPayNetwork[]; error?: string };
      if (!response.ok) throw new Error(result.error || 'Impossible de charger les réseaux AlphaPay');
      if (autoSettings.error) throw autoSettings.error;
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
      const saved = autoSettings.data;
      const selectedAutoCountry = saved?.recipient_country || selectedCountry;
      setAutoWithdrawalEnabled(saved?.enabled ?? false);
      setAutoWithdrawalAmount(saved ? String(saved.amount) : '');
      setAutoWithdrawalCountry(selectedAutoCountry);
      setAutoWithdrawalNetwork(saved?.recipient_network
        || networks.find((network) => network.country === selectedAutoCountry && network.is_active)?.code
        || '');
      setAutoWithdrawalPhone(saved?.recipient_phone || c.profile.phone);
      setAutoWithdrawalLastError(saved?.last_error || '');
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
      setProofTransfer({ proofId: proof.id, stage, state: 'validating' });
      try {
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
          setProofTransfer({ proofId: proof.id, stage, state: 'queued' });
          c.say(t('q_saved'));
        };
        if (!navigator.onLine) return await queue();
        const ext = (submittedFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
        const path = `${c.user.id}/${proof.id}-${stage}-${createdAt}.${ext}`;
        setProofTransfer({ proofId: proof.id, stage, state: 'uploading' });
        const up = await sb.storage.from('proofs').upload(path, submittedFile, { contentType: submittedFile.type });
        if (up.error) {
          if (isNet(up.error)) return await queue();
          if (!/exists|duplicate/i.test(up.error.message)) throw up.error;
        }
        setProofTransfer({ proofId: proof.id, stage, state: 'submitting' });
        const submitted = await sb.rpc('submit_proof_stage', {
          p_proof_id: proof.id, p_stage: stage, p_image_path: path,
        });
        if (submitted.error) { if (isNet(submitted.error)) return await queue(); throw submitted.error; }
      } catch (reason) {
        setProofTransfer({
          proofId: proof.id, stage, state: 'error',
          error: reason instanceof Error ? reason.message : String(reason),
        });
        throw reason;
      }

      setFile(null);
      setFileTarget(null);
      setProofTransfer({ proofId: proof.id, stage, state: 'complete' });
      await c.reload();
      c.say(t(stage === 'h1' ? 'proof_h1_sent' : 'proof_h23_sent'));
    });
  }
  function captureProofScreen(proofId: number, stage: 'h1' | 'h23') {
    c.run(async () => {
      const mediaDevices = navigator.mediaDevices;
      if (typeof mediaDevices?.getDisplayMedia !== 'function') throw new Error(t('proof_screen_unsupported'));
      setScreenCapturing(true);
      let stream: MediaStream | null = null;
      try {
        stream = await mediaDevices.getDisplayMedia({ video: true, audio: false });
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          await new Promise<void>((resolve, reject) => {
            video.addEventListener('loadeddata', () => resolve(), { once: true });
            video.addEventListener('error', () => reject(new Error(t('proof_capture_failed'))), { once: true });
          });
        }
        if (!video.videoWidth || !video.videoHeight) throw new Error(t('proof_capture_failed'));

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error(t('proof_capture_failed'));
        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        let image: Blob | null = null;
        for (const quality of [0.9, 0.8, 0.7, 0.6]) {
          image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
          if (!image || image.size <= 5 * 1024 * 1024) break;
        }
        if (!image) throw new Error(t('proof_capture_failed'));
        if (image.size > 5 * 1024 * 1024) throw new Error(t('proof_capture_too_large'));

        const createdAt = Date.now();
        setFile(new File([image], `proof-${stage}-${createdAt}.jpg`, { type: 'image/jpeg' }));
        setFileTarget({ proofId, stage, createdAt });
        setProofTransfer((current) => current?.proofId === proofId && current.stage === stage ? null : current);
      } catch (reason) {
        if (reason instanceof DOMException && ['AbortError', 'NotAllowedError'].includes(reason.name)) return;
        throw reason;
      } finally {
        stream?.getTracks().forEach((track) => track.stop());
        setScreenCapturing(false);
      }
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
        function saveAutoWithdrawal() {
          c.run(async () => {
            setAutoWithdrawalSaving(true);
            try {
              const selectedNetwork = autoCountryNetworks.find((network) => network.code === autoWithdrawalNetwork);
              const amount = Number(autoWithdrawalAmount);
              if (autoWithdrawalEnabled) {
                if (!Number.isSafeInteger(amount) || amount < MIN_WITHDRAW || amount > 2147483647) {
                  throw new Error(t('wd_auto_amount_invalid'));
                }
                if (!selectedNetwork) throw new Error(t('saspay_network_required'));
                if (!autoWithdrawalPhone.trim()) throw new Error(t('saspay_phone_required'));
              }

              const result = await sb.rpc('save_withdrawal_auto_settings', {
                p_enabled: autoWithdrawalEnabled,
                p_amount: amount,
                p_operator: selectedNetwork?.name ?? '',
                p_country: autoWithdrawalCountry,
                p_network: autoWithdrawalNetwork,
                p_phone: autoWithdrawalPhone.trim(),
              });
              if (result.error) throw result.error;
              setAutoWithdrawalLastError('');
              c.say(t(autoWithdrawalEnabled ? 'wd_auto_saved' : 'wd_auto_disabled'));
            } finally {
              setAutoWithdrawalSaving(false);
            }
          });
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
      <section className="hero dashboard-hero dashboard-only">
        <span className="lb">{displayName ? `Bonjour, ${displayName}` : 'Bonjour'}</span>
        <b className="big">{f(c.d.bal)}</b>
        <div className="mini">
          <span><b>{paidViews.toLocaleString()}</b> {t('views')}</span>
          <span><b>{pending}</b> {t('pend')}</span>
          <span><b>{activeCampaigns.length}</b> {t('camps')}</span>
          <span><b>{completedCount}</b> validations</span>
        </div>
        <button className="dashboard-primary" type="button" onClick={() => c.go('f')}>＋ Voir les campagnes</button>
        <button className="dashboard-primary" type="button" onClick={c.goWallet}>{t('wd')}</button>
      </section>

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
                  const state = imagePath ? 'done' : stageExpired ? 'expired' : available ? 'ready' : 'waiting';
                  const activeTransfer = proofTransfer?.proofId === p.id && proofTransfer.stage === key ? proofTransfer : null;
                  return (
                    <div className={`proof-stage is-${state}`} key={key}>
                      <div className="proof-stage-heading">
                        <span className="proof-stage-number">{key === 'h1' ? '1' : '2'}</span>
                        <div>
                          <b>{label}</b>
                          <small>{t(key === 'h1' ? 'proof_h1_period' : 'proof_h23_period')}</small>
                        </div>
                      </div>
                      {activeTransfer && <div className={`proof-upload-status is-${activeTransfer.state}`}
                        role={activeTransfer.state === 'error' ? 'alert' : 'status'}
                        aria-live={activeTransfer.state === 'error' ? 'assertive' : 'polite'}
                        aria-busy={activeTransfer.state === 'validating' || activeTransfer.state === 'uploading' || activeTransfer.state === 'submitting'}>
                        <span>{activeTransfer.state === 'error'
                          ? `${t('proof_upload_error')} ${activeTransfer.error || ''}`
                          : t(`proof_upload_${activeTransfer.state}`)}</span>
                        {(activeTransfer.state === 'validating' || activeTransfer.state === 'uploading' || activeTransfer.state === 'submitting')
                          && <i className="proof-upload-indicator" aria-hidden="true" />}
                      </div>}
                      {imagePath
                        ? <span className="tag ok">{t('proof_uploaded')}</span>
                        : stageExpired
                          ? <span className="tag bad">{t('proof_expired_stage')}</span>
                          : !available
                            ? <small className="m">{t('proof_available_in')} {remaining(availableAt)}</small>
                            : requiresFirst && !p.image_path
                              ? <small className="m">{t('proof_h1_required')}</small>
                              : <>
                                <div className="proof-capture-actions">
                                  <input id={`proof-camera-${key}-${p.id}`} className="proof-file-input" type="file" accept="image/*" capture="environment"
                                    aria-label={t('proof_take_photo')} onChange={(event) => {
                                      const selected = event.target.files?.[0] ?? null;
                                      setFile(selected);
                                      setFileTarget(selected ? { proofId: p.id, stage: key, createdAt: Date.now() } : null);
                                      setProofTransfer((current) => current?.proofId === p.id && current.stage === key ? null : current);
                                      event.target.value = '';
                                    }} />
                                  <button className="s" type="button" aria-controls={`proof-camera-${key}-${p.id}`}
                                    disabled={proofUploadInProgress}
                                    onClick={() => document.getElementById(`proof-camera-${key}-${p.id}`)?.click()}>{t('proof_take_photo')}</button>
                                  <input id={`proof-image-${key}-${p.id}`} className="proof-file-input" type="file" accept="image/*"
                                    aria-label={t('proof_choose_image')} onChange={(event) => {
                                      const selected = event.target.files?.[0] ?? null;
                                      setFile(selected);
                                      setFileTarget(selected ? { proofId: p.id, stage: key, createdAt: Date.now() } : null);
                                      setProofTransfer((current) => current?.proofId === p.id && current.stage === key ? null : current);
                                      event.target.value = '';
                                    }} />
                                  <button className="s" type="button" aria-controls={`proof-image-${key}-${p.id}`}
                                    disabled={proofUploadInProgress}
                                    onClick={() => document.getElementById(`proof-image-${key}-${p.id}`)?.click()}>{t('proof_choose_image')}</button>
                                  {screenCaptureAvailable && <button className="s" type="button" disabled={screenCapturing || proofUploadInProgress}
                                    onClick={() => captureProofScreen(p.id, key)}>
                                    {screenCapturing ? t('proof_capture_busy') : t('proof_capture_screen')}
                                  </button>}
                                </div>
                                <small className="m">{screenCaptureAvailable ? t('proof_screen_hint') : t('proof_camera_hint')}</small>
                                {file && fileTarget?.proofId === p.id && fileTarget.stage === key
                                  && <small className="m">{t('proof_file_selected')} {file.name}</small>}
                                <button className="s" type="button"
                                  disabled={!file || fileTarget?.proofId !== p.id || fileTarget?.stage !== key || proofUploadInProgress}
                                  onClick={() => sendProof(p, key)}>
                                  {activeTransfer?.state === 'error' ? t('proof_retry_send') : t('send')}
                                </button>
                              </>
                      }
                    </div>
                  );
                };
                return (
                  <div className="proof-timeline" aria-label={t('proof_timeline_title')}>
                    <div className="proof-timeline-intro">
                      <b>{t('proof_timeline_title')}</b>
                      <p>{t('proof_timeline_note')}</p>
                    </div>
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

      <section className="card wallet-only">
        <h2>{t('wd_auto_title')}</h2>
        <p className="m">{t('wd_auto_description')}</p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>
          <input type="checkbox" checked={autoWithdrawalEnabled}
            onChange={(event) => setAutoWithdrawalEnabled(event.target.checked)} />
          {t('wd_auto_enable')}
        </label>
        <label htmlFor="auto-withdrawal-amount">{t('wd_auto_amount')}</label>
        <input id="auto-withdrawal-amount" type="number" min={MIN_WITHDRAW} max="2147483647" step="1"
          inputMode="numeric" value={autoWithdrawalAmount}
          onChange={(event) => setAutoWithdrawalAmount(event.target.value)} />
        <p className="m">{t('wd_gross_label')}: <b>{f(autoWithdrawalGross)}</b> · {t('wd_fee_label')}: <b>{f(autoWithdrawalFee)}</b> · {t('wd_net_label')}: <b>{f(autoWithdrawalNet)}</b></p>
        <label htmlFor="auto-withdraw-country">{t('country')}</label>
        <select id="auto-withdraw-country" value={autoWithdrawalCountry} onChange={(event) => {
          const nextCountry = event.target.value;
          setAutoWithdrawalCountry(nextCountry);
          setAutoWithdrawalNetwork(payNetworks.find((network) => network.country === nextCountry && network.is_active)?.code || '');
        }}>
          {activeCountries.map((country) => <option key={country.iso_code} value={country.iso_code}>{country.name} · {country.default_currency}</option>)}
        </select>
        <label htmlFor="auto-withdraw-network">{t('op')}</label>
        <select id="auto-withdraw-network" value={autoWithdrawalNetwork} onChange={(event) => setAutoWithdrawalNetwork(event.target.value)}>
          {autoCountryNetworks.map((network) => <option key={network.code} value={network.code}>{network.name}</option>)}
        </select>
        <label htmlFor="auto-withdraw-phone">{t('saspay_recipient_phone')}</label>
        <input id="auto-withdraw-phone" type="tel" autoComplete="tel" value={autoWithdrawalPhone}
          onChange={(event) => setAutoWithdrawalPhone(event.target.value)} />
        {autoWithdrawalLastError && <p className="err" role="alert">{autoWithdrawalLastError}</p>}
        {!autoWithdrawalEnabled && <p className="m">{t('wd_auto_pending_note')}</p>}
        <button className="p" type="button" disabled={autoWithdrawalSaving || !!networkError}
          onClick={saveAutoWithdrawal}>
          {autoWithdrawalSaving ? '…' : t('wd_auto_save')}
        </button>
      </section>
    </div>
  );
}
