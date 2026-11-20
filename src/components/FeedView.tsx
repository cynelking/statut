'use client';
import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useI18n } from '@/lib/i18n';
import type { CType, Campaign, Ctx } from '@/lib/types';
import { Icon } from './ui';
import PushToggle from './PushToggle';
import { sb } from '@/lib/supabase';

interface Announcement {
  id: number;
  title: string;
  body: string;
  created_at: string;
  pinned_until: string | null;
}

const URL_RE = /^https?:\/\/\S+$/i;
const imageLoader = ({ src }: { src: string }) => src;

function ago(iso: string | undefined, lang: string): string {
  if (!iso) return '';
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const a = Math.abs(s);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

export default function FeedView({ c }: { c: Ctx }) {
  const { t, f, lang } = useI18n();
  const [fmt, setFmt] = useState<'all' | CType>('all');
  const [scope, setScope] = useState<'mine' | 'all' | 'fav'>('mine');
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [announcementsLoading, setAnnouncementsLoading] = useState(true);
  const [announcementsError, setAnnouncementsError] = useState(false);
  const favs = new Set(c.d.favs);
  const submitted = new Set(c.d.proofs.map((p) => p.campaign_id));
  const eligible = (x: Campaign) => !x.country || x.country === c.profile.country;
  const now = Date.now();
  const boosted = (x: Campaign) => x.boost_hours > 0 && !!x.boost_until && Date.parse(x.boost_until) > now;
  const live = (x: Campaign) => (!x.starts_at || Date.parse(x.starts_at) <= now) && (!x.ends_at || Date.parse(x.ends_at) > now);
  const ads = c.d.camps.filter((x) =>
    x.status === 'active' && x.spent < x.budget && live(x)
    && (fmt === 'all' || x.type === fmt)
    && (scope === 'all' || (scope === 'mine' && eligible(x)) || (scope === 'fav' && favs.has(x.id))))
    .sort((a, b) => Number(boosted(b)) - Number(boosted(a)) || b.id - a.id);

  useEffect(() => {
    let current = true;
    const loadAnnouncements = async () => {
      try {
        const now = new Date();
        const select = 'id,title,body,created_at,pinned_until';
        const [recent, pinned] = await Promise.all([
          sb.from('announcements')
            .select(select)
            .order('created_at', { ascending: false })
            .limit(5),
          sb.from('announcements')
            .select(select)
            .gt('pinned_until', now.toISOString())
            .order('pinned_until', { ascending: true })
            .limit(1000),
        ]);
        if (!current) return;
        if (recent.error || pinned.error) {
          console.error('Could not load announcements', { recent: recent.error, pinned: pinned.error });
          setAnnouncementsError(true);
        } else {
          const byId = new Map<number, Announcement>();
          for (const announcement of [...(pinned.data ?? []), ...(recent.data ?? [])]) {
            byId.set(announcement.id, announcement as Announcement);
          }
          const sorted = [...byId.values()].sort((a, b) => {
            const aPinned = !!a.pinned_until && Date.parse(a.pinned_until) > now.getTime();
            const bPinned = !!b.pinned_until && Date.parse(b.pinned_until) > now.getTime();
            if (aPinned !== bPinned) return aPinned ? -1 : 1;
            if (aPinned && bPinned) {
              return Date.parse(a.pinned_until ?? '') - Date.parse(b.pinned_until ?? '');
            }
            return Date.parse(b.created_at) - Date.parse(a.created_at);
          });
          setAnnouncements(sorted);
        }
      } catch (reason) {
        if (current) {
          console.error('Could not load announcements', reason);
          setAnnouncementsError(true);
        }
      } finally {
        if (current) setAnnouncementsLoading(false);
      }
    };
    void loadAnnouncements();
    return () => { current = false; };
  }, []);

  function copy(x: Campaign) {
    c.run(async () => {
      await navigator.clipboard.writeText([x.title, x.content].filter(Boolean).join('\n\n'));
      c.say(t('copied'));
    });
  }

  function fileBaseName(title: string) {
    return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'statutpay-campaign';
  }

  function mediaFileName(x: Campaign) {
    let extension = x.type === 'img' ? 'jpg' : 'mp4';
    try {
      const pathExtension = new URL(x.media_url ?? '').pathname.split('.').pop()?.toLowerCase();
      const allowed = x.type === 'img' ? ['jpg', 'jpeg', 'png', 'webp', 'gif'] : ['mp4', 'webm', 'mov'];
      if (pathExtension && allowed.includes(pathExtension)) extension = pathExtension;
    } catch { /* use the format's default extension */ }
    return `${fileBaseName(x.title)}.${extension}`;
  }

  function downloadMedia(x: Campaign) {
    if (!x.media_url) return;
    const link = document.createElement('a');
    link.href = x.media_url;
    link.download = mediaFileName(x);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.click();
  }

  function downloadText(x: Campaign) {
    const blob = new Blob([[x.title, x.content].filter(Boolean).join('\n\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${fileBaseName(x.title)}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function shareCampaign(x: Campaign) {
    const text = [x.title, x.content].filter(Boolean).join('\n\n');
    const url = x.media_url ?? undefined;
    if (navigator.share) {
      c.run(async () => {
        try {
          await navigator.share({ title: x.title, text, url });
        } catch (reason) {
          if (reason instanceof DOMException && reason.name === 'AbortError') return;
          throw new Error(t('share_error'));
        }
      });
      return;
    }
    const waUrl = `https://wa.me/?text=${encodeURIComponent([text, url].filter(Boolean).join('\n\n'))}`;
    const link = document.createElement('a');
    link.href = waUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.click();
  }

  return (
    <>
      <section className="card">
        <h1 style={{ fontSize: 24 }}>{t('feed_t')}</h1>
        <p className="m" style={{ margin: '6px 0 0' }}>{t('feed_s')}</p>
        <div className="scroll-scene" aria-hidden="true">
          <div className="scene-phone">
            <span className="scene-speaker" />
            <div className="scene-status">
              <span className="scene-check">✓</span>
              <span><b>Statut publié</b><small>+ 120 vues</small></span>
            </div>
          </div>
          <div className="scene-ad">
            <small>ANNONCE ACTIVE</small>
            <b>+ 1 F / vue</b>
            <span><i />Campagne en cours</span>
          </div>
          <span className="scene-coin scene-coin-one">F</span>
          <span className="scene-coin scene-coin-two">F</span>
          <svg className="scene-megaphone" viewBox="0 0 44 44" fill="none">
            <path d="M7 17h8l18-7v24l-18-7H7z" />
            <path d="m15 27 3 10h7l-4-12M36 16q7 6 0 12" />
          </svg>
          <span className="scene-spark scene-spark-one">✦</span>
          <span className="scene-spark scene-spark-two">✦</span>
        </div>
        <div className="how"><div><b>1</b>{t('how1')}</div><div><b>2</b>{t('how2')}</div><div><b>3</b>{t('how3')}</div></div>
      </section>

      <PushToggle c={c} />

      {announcementsLoading && <p className="m" role="status">{t('announcement_loading')}</p>}
      {announcementsError && <p className="card err" role="alert">{t('announcement_load_error')}</p>}
      {announcements.length > 0 && (
        <section className="card announcement-feed" aria-label={t('announcement_feed_title')}>
          <h2>{t('announcement_feed_title')}</h2>
          <div className="announcement-list">
            {announcements.map((announcement) => (
              <article className="announcement-entry" key={announcement.id}>
                <div className="adh">
                  <div className="rl">
                    <b>{announcement.title}</b>
                    {announcement.pinned_until && Date.parse(announcement.pinned_until) > Date.now() && (
                      <span className="tag w">{t('announcement_pinned')} · {ago(announcement.pinned_until, lang)}</span>
                    )}
                  </div>
                  <span className="m">{ago(announcement.created_at, lang)}</span>
                </div>
                <p>{announcement.body}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      <div className="chipsf" role="group">
        {(['mine', 'all', 'fav'] as const).map((k) => (
          <button key={k} className={'s' + (scope === k ? ' on' : '')} onClick={() => setScope(k)}>{t('sc_' + k)}</button>
        ))}
      </div>
      <div className="chipsf" role="group">
        {(['all', 'img', 'vid', 'txt'] as const).map((k) => (
          <button key={k} className={'s' + (fmt === k ? ' on' : '')} onClick={() => setFmt(k)}>{k === 'all' ? t('f_all') : t(k)}</button>
        ))}
      </div>

      {ads.length === 0 && <p className="card m">{t('none')}</p>}
      {ads.map((x) => {
        const left = x.budget - x.spent;
        const txt = x.content ?? '';
        const fav = favs.has(x.id);
        const ok = eligible(x);
        return (
          <article className="ad" key={x.id}>
            <div className="adh">
              <div className="rl">
                <i className="ic"><Icon n={x.type} /></i>
                <div>
                  <b>{x.title}</b>{boosted(x) && <> <span className="tag boost">{t('sponsored')}</span></>}
                  <div className="m">{t(x.type)}{x.created_at ? ' · ' + ago(x.created_at, lang) : ''}{x.country ? ' · ' + x.country : ''}{x.ends_at ? ' · ' + t('ends_in') + ' ' + ago(x.ends_at, lang) : ''}</div>
                </div>
              </div>
              <button className="iconbtn" aria-pressed={fav} aria-label={fav ? t('fav_rm') : t('fav_add')} title={fav ? t('fav_rm') : t('fav_add')} onClick={() => c.toggleFav(x.id)}>
                <Icon n="heart" fill={fav} />
              </button>
            </div>
            {txt && (
              <p className="adtxt">
                {URL_RE.test(txt) ? <a href={txt} target="_blank" rel="noopener noreferrer">{txt}</a> : txt}
              </p>
            )}
            {x.media_url && x.type === 'img' && (
              <div className="ad-media-frame">
                <Image loader={imageLoader} src={x.media_url} alt={x.title} width={1200} height={900} sizes="100vw" unoptimized className="ad-media" />
              </div>
            )}
            {x.media_url && x.type === 'vid' && (
              <video className="ad-media" src={x.media_url} controls playsInline preload="metadata" />
            )}
            <div className="bar"><i style={{ width: Math.round((x.spent / x.budget) * 100) + '%' }} /></div>
            <div className="m">{t('rest')} {f(left)} · {left.toLocaleString()} {t('views_max')}</div>
            <div className="actions">
              <span className="actions">
                <span className="tag ok">{t('earn')}</span>
                {c.d.ratings[x.owner] && <span className="tag">★ {c.d.ratings[x.owner].score} · {c.d.ratings[x.owner].n} {t('reviews_n')}</span>}
              </span>
              <div className="actions ad-tools">
                {x.media_url && x.type !== 'txt' && (
                  <button className="s" type="button" onClick={() => downloadMedia(x)}><Icon n="dl" />{t('download_media')}</button>
                )}
                <button className="s" onClick={() => copy(x)}>{t('copy')}</button>
                {(x.type === 'txt' || x.content) && (
                  <button className="s" type="button" onClick={() => downloadText(x)}><Icon n="dl" />{t('download_text')}</button>
                )}
                <button className="s" type="button" onClick={() => shareCampaign(x)}><Icon n="share" />{t('share_campaign')}</button>
                <button className="p" disabled={submitted.has(x.id) || !ok} onClick={() => { c.pick(x.id); c.go('d'); }}>
                  {submitted.has(x.id) ? t('posted') : ok ? t('post') : t('other_c')}
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </>
  );
}
