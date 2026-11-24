'use client';
import { useCallback, useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import type { Ctx } from '@/lib/types';

interface Ticket {
  id: number;
  user_id: string;
  subject: string;
  status: 'open' | 'answered' | 'closed';
  created_at: string;
  updated_at: string;
  profiles?: { phone: string; display_name: string | null } | null;
}

interface TicketMessage {
  id: number;
  ticket_id: number;
  sender_id: string;
  sender_is_admin: boolean;
  message: string;
  created_at: string;
}

export default function SupportTickets({ c, adminMode = false }: { c: Ctx; adminMode?: boolean }) {
  const { t } = useI18n();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [subject, setSubject] = useState('');
  const [initialMessage, setInitialMessage] = useState('');
  const [replyDraft, setReplyDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadTickets = useCallback(async () => {
    let query = sb.from('support_tickets')
      .select('id,user_id,subject,status,created_at,updated_at,profiles(phone,display_name)')
      .order('updated_at', { ascending: false })
      .limit(adminMode ? 100 : 50);
    if (!adminMode) query = query.eq('user_id', c.user.id);

    const result = await query;
    if (result.error) throw result.error;
    const rows = (result.data ?? []) as Ticket[];
    setTickets(rows);
    setSelectedId((current) => rows.some((ticket) => ticket.id === current)
      ? current
      : rows[0]?.id ?? null);
  }, [adminMode, c.user.id]);

  const loadMessages = useCallback(async (ticketId: number | null) => {
    if (ticketId === null) {
      setMessages([]);
      return;
    }
    const result = await sb.from('support_ticket_messages')
      .select('id,ticket_id,sender_id,sender_is_admin,message,created_at')
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (result.error) throw result.error;
    setMessages((result.data ?? []) as TicketMessage[]);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void loadTickets()
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [loadTickets]);

  useEffect(() => {
    let active = true;
    void loadMessages(selectedId).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [loadMessages, selectedId]);

  async function createTicket() {
    setSaving(true);
    setError('');
    try {
      const result = await sb.rpc('create_support_ticket', {
        p_subject: subject,
        p_message: initialMessage,
      });
      if (result.error) throw result.error;
      const id = Number(result.data);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error(t('support_error'));
      setSubject('');
      setInitialMessage('');
      await loadTickets();
      setSelectedId(id);
      c.say(t('support_saved'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function reply() {
    if (selectedId === null) return;
    setSaving(true);
    setError('');
    try {
      const result = await sb.rpc('reply_support_ticket', {
        p_ticket_id: selectedId,
        p_message: replyDraft,
      });
      if (result.error) throw result.error;
      setReplyDraft('');
      await Promise.all([loadTickets(), loadMessages(selectedId)]);
      c.say(t('support_replied'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(status: Ticket['status']) {
    if (selectedId === null) return;
    setSaving(true);
    setError('');
    try {
      const result = await sb.rpc('set_support_ticket_status', {
        p_ticket_id: selectedId,
        p_status: status,
      });
      if (result.error) throw result.error;
      await loadTickets();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  const selected = tickets.find((ticket) => ticket.id === selectedId) ?? null;
  const canReply = selected !== null && selected.status !== 'closed';

  return (
    <section className="card">
      <div className="row first">
        <div>
          <h2>{t(adminMode ? 'support_admin_tab' : 'support_title')}</h2>
          {!adminMode && <p className="m">{t('support_description')}</p>}
        </div>
        <button className="s" type="button" disabled={loading} onClick={() => {
          setLoading(true);
          setError('');
          void loadTickets()
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
            .finally(() => setLoading(false));
        }}>{t('admin_refresh')}</button>
      </div>

      {error && <p className="err" role="alert">{error}</p>}

      {!adminMode && (
        <div>
          <label htmlFor="support-subject">{t('support_subject')}</label>
          <input id="support-subject" maxLength={120} value={subject}
            onChange={(event) => setSubject(event.target.value)} />
          <label htmlFor="support-message">{t('support_message')}</label>
          <textarea id="support-message" rows={4} maxLength={4000} value={initialMessage}
            onChange={(event) => setInitialMessage(event.target.value)} />
          <button className="p" type="button" disabled={saving || subject.trim().length < 4 || !initialMessage.trim()}
            onClick={() => void createTicket()}>{saving ? '…' : t('support_create')}</button>
        </div>
      )}

      <div className="support-ticket-layout">
        <div>
          <h3>{t(adminMode ? 'support_queue' : 'support_mine')}</h3>
          {loading && <p className="m">…</p>}
          {!loading && tickets.length === 0 && <p className="m">{t('support_no_tickets')}</p>}
          {tickets.map((ticket) => (
            <button key={ticket.id} type="button"
              className={`support-ticket-item${selectedId === ticket.id ? ' on' : ''}`}
              aria-pressed={selectedId === ticket.id}
              onClick={() => {
                setSelectedId(ticket.id);
                setReplyDraft('');
              }}>
              <span><b>{ticket.subject}</b><small>{adminMode
                ? ticket.profiles?.display_name || ticket.profiles?.phone || `#${ticket.id}`
                : `#${ticket.id}`}</small></span>
              <span className={`tag ${ticket.status === 'answered' ? 'ok' : ticket.status === 'closed' ? '' : 'w'}`}>
                {t(`support_status_${ticket.status}`)}
              </span>
            </button>
          ))}
        </div>

        <div>
          {selected ? (
            <>
              <div className="row first">
                <h3>{selected.subject}</h3>
                {adminMode && (
                  <label className="support-status">
                    <span>{t('support_status')}</span>
                    <select aria-label={t('support_status')} value={selected.status} disabled={saving}
                      onChange={(event) => void setStatus(event.target.value as Ticket['status'])}>
                      <option value="open">{t('support_status_open')}</option>
                      <option value="answered">{t('support_status_answered')}</option>
                      <option value="closed">{t('support_status_closed')}</option>
                    </select>
                  </label>
                )}
              </div>
              <div className="support-thread" aria-live="polite">
                {messages.map((message) => (
                  <article className="support-message" key={message.id}>
                    <b>{message.sender_is_admin
                      ? t('support_staff')
                      : message.sender_id === c.user.id ? t('support_you') : t('support_user')}</b>
                    <p>{message.message}</p>
                    <time className="m" dateTime={message.created_at}>
                      {new Date(message.created_at).toLocaleString()}
                    </time>
                  </article>
                ))}
                {messages.length === 0 && <p className="m">{t('support_empty_thread')}</p>}
              </div>
              {canReply ? (
                <div>
                  <label htmlFor="support-reply">{t('support_reply')}</label>
                  <textarea id="support-reply" rows={3} maxLength={4000} value={replyDraft}
                    onChange={(event) => setReplyDraft(event.target.value)} />
                  <button className="p" type="button" disabled={saving || !replyDraft.trim()}
                    onClick={() => void reply()}>{saving ? '…' : t('support_send')}</button>
                </div>
              ) : <p className="note">{t('support_closed_hint')}</p>}
            </>
          ) : !loading && <p className="m">{t('support_select')}</p>}
        </div>
      </div>
    </section>
  );
}
