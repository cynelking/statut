'use client';
import { useCallback, useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { Lang, useI18n } from '@/lib/i18n';
import type { Transaction } from '@/lib/types';

const PAGE_SIZE = 50;

function dateLabel(value: string | null, lang: Lang) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const locale = lang === 'en' ? 'en-US' : lang === 'pt' ? 'pt-PT' : 'fr-FR';
  return date.toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const KIND_LABELS: Record<Transaction['kind'], string> = {
  earning: 'tx_earning',
  level_bonus: 'tx_level_bonus',
  referral_bonus: 'tx_referral_bonus',
  daily_bonus: 'tx_daily_bonus',
  promo_credit: 'tx_promo_credit',
  credit_used: 'tx_credit_used',
  credit_refund: 'tx_credit_refund',
  withdrawal: 'tx_withdrawal',
  proof_status: 'tx_proof_status',
};

const STATUS_LABELS: Record<Transaction['status'], string> = {
  approved: 'tx_approved',
  pending: 'tx_pending',
  rejected: 'tx_rejected',
  paid: 'tx_paid',
  credited: 'tx_credited',
  used: 'tx_used',
  refunded: 'tx_refunded',
};

export default function TransactionHistory() {
  const { t, f, lang } = useI18n();
  const [items, setItems] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [retryOffset, setRetryOffset] = useState(0);

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true);
    setError('');
    setRetryOffset(offset);
    try {
      const result = await sb.rpc('my_transactions', { p_offset: offset });
      if (result.error) throw result.error;
      const page = (result.data ?? []) as Transaction[];
      const visible = page.slice(0, PAGE_SIZE);
      setItems((previous) => offset === 0 ? visible : [...previous, ...visible]);
      setHasMore(page.length > PAGE_SIZE);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPage(0); }, [loadPage]);

  return (
    <section className="card transaction-history">
      <div className="transaction-heading">
        <div>
          <h2>{t('tx_history')}</h2>
          <p className="m">{t('tx_description')}</p>
        </div>
      </div>
      {error && (
        <div className="transaction-error" role="alert">
          <span>{t('tx_load_error')} {error}</span>
          <button className="s" type="button" onClick={() => { void loadPage(retryOffset); }} disabled={loading}>{t('tx_retry')}</button>
        </div>
      )}
      {!error && loading && items.length === 0 && <p className="m" role="status">{t('tx_loading')}</p>}
      {!error && !loading && items.length === 0 && <p className="m">{t('tx_empty')}</p>}
      {items.length > 0 && (
        <div className="transaction-list">
          {items.map((item) => {
            const statusClass = item.status === 'pending' ? 'w' : item.status === 'rejected' ? 'bad' : 'ok';
            const detail = item.kind === 'referral_bonus' && item.title
              ? `${t('tx_level')} ${item.title}`
              : item.title;
            return (
              <article className="transaction-row" key={item.transaction_id}>
                <span className={'transaction-mark ' + (item.amount > 0 ? 'positive' : item.amount < 0 ? 'negative' : 'neutral')} aria-hidden="true">
                  {item.amount > 0 ? '+' : item.amount < 0 ? '−' : '•'}
                </span>
                <div className="transaction-info">
                  <b>{t(KIND_LABELS[item.kind])}</b>
                  {detail && <span className="m transaction-detail">{detail}</span>}
                  <span className="m transaction-date">{dateLabel(item.occurred_at, lang)}</span>
                </div>
                {item.amount !== 0 && (
                  <b className={'transaction-amount ' + (item.amount > 0 ? 'positive' : 'negative')}>{f(item.amount)}</b>
                )}
                <span className={'tag ' + statusClass}>{t(STATUS_LABELS[item.status])}</span>
              </article>
            );
          })}
        </div>
      )}
      {!error && hasMore && (
        <button className="s transaction-more" type="button" onClick={() => { void loadPage(items.length); }} disabled={loading}>
          {loading ? t('tx_loading') : t('tx_more')}
        </button>
      )}
    </section>
  );
}
