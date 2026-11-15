'use client';
import { useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { Ctx, DAILY_BONUS, DAILY_GOAL, MIN_WITHDRAW, OPERATORS } from '@/lib/types';
import Leaderboard from './Leaderboard';
import ReferralCard from './ReferralCard';
import LevelCard from './LevelCard';
import RateForm from './RateForm';
import { isNet, queueProof } from '@/lib/offline';

export default function PublisherView({ c }: { c: Ctx }) {
  const { t, f } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [op, setOp] = useState(OPERATORS[0]);
  const [rating, setRating] = useState<number | null>(null);
  const sel = c.sel;
  const my = c.d.proofs;
  const approved = my.filter((p) => p.status === 'approved');
  const paidViews = approved.reduce((s, p) => s + p.views, 0);
  const pending = my.filter((p) => p.status === 'pending').length;
  const title = (id: number) => c.d.camps.find((x) => x.id === id)?.title ?? '#' + id;
  const today = new Date().toISOString().slice(0, 10);
  const todayN = my.filter((p) => p.created_at?.slice(0, 10) === today && p.status !== 'rejected').length;
  const reviewed = new Set(c.d.myReviews);
  function sendProof() {
    c.run(async () => {
      if (!file || sel === null || !file.type.startsWith('image/') || file.size > 5 * 1048576) throw new Error(t('nofile'));
      const queue = async () => {
        await queueProof({ userId: c.user.id, campaignId: sel, name: file.name, type: file.type, blob: file, createdAt: Date.now() });
        c.pick(null); setFile(null); c.say(t('q_saved'));
      };
      if (!navigator.onLine) return queue();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${c.user.id}/${sel}-${Date.now()}.${ext}`;
      const up = await sb.storage.from('proofs').upload(path, file, { contentType: file.type });
      if (up.error) { if (isNet(up.error)) return queue(); throw up.error; }
      const ins = await sb.from('proofs').insert({ campaign_id: sel, user_id: c.user.id, image_path: path });
      if (ins.error) { if (isNet(ins.error)) return queue(); throw ins.error; }
      c.pick(null); setFile(null);
      await c.reload();
      c.say(t('sent'));
    });
  }
  function withdraw() {
    c.run(async () => {
      const r = await sb.rpc('request_withdrawal', { p_amount: c.d.bal, p_operator: op });
      if (r.error) throw r.error;
      await c.reload();
      c.say(t('wdok'));
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

  return (
    <>
      <div className="hero">
        <span className="lb">{t('bal')}</span>
        <b className="big">{f(c.d.bal)}</b>
        <div className="mini"><span><b>{paidViews}</b> {t('views')}</span><span><b>{pending}</b> {t('pend')}</span></div>
      </div>

      <section className="card">
        <h2>{t('daily_t')} · {Math.min(todayN, DAILY_GOAL)}/{DAILY_GOAL}</h2>
        <div className="bar" style={{ marginTop: 0 }}><i style={{ width: Math.min(100, Math.round((todayN / DAILY_GOAL) * 100)) + '%' }} /></div>
        <p className="m" style={{ margin: '8px 0 0' }}>{todayN >= DAILY_GOAL ? t('daily_done') : t('daily_b')} (+{f(DAILY_BONUS)})</p>
      </section>

      <LevelCard dep={approved.length} />

      {sel !== null && (
        <section className="card">
          <h2>{t('proof')} · {title(sel)}</h2>
          <p className="m">{t('proofd')}</p>
          <label htmlFor="fl">{t('file')}</label>
          <input id="fl" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="p" onClick={sendProof}>{t('send')}</button>
          <button className="s" style={{ marginTop: 10 }} onClick={() => c.pick(null)}>{t('ib_no')}</button>
        </section>
      )}

      <section className="card">
        <h2>{t('mine')}</h2>
        {my.length === 0 && <p className="m">{t('none')}</p>}
        {my.map((p, i) => (
          <div className={'row' + (i === 0 ? ' first' : '')} key={p.id}>
            <span>{title(p.campaign_id)}</span>
            <div className="actions">
              {p.status === 'approved' && !reviewed.has(p.id) && (
                <button className="s" onClick={() => setRating(rating === p.id ? null : p.id)}>★ {t('rate_adv')}</button>
              )}
              <span className={'tag ' + (p.status === 'approved' ? 'ok' : p.status === 'rejected' ? 'bad' : 'w')}>
                {p.status === 'approved' ? `${t('ap')} · ${p.views + p.bonus} F` : p.status === 'rejected' ? t('rj') : t('pd')}
              </span>
            </div>
            {rating === p.id && <RateForm title={`${t('rate_adv')} · ${title(p.campaign_id)}`} onSubmit={(s, cm) => rate(p.id, s, cm)} onCancel={() => setRating(null)} />}
          </div>
        ))}
      </section>

      <ReferralCard c={c} />
      <Leaderboard />

      <section className="card">
        <h2>{t('wd')}</h2>
        <label htmlFor="op">{t('op')}</label>
        <select id="op" value={op} onChange={(e) => setOp(e.target.value)}>
          {OPERATORS.map((o) => <option key={o}>{o}</option>)}
        </select>
        <p className="m">{t('wdmin')}</p>
        <button className="p" disabled={c.d.bal < MIN_WITHDRAW} onClick={withdraw}>{t('wdb')} {f(c.d.bal)}</button>
      </section>
    </>
  );
}
