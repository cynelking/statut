'use client';
import { FormEvent, useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import type { Ctx } from '@/lib/types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function ProfileOptions({ c, onExport }: { c: Ctx; onExport: () => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState(c.user.email ?? '');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setEmail(c.user.email ?? ''), [c.user.email]);

  function updateEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    c.run(async () => {
      setBusy(true);
      try {
        const nextEmail = email.trim().toLowerCase();
        if (!EMAIL_RE.test(nextEmail)) throw new Error(t('bad_em'));
        if (nextEmail === c.user.email) throw new Error(t('profile_email_same'));
        const { error } = await sb.auth.updateUser({ email: nextEmail });
        if (error) throw error;
        c.say(t('profile_email_confirmation'));
      } finally {
        setBusy(false);
      }
    });
  }

  function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    c.run(async () => {
      setBusy(true);
      try {
        if (password.length < 6) throw new Error(t('bad_pw'));
        if (password !== passwordConfirm) throw new Error(t('profile_password_mismatch'));
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw error;
        setPassword('');
        setPasswordConfirm('');
        c.say(t('profile_password_updated'));
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <section className="card">
      <h2>{t('profile_security')}</h2>
      <p className="m profile-security-hint">{t('profile_security_hint')}</p>
      <form className="profile-security-form" onSubmit={updateEmail}>
        <label htmlFor="profile-email">{t('email')}</label>
        <input id="profile-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <button className="s" type="submit" disabled={busy}>{t('profile_update_email')}</button>
        <p className="m">{t('profile_email_confirmation')}</p>
      </form>
      <form className="profile-security-form" onSubmit={updatePassword}>
        <label htmlFor="profile-password">{t('profile_new_password')}</label>
        <input id="profile-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} required />
        <label htmlFor="profile-password-confirm">{t('profile_confirm_password')}</label>
        <input id="profile-password-confirm" type="password" autoComplete="new-password" value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} minLength={6} required />
        <button className="s" type="submit" disabled={busy}>{t('profile_update_password')}</button>
      </form>
      <div className="profile-data-export">
        <div><b>{t('profile_data_title')}</b><p className="m">{t('profile_data_body')}</p></div>
        <button className="s" type="button" onClick={onExport}>{t('profile_export')}</button>
      </div>
    </section>
  );
}
