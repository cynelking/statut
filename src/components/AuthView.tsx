'use client';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { ADMIN, ADMIN_LINK, COUNTRIES } from '@/lib/types';
import { Icon } from './ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
type Mode = 'signup' | 'login' | 'forgot';
type AuthMode = 'welcome' | Mode;

export default function AuthView({ run }: { run: (fn: () => Promise<void>) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<AuthMode>('welcome');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('Togo');
  const [pw, setPw] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [ref, setRef] = useState('');
  const su = mode === 'signup';

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('ref');
    if (q) localStorage.setItem('ref', q.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16));
    setRef(localStorage.getItem('ref') ?? '');
  }, []);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  function submit() {
    run(async () => {
      setBusy(true);
      try {
        const em = email.trim().toLowerCase();
        if (!EMAIL_RE.test(em)) throw new Error(t('bad_em'));
        if (mode === 'forgot') {
          const r = await sb.auth.resetPasswordForEmail(em, { redirectTo: window.location.origin });
          if (r.error) throw r.error;
          setMode('login');
          throw new Error(t('reset_sent'));
        }
        if (pw.length < 6) throw new Error(t('bad_pw'));
        if (su) {
          const d = phone.replace(/\D/g, '');
          if (d.length < 8 || d.length > 15) throw new Error(t('bad_ph'));
          if (!saved) throw new Error(t('bad_sv'));
          const r = await sb.auth.signUp({
            email: em, password: pw,
            options: { data: { phone: '+' + d, country, ref }, emailRedirectTo: window.location.origin },
          });
          if (r.error) {
            const errorText = `${r.error.message} ${r.error.code ?? ''}`;
            if (/profiles.*phone.*(key|unique)|phone.*(duplicate|unique)|duplicate.*phone/i.test(errorText)) {
              throw new Error(t('phone_taken'));
            }
            if (/database error saving new user/i.test(r.error.message)) {
              console.error('Supabase signup failed while creating the profile', {
                code: r.error.code,
                message: r.error.message,
              });
              throw new Error(t('signup_db_error'));
            }
            throw r.error;
          }
          if (r.data.user?.identities && r.data.user.identities.length === 0) throw new Error(t('exists'));
          if (!r.data.session) { setSentTo(em); setWait(60); }
        } else {
          const r = await sb.auth.signInWithPassword({ email: em, password: pw });
          if (r.error) {
            if (/not confirmed/i.test(r.error.message)) { setSentTo(em); throw new Error(t('not_conf')); }
            throw r.error;
          }
        }
      } finally {
        setBusy(false);
      }
    });
  }

  function resend() {
    run(async () => {
      if (!sentTo) return;
      const r = await sb.auth.resend({ type: 'signup', email: sentTo, options: { emailRedirectTo: window.location.origin } });
      if (r.error) throw r.error;
      setWait(60);
      throw new Error(t('resent'));
    });
  }

  if (sentTo) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '32px 20px' }}>
        <i className="ic" style={{ margin: '0 auto 14px', width: 56, height: 56, borderRadius: 16 }}><Icon n="mail" /></i>
        <h1 style={{ fontSize: 24 }}>{t('check_t')}</h1>
        <p className="m" style={{ margin: '10px 0 0' }}>{t('check_b')}</p>
        <p style={{ fontWeight: 800, margin: '4px 0 10px', wordBreak: 'break-all' }}>{sentTo}</p>
        <p className="m" style={{ margin: 0 }}>{t('check_b2')}</p>
        <button className="p" disabled={wait > 0} onClick={resend}>{wait > 0 ? `${t('wait')} ${wait} s` : t('resend')}</button>
        <button className="s" style={{ marginTop: 12 }} onClick={() => { setSentTo(null); setMode('login'); }}>{t('back')}</button>
      </div>
    );
  }

  return (
    <>
      {mode === 'welcome' ? (
        <>
          <div className="hero">
            <h1>{t('join')}</h1>
            <p>{t('join_s')}</p>
            <div className="chips"><span>1 F / {t('view1')}</span><span>500 F min.</span><span>Mobile Money</span></div>
          </div>
          <section className="card auth-welcome">
            <h2>{t('auth_choose')}</h2>
            <div className="auth-options">
              <div className="auth-option">
                <i className="ic"><Icon n="user" /></i>
                <h2>{t('signup')}</h2>
                <p className="m">{t('join_s')}</p>
                <button className="p" onClick={() => setMode('signup')}>{t('create')}</button>
              </div>
              <div className="auth-option">
                <i className="ic"><Icon n="mail" /></i>
                <h2>{t('login')}</h2>
                <p className="m">{t('auth_login_hint')}</p>
                <button className="s" onClick={() => setMode('login')}>{t('enter')}</button>
              </div>
            </div>
          </section>
        </>
      ) : (
        <>
          <div className="hero auth-hero">
            <button type="button" className="auth-back" onClick={() => setMode('welcome')}>‹ {t('auth_back')}</button>
            <h1>{mode === 'forgot' ? t('reset_t') : t(su ? 'signup' : 'login')}</h1>
            <p>{mode === 'signup' ? t('join_s') : mode === 'login' ? t('auth_login_hint') : t('reset_b')}</p>
            {su && <div className="chips"><span>1 F / {t('view1')}</span><span>500 F min.</span><span>Mobile Money</span></div>}
          </div>
          <form className="card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <label htmlFor="em">{t('email')}</label>
            <input id="em" type="email" inputMode="email" autoComplete="email" placeholder="nom@exemple.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            {su && (
              <>
                <label htmlFor="ph">{t('phone')}</label>
                <input id="ph" type="tel" inputMode="tel" autoComplete="tel" placeholder="+228 90 00 00 00" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <label htmlFor="co">{t('country')}</label>
                <select id="co" value={country} onChange={(e) => setCountry(e.target.value)}>
                  {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </>
            )}
            {mode !== 'forgot' && (
              <>
                <label htmlFor="pw">{t('pw')}</label>
                <input id="pw" type="password" autoComplete={su ? 'new-password' : 'current-password'} value={pw} onChange={(e) => setPw(e.target.value)} />
              </>
            )}
            {mode === 'login' && <button type="button" className="linkbtn" onClick={() => setMode('forgot')}>{t('forgot')}</button>}
            {su && ref && <p className="m" style={{ margin: '12px 0 0' }}>{t('ref_by')} <b>{ref}</b></p>}
            {su && (
              <div className="note" style={{ marginTop: 14 }}>
                <b>{t('s1')}</b><br />{t('s1d')}<br /><b>{ADMIN}</b><br />
                <a className="p" href={ADMIN_LINK} target="_blank" rel="noopener noreferrer">{t('open')}</a>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>
                  <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> {t('saved')}
                </label>
              </div>
            )}
            <button className="p" type="submit" disabled={busy}>{mode === 'forgot' ? t('reset_send') : t(su ? 'create' : 'enter')}</button>
            {mode === 'forgot' && <button type="button" className="linkbtn" onClick={() => setMode('login')}>{t('back')}</button>}
          </form>
        </>
      )}
    </>
  );
}
