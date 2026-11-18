'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { Ctx, DAILY_BONUS, DAILY_GOAL, MIN_WITHDRAW } from '@/lib/types';
import Leaderboard from './Leaderboard';
import ReferralCard from './ReferralCard';
import LevelCard from './LevelCard';
import RateForm from './RateForm';
import { isNet, queueProof } from '@/lib/offline';
import { COUNTRY_CODES, type SasPayCountry, type SasPayNetwork } from '@/lib/saspay';

export default function PublisherView({ c }: { c: Ctx }) {
  const { t, f } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [payCountries, setPayCountries] = useState<SasPayCountry[]>([]);
  const [payNetworks, setPayNetworks] = useState<SasPayNetwork[]>([]);
  const [withdrawCountry, setWithdrawCountry] = useState(COUNTRY_CODES[c.profile.country || ''] || '');
  const [withdrawNetwork, setWithdrawNetwork] = useState('');
  const [recipientPhone, setRecipientPhone] = useState(c.profile.phone);
  const [networkError, setNetworkError] = useState('');
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
  const activeCountries = payCountries.filter((country) =>
    payNetworks.some((network) => network.country === country.iso_code && network.is_active),
  );
  const countryNetworks = payNetworks.filter((network) =>
    network.country === withdrawCountry && network.is_active,
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      const session = await sb.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) throw new Error('Connectez-vous pour charger les réseaux de retrait');
      const response = await fetch('/api/saspay/networks', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await response.json() as { countries?: SasPayCountry[]; networks?: SasPayNetwork[]; error?: string };
      if (!response.ok) throw new Error(result.error || 'Impossible de charger les réseaux SasPay');
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
  }, [c.profile.country]);

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
      const selectedNetwork = countryNetworks.find((network) => network.code === withdrawNetwork);
      if (!selectedNetwork) throw new Error(t('saspay_network_required'));
      if (!recipientPhone.trim()) throw new Error(t('saspay_phone_required'));
      const r = await sb.rpc('request_withdrawal', {
        p_amount: c.d.bal,
        p_operator: selectedNetwork.name,
        p_country: withdrawCountry,
        p_network: selectedNetwork.code,
        p_phone: recipientPhone.trim(),
      });
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
        <button className="p" disabled={c.d.bal < MIN_WITHDRAW || !withdrawNetwork || !!networkError} onClick={withdraw}>{t('wdb')} {f(c.d.bal)}</button>
        <p className="m">{t('saspay_payout_admin_note')}</p>
      </section>
    </>
  );
}
