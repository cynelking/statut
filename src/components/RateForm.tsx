'use client';
import { useId, useState } from 'react';
import { useI18n } from '@/lib/i18n';

export default function RateForm({ title, onSubmit, onCancel }: { title: string; onSubmit: (stars: number, comment: string) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const [s, setS] = useState(5);
  const [c, setC] = useState('');
  return (
    <div className="note" style={{ marginTop: 8, width: '100%' }}>
      <b>{title}</b>
      <div className="stars" role="radiogroup" aria-label={t('stars')}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={s === n} className={n <= s ? 'on' : ''} onClick={() => setS(n)} aria-label={`${n} ${t('stars_aria')}`}>★</button>
        ))}
      </div>
      <label htmlFor={id}>{t('comment')}</label>
      <input id={id} maxLength={300} value={c} onChange={(e) => setC(e.target.value)} />
      <div className="actions" style={{ marginTop: 10 }}>
        <button className="s on" type="button" onClick={() => onSubmit(s, c)}>{t('send')}</button>
        <button className="s" type="button" onClick={onCancel}>{t('ib_no')}</button>
      </div>
    </div>
  );
}
