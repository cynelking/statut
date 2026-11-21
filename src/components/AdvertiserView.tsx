'use client';
import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { ADMIN, BOOST_FEE, COUNTRIES, CType, Ctx, FEE } from '@/lib/types';
import ReportPanel from './ReportPanel';
import RateForm from './RateForm';

interface ToRate { proof_id: number; campaign_id: number; label: string; views: number; reviewed: boolean }

const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_VIDEO_SIZE = 20 * 1024 * 1024;
const imageLoader = ({ src }: { src: string }) => src;

function isHttpsUrl(value: string) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

export default function AdvertiserView({ c, view = 'overview', onNavigate }: {
  c: Ctx;
  view?: 'overview' | 'campaigns' | 'create';
  onNavigate?: (page: 'campaigns' | 'create') => void;
}) {
  const { t, f } = useI18n();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<CType>('img');
  const [budget, setBudget] = useState('');
  const [content, setContent] = useState('');
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaLink, setMediaLink] = useState('');
  const [mediaInputKey, setMediaInputKey] = useState(0);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [boost, setBoost] = useState(false);
  const [useCredit, setUseCredit] = useState(true);
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [promo, setPromo] = useState('');
  const [report, setReport] = useState<number | null>(null);
  const [toRate, setToRate] = useState<ToRate[]>([]);
  const [rating, setRating] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [payingCampaign, setPayingCampaign] = useState<number | null>(null);
  const [topupAmount, setTopupAmount] = useState('');
  const [topupBusy, setTopupBusy] = useState(false);
  const isAdmin = c.profile.role === 'admin';

  useEffect(() => {
    if (!mediaFile) { setFilePreview(null); return; }
    const url = URL.createObjectURL(mediaFile);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [mediaFile]);

  const b = Math.max(0, Number(budget) || 0);
  const total = isAdmin ? 0 : b + FEE + (boost ? BOOST_FEE : 0);
  const credit = c.profile.credit;
  const used = !isAdmin && useCredit ? Math.min(credit, total) : 0;
  const walletUsed = !isAdmin && c.d.walletBalance >= total - used ? total - used : 0;
  const due = total - used - walletUsed;
  const mine = c.d.camps.filter((x) => x.owner === c.user.id);
  const activeCampaigns = mine.filter((campaign) => campaign.status === 'active');
  const totalBudget = mine.reduce((sum, campaign) => sum + campaign.budget, 0);
  const totalSpent = mine.reduce((sum, campaign) => sum + campaign.spent, 0);
  const remainingBudget = mine.reduce((sum, campaign) => sum + Math.max(0, campaign.budget - campaign.spent), 0);
  const titleOf = (id: number) => c.d.camps.find((x) => x.id === id)?.title ?? '#' + id;

  async function createAlphaPayCheckout(campaignId: number) {
    setPayingCampaign(campaignId);
    try {
      const session = await sb.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) throw new Error(t('auth_login_hint'));
      const response = await fetch('/api/alphapay/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ campaignId }),
      });
      const result = await response.json() as { checkoutUrl?: string; status?: string; error?: string };
      if (!response.ok) throw new Error(result.error || 'Impossible de créer le paiement AlphaPay');
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      if (result.status === 'paid') {
        await c.reload();
        c.say(t('saspay_return_paid'));
        return;
      }
      if (result.status === 'review') {
        c.say(t('saspay_return_review'));
        return;
      }
      if (result.status === 'failed') {
        c.say(t('saspay_return_failed'));
        return;
      }
      throw new Error('La session de paiement AlphaPay est indisponible');
    } finally {
      setPayingCampaign(null);
    }
  }

  function topup() {
    c.run(async () => {
      const amount = Number(topupAmount);
      if (!Number.isSafeInteger(amount) || amount < 500 || amount > 1000000) {
        throw new Error(t('saspay_topup_limits'));
      }
      setTopupBusy(true);
      try {
        const token = (await sb.auth.getSession()).data.session?.access_token;
        if (!token) throw new Error(t('auth_login_hint'));
        const response = await fetch('/api/alphapay/wallet-topup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ amount }),
        });
        const result = await response.json() as { checkoutUrl?: string; status?: string; error?: string };
        if (!response.ok) throw new Error(result.error || 'Impossible de créer la recharge AlphaPay');
        if (result.checkoutUrl) {
          window.location.assign(result.checkoutUrl);
          return;
        }
        await c.reload();
        c.say(t(result.status === 'succeeded' ? 'saspay_topup_paid'
          : result.status === 'review' ? 'saspay_topup_review'
            : result.status === 'failed' ? 'saspay_topup_failed' : 'saspay_topup_pending'));
      } finally {
        setTopupBusy(false);
      }
    });
  }

  function chooseMedia(file: File | null) {
    if (!file) return;
    const extension = MEDIA_EXTENSIONS[file.type];
    if (!extension || (type === 'img' && !file.type.startsWith('image/')) || (type === 'vid' && !file.type.startsWith('video/'))) {
      setMediaFile(null);
      setMediaInputKey((key) => key + 1);
      c.say(t('media_file_bad'));
      return;
    }
    if (file.size > (type === 'img' ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE)) {
      setMediaFile(null);
      setMediaInputKey((key) => key + 1);
      c.say(t('media_size_bad'));
      return;
    }
    setMediaFile(file);
    setMediaLink('');
  }

  const loadRate = useCallback(async () => {
    const r = await sb.rpc('adv_proofs');
    setToRate(((r.data ?? []) as ToRate[]).filter((x) => !x.reviewed).slice(0, 10));
  }, []);
  useEffect(() => { loadRate(); }, [loadRate]);

  function launch() {
    c.run(async () => {
      setCreating(true);
      try {
        if (b < 1000 || !title.trim()) throw new Error(t('bmin'));
        if (starts && ends && ends < starts) throw new Error(t('sched_bad'));
        let mediaUrl: string | null = null;
        let mediaPath: string | null = null;
        if (type !== 'txt') {
          if (mediaFile) {
            const extension = MEDIA_EXTENSIONS[mediaFile.type];
            const maxSize = type === 'img' ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE;
            if (!extension || (type === 'img' && !mediaFile.type.startsWith('image/')) || (type === 'vid' && !mediaFile.type.startsWith('video/'))) {
              throw new Error(t('media_file_bad'));
            }
            if (mediaFile.size > maxSize) throw new Error(t('media_size_bad'));
            mediaPath = `${c.user.id}/${crypto.randomUUID()}.${extension}`;
            const uploaded = await sb.storage.from('campaign-media').upload(mediaPath, mediaFile, {
              contentType: mediaFile.type,
              cacheControl: '31536000',
              upsert: false,
            });
            if (uploaded.error) throw uploaded.error;
            mediaUrl = sb.storage.from('campaign-media').getPublicUrl(mediaPath).data.publicUrl;
          } else {
            mediaUrl = mediaLink.trim();
            if (!isHttpsUrl(mediaUrl)) throw new Error(t(mediaUrl ? 'media_url_bad' : 'media_required'));
          }
        }
        const r = await sb.rpc('create_campaign', {
          p_title: title.trim(), p_type: type, p_content: content.trim(), p_media_url: mediaUrl,
          p_budget: b, p_country: target, p_boost: boost, p_use_credit: !isAdmin && useCredit,
          p_starts: starts || null, p_ends: ends || null,
        });
        if (r.error) {
          if (mediaPath) {
            const removed = await sb.storage.from('campaign-media').remove([mediaPath]);
            if (removed.error) throw new Error(`${r.error.message}. ${removed.error.message}`);
          }
          throw r.error;
        }
        const campaignId = Number(r.data);
        if (!Number.isSafeInteger(campaignId) || campaignId < 1) throw new Error('La campagne a été créée sans identifiant valide');
        setTitle(''); setBudget(''); setContent(''); setMediaFile(null); setMediaLink(''); setMediaInputKey((key) => key + 1); setBoost(false); setStarts(''); setEnds('');
        await c.reload();
        if (due > 0) await createAlphaPayCheckout(campaignId);
        else c.say(t(isAdmin ? 'admin_campaign_created' : 'created'));
      } finally {
        setCreating(false);
      }
    });
  }
  function redeem() {
    c.run(async () => {
      const r = await sb.rpc('redeem_promo', { p_code: promo });
      if (r.error) throw r.error;
      setPromo('');
      await c.reload();
      c.say(`${t('promo_ok')} ${f(r.data as number)}`);
    });
  }
  function rate(id: number, stars: number, comment: string) {
    c.run(async () => {
      const r = await sb.rpc('submit_review', { p_proof: id, p_stars: stars, p_comment: comment });
      if (r.error) throw r.error;
      setRating(null);
      await loadRate();
      c.say(t('rated'));
    });
  }

  return (
    <div className={`advertiser-view advertiser-view-${view}`}>
      {view !== 'create' && (
        <div className="page-head">
          <div>
            <div className="eyebrow">{view === 'campaigns' ? t('r_a') : t('r_a')}</div>
            <h1>{view === 'campaigns' ? t('myc') : t('advertiser_center')}</h1>
            <p className="sub">{view === 'campaigns' ? t('profile_created_campaigns') : t('wallet_description')}</p>
          </div>
          <button className="p" type="button" onClick={() => onNavigate?.('create')}>{t('new')} ＋</button>
        </div>
      )}
      {view === 'overview' && (
        <section className="advertiser-overview">
          <div className="dashboard-kpis">
            <article className="dashboard-kpi"><span className="dashboard-kpi-icon">F</span><span>{t('wallet_title')}</span><b>{f(c.d.walletBalance)}</b><small>{t('wallet_description')}</small></article>
            <article className="dashboard-kpi"><span className="dashboard-kpi-icon">▣</span><span>{t('k_camps')}</span><b>{activeCampaigns.length}</b><small>{t('st_active')}</small></article>
            <article className="dashboard-kpi"><span className="dashboard-kpi-icon">◉</span><span>{t('spent')}</span><b>{f(totalSpent)}</b><small>{t('advertiser_spent_hint')}</small></article>
            <article className="dashboard-kpi"><span className="dashboard-kpi-icon">◷</span><span>{t('rest')}</span><b>{f(remainingBudget)}</b><small>{f(totalBudget)}</small></article>
          </div>
          <section className="card">
            <div className="dashboard-card-title"><h2>{t('myc')}</h2><button className="s" type="button" onClick={() => onNavigate?.('campaigns')}>{t('myc')}</button></div>
            {mine.length === 0 && <p className="m">{t('none')}</p>}
            <div className="campaign-list">
              {mine.slice(0, 3).map((campaign) => (
                <div className="campaign-item" key={campaign.id}>
                  <div className="product-thumb">{campaign.type === 'img' ? '▧' : campaign.type === 'vid' ? '▷' : '≡'}</div>
                  <div><strong>{campaign.title}</strong><div className="m">{t(campaign.type)} · {campaign.country ?? t('all_c')}</div><div className="progress"><span style={{ width: `${Math.min(100, Math.round((campaign.spent / campaign.budget) * 100))}%` }} /></div></div>
                  <span className={'tag ' + (campaign.status === 'active' ? 'ok' : campaign.status === 'pending' ? 'w' : '')}>{t(`st_${campaign.status}`)}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="card advertiser-financing">
            <div className="dashboard-card-title"><h2>{t('wallet_title')}</h2><span className="tag ok">AlphaPay</span></div>
            <p className="m">{t('wallet_description')}</p>
            <button className="s on" type="button" onClick={() => document.getElementById('advertiser-wallet-topup')?.scrollIntoView({ behavior: 'smooth' })}>{t('wallet_topup_button')}</button>
          </section>
        </section>
      )}
      {view === 'create' && (
        <div className="page-head advertiser-create-only">
          <div><div className="eyebrow">{t('r_a')}</div><h1>{t('new')}</h1><p className="sub">{t('configure_campaign')}</p></div>
        </div>
      )}
      <section className="card advertiser-create-only">
        <h2>{t('credit')} · {f(credit)}</h2>
        <label htmlFor="pr">{t('promo_code')}</label>
        <div className="actions" style={{ flexWrap: 'nowrap' }}>
          <input id="pr" style={{ width: '100%' }} value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} maxLength={20} />
          <button className="s on" onClick={redeem} disabled={!promo.trim()}>{t('promo_apply')}</button>
        </div>
      </section>

      <form id="advertiser-wallet-topup" className="card advertiser-topup-only" onSubmit={(e) => { e.preventDefault(); topup(); }}>
        <h2>{t('wallet_title')} · {f(c.d.walletBalance)}</h2>
        <p className="m">{t('wallet_description')}</p>
        <label htmlFor="wallet-topup-amount">{t('wallet_topup_amount')}</label>
        <input id="wallet-topup-amount" inputMode="numeric" value={topupAmount}
          onChange={(e) => setTopupAmount(e.target.value.replace(/\D/g, ''))} />
        <p className="m">{t('saspay_topup_limits')}</p>
        <button className="p" type="submit" disabled={topupBusy || !topupAmount}>
          {topupBusy ? '…' : t('wallet_topup_button')}
        </button>
      </form>

      <form className="card advertiser-create-only" onSubmit={(e) => { e.preventDefault(); launch(); }}>
        <div className="steps" aria-label="Étapes de création">
          <div className="step active"><b>1</b>{t('title')}</div><div className="step-line" />
          <div className="step"><b>2</b>{t('target')}</div><div className="step-line" />
          <div className="step"><b>3</b>{t('budget')}</div>
        </div>
        <label htmlFor="ti">{t('title')}</label>
        <input id="ti" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="grid2">
          <div>
            <label htmlFor="ty">{t('type')}</label>
            <select id="ty" value={type} onChange={(e) => { setType(e.target.value as CType); setMediaFile(null); setMediaLink(''); setMediaInputKey((key) => key + 1); }}>
              <option value="img">{t('img')}</option><option value="vid">{t('vid')}</option><option value="txt">{t('txt')}</option>
            </select>
          </div>
          <div>
            <label htmlFor="bu">{t('budget')}</label>
            <input id="bu" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, ''))} />
          </div>
        </div>
        <label htmlFor="cc">{t('target')}</label>
        <select id="cc" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">{t('all_c')}</option>
          {COUNTRIES.map((k) => <option key={k}>{k}</option>)}
        </select>
        <div className="grid2">
          <div><label htmlFor="sd">{t('starts')}</label><input id="sd" type="date" min={new Date().toISOString().slice(0, 10)} value={starts} onChange={(e) => setStarts(e.target.value)} /></div>
          <div><label htmlFor="ed">{t('ends')}</label><input id="ed" type="date" min={starts || new Date().toISOString().slice(0, 10)} value={ends} onChange={(e) => setEnds(e.target.value)} /></div>
        </div>
        {type !== 'txt' && (
          <>
            <label htmlFor="media-file">{t('media_upload')} · {t(type)}</label>
            <input key={mediaInputKey} id="media-file" type="file" accept={type === 'img' ? 'image/jpeg,image/png,image/webp,image/gif' : 'video/mp4,video/webm,video/quicktime'}
              onChange={(e) => chooseMedia(e.target.files?.[0] ?? null)} />
            <p className="m">{t(type === 'img' ? 'media_image_hint' : 'media_video_hint')}</p>
            <label htmlFor="media-link">{t('media_url')}</label>
            <input id="media-link" inputMode="url" value={mediaLink} placeholder="https://…" onChange={(e) => {
              setMediaLink(e.target.value);
              if (mediaFile) { setMediaFile(null); setMediaInputKey((key) => key + 1); }
            }} />
            {(filePreview || (isHttpsUrl(mediaLink) ? mediaLink : null)) && (
              <div className="media-preview">
                {type === 'img'
                  ? <Image loader={imageLoader} src={filePreview || mediaLink} alt="" width={800} height={450} unoptimized />
                  : <video src={filePreview || mediaLink} controls playsInline preload="metadata" />}
              </div>
            )}
          </>
        )}
        <label htmlFor="tx">{type === 'txt' ? t('content') : t('media_caption')}</label>
        <textarea id="tx" rows={3} maxLength={500} value={content} onChange={(e) => setContent(e.target.value)} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>
          <input type="checkbox" checked={boost} onChange={(e) => setBoost(e.target.checked)} /> {t('boost')}{!isAdmin && <> (+{f(BOOST_FEE)})</>}
        </label>
        {!isAdmin && credit > 0 && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>
            <input type="checkbox" checked={useCredit} onChange={(e) => setUseCredit(e.target.checked)} /> {t('use_credit')} ({f(credit)})
          </label>
        )}
        {!isAdmin && c.d.walletBalance > 0 && <p className="m">{t('wallet_campaign_note')}</p>}
        <p className="note" style={{ marginTop: 14 }}>
          {isAdmin ? <>{t('admin_campaign_free')}<br />{t('maxv')} : <b>{b.toLocaleString()}</b></>
            : <>{t('fee')} : <b>{f(FEE)}</b>{boost && <> · {t('boost_fee')} : <b>{f(BOOST_FEE)}</b></>} · {t('maxv')} : <b>{b.toLocaleString()}</b><br />
              {t('tot')} : <b>{f(total)}</b>{used > 0 && <> − {t('credit')} <b>{f(used)}</b></>}{walletUsed > 0 && <> − {t('wallet_title')} <b>{f(walletUsed)}</b></>}<br />
              {t('to_pay')} : <b>{f(due)}</b>{ends && <><br /><span className="m">{t('refund_note')}</span></>}</>}
        </p>
        <button className="p" type="submit" disabled={creating}>{t('launch')}</button>
      </form>

      {toRate.length > 0 && (
        <section className="card advertiser-overview-only">
          <h2>{t('rate_list')}</h2>
          {toRate.map((x, i) => (
            <div className={'row' + (i === 0 ? ' first' : '')} key={x.proof_id}>
              <div><b>{x.label}</b><div className="m">{titleOf(x.campaign_id)} · {x.views} {t('views')}</div></div>
              <button className="s" onClick={() => setRating(rating === x.proof_id ? null : x.proof_id)}>{t('rate_pub')}</button>
              {rating === x.proof_id && <RateForm title={`${t('rate_pub')} · ${x.label}`} onSubmit={(s, cm) => rate(x.proof_id, s, cm)} onCancel={() => setRating(null)} />}
            </div>
          ))}
        </section>
      )}

      <section className="card advertiser-campaign-list">
        <h2>{t('myc')}</h2>
        {mine.length === 0 && <p className="m">{t('none')}</p>}
        {mine.map((x, i) => {
          const owed = x.admin_created ? 0 : x.budget + FEE + (x.boost_hours > 0 ? BOOST_FEE : 0) - x.credit_used - (x.wallet_used || 0);
          return (
            <div className={'row' + (i === 0 ? ' first' : '')} style={{ display: 'block' }} key={x.id}>
              <b>{x.title}</b>{' '}
              <span className={'tag ' + (x.status === 'active' ? 'ok' : x.status === 'pending' ? 'w' : '')}>{t('st_' + x.status)}</span>{' '}
              {x.boost_hours > 0 && <span className="tag boost">{t('sponsored')}</span>}
              <div className="m">{f(x.spent)} / {f(x.budget)} {t('spent')} · {x.country ?? t('all_c')}{x.starts_at ? ' · ' + t('starts_on') + ' ' + x.starts_at.slice(0, 10) : ''}{x.ends_at ? ' · ' + t('ends_in') + ' ' + new Date(Date.parse(x.ends_at) - 1).toISOString().slice(0, 10) : ''}</div>
              {x.status === 'pending' && x.payment_provider !== 'alphapay' ? (
                <p className="note" style={{ marginTop: 8 }}>{t('payinfo')} <b>{ADMIN}</b> : <b>{f(owed)}</b> {t('payinfo2')}</p>
              ) : x.status === 'pending' && x.payment_status === 'review' ? (
                <p className="note" role="status">{t('saspay_return_review')}</p>
              ) : x.status === 'pending' && x.payment_provider === 'alphapay' ? (
                <div>
                  <p className="note" style={{ marginTop: 8 }}>{t(x.payment_status === 'failed' ? 'saspay_return_failed' : 'saspay_return_pending')}</p>
                  <button className="p" disabled={payingCampaign === x.id} onClick={() => c.run(() => createAlphaPayCheckout(x.id))}>
                    {payingCampaign === x.id ? '…' : t('saspay_pay_campaign')}
                  </button>
                </div>
              ) : (
                <>
                  <div className="bar"><i style={{ width: Math.round((x.spent / x.budget) * 100) + '%' }} /></div>
                  <button className="s" style={{ marginTop: 10 }} onClick={() => setReport(report === x.id ? null : x.id)}>{t('report')}</button>
                  {report === x.id && <ReportPanel id={x.id} />}
                </>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
