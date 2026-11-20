'use client';
import { useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';

export default function AdminAnnouncements() {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');

  async function publish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setResult('');
    try {
      const token = (await sb.auth.getSession()).data.session?.access_token;
      if (!token) throw new Error(t('auth_login_hint'));
      const response = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title, body }),
      });
      const payload = await response.json() as { sent?: number; failed?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || t('announcement_error'));
      setTitle('');
      setBody('');
      setResult(`${t('announcement_published')} ${payload.sent ?? 0} · ${t('announcement_failed')} ${payload.failed ?? 0}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>{t('announcement_admin_title')}</h2>
      <p className="m">{t('announcement_admin_help')}</p>
      <form onSubmit={publish}>
        <label className="field">
          <span>{t('announcement_title')}</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required />
        </label>
        <label className="field">
          <span>{t('announcement_message')}</span>
          <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={2000} rows={4} required />
        </label>
        {error && <p className="err" role="alert">{error}</p>}
        {result && <p className="note" role="status">{result}</p>}
        <button className="s" type="submit" disabled={busy || !title.trim() || !body.trim()}>
          {busy ? '…' : t('announcement_publish')}
        </button>
      </form>
    </section>
  );
}
