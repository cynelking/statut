'use client';
import { FormEvent, useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';

interface AdminUser {
  id: string;
  phone: string;
  country: string | null;
  role: 'user' | 'admin';
  credit: number;
  created_at: string | null;
}

const PAGE_SIZE = 25;

function formatDate(value: string | null, lang: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const locale = lang === 'en' ? 'en-US' : lang === 'pt' ? 'pt-PT' : 'fr-FR';
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function AdminUsers() {
  const { t, f, lang } = useI18n();
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');

    const load = async () => {
      try {
        let query = sb.from('profiles')
          .select('id,phone,country,role,credit,created_at', { count: 'exact' });
        if (search) query = query.ilike('phone', `%${search}%`);
        const result = await query.order('created_at', { ascending: false })
          .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
        if (!current) return;
        if (result.error) {
          setError(result.error.message);
          setUsers([]);
          setTotal(0);
          return;
        }
        setUsers((result.data ?? []) as AdminUser[]);
        setTotal(result.count ?? 0);
      } catch (reason) {
        if (!current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setUsers([]);
        setTotal(0);
      } finally {
        if (current) setLoading(false);
      }
    };

    void load();
    return () => { current = false; };
  }, [page, search]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(0);
    setSearch(input.replace(/[%_,.()]/g, '').trim());
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="card">
      <div className="admin-section-head">
        <h2>{t('k_users')} · {total}</h2>
        <form className="admin-search" onSubmit={submit}>
          <input
            type="search"
            aria-label={t('admin_search_phone')}
            placeholder={t('admin_search_phone')}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <button className="s" type="submit">{t('admin_search')}</button>
        </form>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {loading && <p className="m">…</p>}
      {!loading && !error && users.length === 0 && <p className="m">{t('admin_no_users')}</p>}
      {!loading && !error && users.map((user) => (
        <div className="row admin-user" key={user.id}>
          <div className="admin-user-info">
            <b>{user.phone}</b>
            <span className="m">
              {user.country || '—'} · {t('admin_created')} {formatDate(user.created_at, lang)}
            </span>
          </div>
          <div className="actions">
            <span className="tag">{user.role === 'admin' ? t('r_m') : t('r_d')}</span>
            <span className="tag">{t('credit')} · {f(Number(user.credit ?? 0))}</span>
          </div>
        </div>
      ))}
      {!loading && !error && total > PAGE_SIZE && (
        <div className="admin-pagination">
          <button className="s" type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>
            {t('admin_previous')}
          </button>
          <span className="m">{t('admin_page')} {page + 1} {t('admin_of')} {pageCount}</span>
          <button className="s" type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>
            {t('admin_next')}
          </button>
        </div>
      )}
    </section>
  );
}
