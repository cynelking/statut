'use client';
import { useCallback, useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import type { Ctx } from '@/lib/types';

interface TeamMember {
  id: number;
  agency_id: string;
  agency_name: string;
  user_id: string | null;
  member_name: string | null;
  member_phone: string | null;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'declined' | 'revoked';
  expires_at: string;
}

interface Client {
  id: number;
  name: string;
  status: 'managed' | 'pending' | 'linked' | 'declined';
}

interface Access {
  team_member_id: number;
  advertiser_id: number;
}

export default function AgencyTeamPanel({ c, clients }: { c: Ctx; clients: Client[] }) {
  const { t } = useI18n();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [assignments, setAssignments] = useState<Record<number, number[]>>({});
  const [draftAssignments, setDraftAssignments] = useState<Record<number, number[]>>({});
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [shareUrl, setShareUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingMemberId, setSavingMemberId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const isOwner = c.agencyWorkspaceRole === 'owner';
  const workspaceId = c.agencyWorkspaceId;

  useEffect(() => {
    setShareUrl('');
  }, [workspaceId]);

  const loadTeam = useCallback(async () => {
    if (!workspaceId) return;
    const membersResult = await sb.from('agency_team_members')
      .select('id,agency_id,agency_name,user_id,member_name,member_phone,role,status,expires_at')
      .eq('agency_id', workspaceId).in('status', ['pending', 'accepted'])
      .order('created_at', { ascending: true });
    if (membersResult.error) throw membersResult.error;
    const nextMembers = (membersResult.data ?? []) as TeamMember[];
    setMembers(nextMembers);
    if (isOwner) {
      const accessResult = await sb.from('agency_team_advertiser_access')
        .select('team_member_id,advertiser_id').eq('agency_id', workspaceId);
      if (accessResult.error) throw accessResult.error;
      const nextAssignments: Record<number, number[]> = {};
      for (const access of (accessResult.data ?? []) as Access[]) {
        nextAssignments[access.team_member_id] = [...(nextAssignments[access.team_member_id] ?? []), access.advertiser_id];
      }
      setAssignments(nextAssignments);
      setDraftAssignments(nextAssignments);
    }
  }, [workspaceId, isOwner]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    loadTeam()
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [loadTeam]);

  function inviteByPhone() {
    if (!workspaceId) return;
    c.run(async () => {
      setBusy(true);
      setError('');
      try {
        const result = await sb.rpc('invite_agency_team_member_by_phone', {
          p_agency_id: workspaceId,
          p_phone: phone.trim(),
          p_role: role,
        });
        if (result.error) throw result.error;
        setPhone('');
        await loadTeam();
        c.say(t('agency_team_invite_sent'));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t('agency_team_error'));
        throw reason;
      } finally {
        setBusy(false);
      }
    });
  }

  function createLink() {
    if (!workspaceId) return;
    c.run(async () => {
      setBusy(true);
      setError('');
      setShareUrl('');
      try {
        const result = await sb.rpc('create_agency_team_invite_link', {
          p_agency_id: workspaceId,
          p_role: role,
        });
        if (result.error) throw result.error;
        const url = new URL('/', window.location.origin);
        url.searchParams.set('team_invite', String(result.data));
        setShareUrl(url.toString());
        await loadTeam();
        c.say(t('agency_team_link_created'));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t('agency_team_error'));
        throw reason;
      } finally {
        setBusy(false);
      }
    });
  }

  function copyLink() {
    c.run(async () => {
      try {
        await navigator.clipboard.writeText(shareUrl);
        c.say(t('agency_team_link_copied'));
      } catch (reason) {
        setError(t('agency_team_copy_failed'));
        throw reason;
      }
    });
  }

  function changeRole(member: TeamMember, nextRole: 'admin' | 'member') {
    c.run(async () => {
      setSavingMemberId(member.id);
      setError('');
      try {
        const result = await sb.rpc('set_agency_team_member_role', {
          p_team_member_id: member.id,
          p_role: nextRole,
        });
        if (result.error) throw result.error;
        await loadTeam();
        c.say(t('agency_team_role_saved'));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t('agency_team_error'));
        throw reason;
      } finally {
        setSavingMemberId(null);
      }
    });
  }

  function removeMember(member: TeamMember) {
    if (!window.confirm(t('agency_team_remove_confirm'))) return;
    c.run(async () => {
      setSavingMemberId(member.id);
      setError('');
      try {
        const result = await sb.rpc('remove_agency_team_member', { p_team_member_id: member.id });
        if (result.error) throw result.error;
        await loadTeam();
        c.say(t('agency_team_removed'));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t('agency_team_error'));
        throw reason;
      } finally {
        setSavingMemberId(null);
      }
    });
  }

  function toggleAdvertiser(memberId: number, advertiserId: number) {
    setDraftAssignments((current) => {
      const selected = current[memberId] ?? [];
      return {
        ...current,
        [memberId]: selected.includes(advertiserId)
          ? selected.filter((id) => id !== advertiserId)
          : [...selected, advertiserId],
      };
    });
  }

  function saveAssignments(memberId: number) {
    c.run(async () => {
      setSavingMemberId(memberId);
      setError('');
      try {
        const result = await sb.rpc('set_agency_team_member_advertisers', {
          p_team_member_id: memberId,
          p_advertiser_ids: draftAssignments[memberId] ?? [],
        });
        if (result.error) throw result.error;
        await loadTeam();
        c.say(t('agency_team_assignments_saved'));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t('agency_team_error'));
        throw reason;
      } finally {
        setSavingMemberId(null);
      }
    });
  }

  return (
    <section className="card">
      <div className="dashboard-card-title"><h2>{t('agency_team_title')}</h2></div>
      <p className="m">{t(isOwner ? 'agency_team_owner_hint' : 'agency_team_admin_hint')}</p>
      <div className="grid2">
        <form onSubmit={(event) => { event.preventDefault(); inviteByPhone(); }}>
          <h3>{t('agency_team_invite_phone')}</h3>
          <label htmlFor="agency-team-phone">{t('phone')}</label>
          <input id="agency-team-phone" type="tel" inputMode="tel" placeholder="+228 90 00 00 00"
            value={phone} onChange={(event) => setPhone(event.target.value)} required />
          <label htmlFor="agency-team-phone-role">{t('agency_team_role')}</label>
          <select id="agency-team-phone-role" value={role} onChange={(event) => setRole(event.target.value as 'admin' | 'member')}>
            <option value="member">{t('agency_team_role_member')}</option>
            <option value="admin">{t('agency_team_role_admin')}</option>
          </select>
          <button className="s" type="submit" disabled={busy || !phone.trim()}>
            {busy ? '…' : t('agency_team_invite_send')}
          </button>
        </form>
        <div>
          <h3>{t('agency_team_invite_link')}</h3>
          <label htmlFor="agency-team-link-role">{t('agency_team_role')}</label>
          <select id="agency-team-link-role" value={role} onChange={(event) => setRole(event.target.value as 'admin' | 'member')}>
            <option value="member">{t('agency_team_role_member')}</option>
            <option value="admin">{t('agency_team_role_admin')}</option>
          </select>
          <button className="s" type="button" disabled={busy} onClick={createLink}>
            {busy ? '…' : t('agency_team_link_create')}
          </button>
          {shareUrl && (
            <div className="note">
              <p>{t('agency_team_link_expiry')}</p>
              <input aria-label={t('agency_team_invite_link')} readOnly value={shareUrl} />
              <div className="actions">
                <button className="p" type="button" onClick={copyLink}>{t('agency_team_link_copy')}</button>
                <a className="s" href={`https://wa.me/?text=${encodeURIComponent(shareUrl)}`}
                  target="_blank" rel="noopener noreferrer">{t('agency_team_link_whatsapp')}</a>
              </div>
            </div>
          )}
        </div>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      <h3>{t('agency_team_members')}</h3>
      {loading ? <p className="m">{t('agency_loading')}</p>
        : members.length === 0 ? <p className="m">{t('agency_team_empty')}</p>
          : <div className="agency-client-list">
            {members.map((member) => {
              const expired = member.status === 'pending' && new Date(member.expires_at).getTime() <= Date.now();
              const selected = draftAssignments[member.id] ?? [];
              return (
                <article className="card" key={member.id}>
                  <div className="row">
                    <div>
                      <b>{member.member_name || member.member_phone || t('agency_team_link_pending')}</b>
                      <span className="tag">{t(member.role === 'admin' ? 'agency_team_role_admin' : 'agency_team_role_member')}</span>
                      <span className="tag">{t(expired ? 'agency_team_expired' : `agency_team_status_${member.status}`)}</span>
                      {member.member_phone && <div className="m">{member.member_phone}</div>}
                    </div>
                    <div className="actions">
                      <select id={`agency-team-role-${member.id}`} value={member.role} disabled={savingMemberId === member.id}
                        aria-label={t('agency_team_role')}
                        onChange={(event) => changeRole(member, event.target.value as 'admin' | 'member')}>
                        <option value="member">{t('agency_team_role_member')}</option>
                        <option value="admin">{t('agency_team_role_admin')}</option>
                      </select>
                      <button className="s" type="button" disabled={savingMemberId === member.id}
                        onClick={() => removeMember(member)}>{t('agency_team_remove')}</button>
                    </div>
                  </div>
                  {isOwner && member.status === 'accepted' && clients.length > 0 && (
                    <div className="team-assignment">
                      <b>{t('agency_team_assign_clients')}</b>
                      {clients.filter((client) => client.status === 'managed' || client.status === 'linked').map((client) => (
                        <label key={client.id}>
                          <input type="checkbox" checked={selected.includes(client.id)}
                            onChange={() => toggleAdvertiser(member.id, client.id)} />
                          {client.name}
                        </label>
                      ))}
                      <button className="s on" type="button" disabled={savingMemberId === member.id
                        || JSON.stringify(selected.slice().sort()) === JSON.stringify((assignments[member.id] ?? []).slice().sort())}
                        onClick={() => saveAssignments(member.id)}>
                        {t('save')}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>}
    </section>
  );
}
