'use client';
import { FormEvent, useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';

interface AdminUser {
  id: string;
  phone: string;
  country: string | null;
  role: 'user' | 'agency' | 'admin';
  credit: number;
  created_at: string | null;
}

interface ContactExportRow {
  display_name: string | null;
  phone: string;
}

const PAGE_SIZE = 25;
const EXPORT_PAGE_SIZE = 500;

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function safeContactName(value: string) {
  const name = value.replace(/[\r\n]+/g, ' ').trim();
  return /^[=+\-@\t]/.test(name) ? `'${name}` : name;
}

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
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

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

  async function exportContacts() {
    setExporting(true);
    setExportError('');
    try {
      const contacts: ContactExportRow[] = [];
      for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
        const result = await sb.from('profiles')
          .select('display_name,phone')
          .order('id', { ascending: true })
          .range(offset, offset + EXPORT_PAGE_SIZE - 1);
        if (result.error) throw result.error;
        const batch = (result.data ?? []) as ContactExportRow[];
        contacts.push(...batch);
        if (batch.length < EXPORT_PAGE_SIZE) break;
      }

      const rows = [
        ['Name', 'Phone 1 - Value'],
        ...contacts.map(({ display_name, phone }) => [
          csvCell(safeContactName(display_name?.trim() || phone)),
          csvCell(phone.replace(/[\r\n]+/g, '').trim()),
        ]),
      ];
      const blob = new Blob([`\uFEFF${rows.map((row) => row.join(',')).join('\r\n')}`], {
        type: 'text/csv;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `statutpay-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(false);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="card">
      <div className="admin-section-head">
        <h2>{t('k_users')} · {total}</h2>
        <div className="admin-users-tools">
          <button className="s" type="button" disabled={exporting} onClick={() => void exportContacts()}>
            {exporting ? t('admin_exporting_contacts') : t('admin_export_contacts')}
          </button>
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
      </div>
      <p className="m">{t('admin_export_contacts_help')}</p>
      {error && <p className="err" role="alert">{error}</p>}
      {exportError && <p className="err" role="alert">{exportError}</p>}
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
            <span className="tag">{user.role === 'admin' ? t('r_m') : user.role === 'agency' ? t('agency_account') : t('r_d')}</span>
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
