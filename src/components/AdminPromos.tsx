'use client';
import { useCallback, useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import type { Ctx } from '@/lib/types';

interface Promo { code: string; credit: number; max_uses: number | null; uses: number; active: boolean }

export default function AdminPromos({ c }: { c: Ctx }) {
  const { t, f } = useI18n();
  const [list, setList] = useState<Promo[]>([]);
  const [code, setCode] = useState('');
  const [credit, setCredit] = useState('');
  const [max, setMax] = useState('');

  const load = useCallback(async () => {
    const r = await sb.from('promo_codes').select('*').order('created_at', { ascending: false });
    setList((r.data ?? []) as Promo[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  function add() {
    c.run(async () => {
      const cr = Number(credit);
      if (!code.trim() || !cr) throw new Error(t('bad_em'));
      const r = await sb.from('promo_codes').insert({ code: code.trim().toUpperCase(), credit: cr, max_uses: max ? Number(max) : null });
      if (r.error) throw r.error;
      setCode(''); setCredit(''); setMax('');
      await load(); c.say(t('promo_made'));
    });
  }
  function toggle(p: Promo) {
    c.run(async () => {
      const r = await sb.from('promo_codes').update({ active: !p.active }).eq('code', p.code);
      if (r.error) throw r.error;
      await load();
    });
  }

  return (
    <section className="card">
      <h2>{t('promos')}</h2>
      <div className="grid2">
        <div><label htmlFor="pc">{t('code')}</label><input id="pc" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={20} /></div>
        <div><label htmlFor="pv">{t('credit_f')}</label><input id="pv" inputMode="numeric" value={credit} onChange={(e) => setCredit(e.target.value.replace(/\D/g, ''))} /></div>
      </div>
      <label htmlFor="pm">{t('maxuse')}</label>
      <input id="pm" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} />
      <button className="p" onClick={add}>{t('add')}</button>
      {list.map((p) => (
        <div className="row" key={p.code}>
          <div><b>{p.code}</b> · {f(p.credit)}<div className="m">{p.uses}{p.max_uses ? ` / ${p.max_uses}` : ''} {t('uses')}</div></div>
          <button className={'s' + (p.active ? ' on' : '')} onClick={() => toggle(p)}>{p.active ? t('on') : t('off')}</button>
        </div>
      ))}
    </section>
  );
}
