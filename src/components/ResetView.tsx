'use client';
import { useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';

export default function ResetView({ run, say, done }: { run: (fn: () => Promise<void>) => void; say: (m: string) => void; done: () => void }) {
  const { t } = useI18n();
  const [pw, setPw] = useState('');
  return (
    <form className="card" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        if (pw.length < 6) throw new Error(t('bad_pw'));
        const r = await sb.auth.updateUser({ password: pw });
        if (r.error) throw r.error;
        say(t('pw_ok'));
        done();
      });
    }}>
      <h2>{t('reset_t')}</h2>
      <label htmlFor="np">{t('new_pw')}</label>
      <input id="np" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <button className="p" type="submit">{t('set_pw')}</button>
    </form>
  );
}
