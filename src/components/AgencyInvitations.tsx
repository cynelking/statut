'use client';
import { useCallback, useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n';
import { Ctx } from '@/lib/types';

interface AgencyInvitation {
  id: number;
  agency_name: string;
  name: string;
  created_at: string;
}

interface TeamInvitation {
  id: number;
  agency_id: string;
  agency_name: string;
  role: 'admin' | 'member';
  expires_at: string;
}

export default function AgencyInvitations({ c }: { c: Ctx }) {
  const { t } = useI18n();
  const [invitations, setInvitations] = useState<AgencyInvitation[]>([]);
  const [teamInvitations, setTeamInvitations] = useState<TeamInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadInvitations = useCallback(async () => {
    const [advertisers, team] = await Promise.all([
      sb.from('agency_advertisers').select('id,agency_name,name,created_at')
        .eq('linked_user_id', c.user.id).eq('status', 'pending').order('created_at', { ascending: true }),
      sb.from('agency_team_members').select('id,agency_id,agency_name,role,expires_at')
        .eq('user_id', c.user.id).eq('status', 'pending').gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: true }),
    ]);
    if (advertisers.error) throw advertisers.error;
    if (team.error) throw team.error;
    setInvitations((advertisers.data ?? []) as AgencyInvitation[]);
    setTeamInvitations((team.data ?? []) as TeamInvitation[]);
  }, [c.user.id]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadInvitations()
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [loadInvitations]);

  function respond(id: number, accept: boolean) {
    c.run(async () => {
      setWorkingId(`advertiser-${id}`);
      setError('');
      try {
        const result = await sb.rpc('respond_agency_invitation', {
          p_invitation_id: id,
          p_accept: accept,
        });
        if (result.error) throw result.error;
        setInvitations((current) => current.filter((invitation) => invitation.id !== id));
        c.say(t(accept ? 'agency_invitation_accepted' : 'agency_invitation_declined'));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t('agency_invitation_error'));
        throw reason;
      } finally {
        setWorkingId(null);
      }
    });
  }

  function respondToTeam(id: number, agencyId: string, accept: boolean) {
    c.run(async () => {
      setWorkingId(`team-${id}`);
      setError('');
      try {
        const result = await sb.rpc('respond_agency_team_invitation', {
          p_invitation_id: id,
          p_accept: accept,
        });
        if (result.error) throw result.error;
        setTeamInvitations((current) => current.filter((invitation) => invitation.id !== id));
        if (accept) {
          await c.reload();
          c.selectAgencyWorkspace(agencyId);
          c.go('g');
        }
        c.say(t(accept ? 'agency_team_joined' : 'agency_invitation_declined'));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t('agency_invitation_error'));
        throw reason;
      } finally {
        setWorkingId(null);
      }
    });
  }

  if (loading || (invitations.length === 0 && teamInvitations.length === 0 && !error)) return null;

  return (
    <section className="card" aria-labelledby="agency-invitations-title">
      <h2 id="agency-invitations-title">{t('agency_invitation')}</h2>
      {error && <p className="err" role="alert">{error}</p>}
      {invitations.map((invitation) => (
        <div className="row" key={invitation.id}>
          <div>
            <b>{invitation.agency_name}</b> {t('agency_invited_by')}
            <p className="m">{t('agency_invitation_note')}</p>
          </div>
          <div className="actions">
            <button type="button" className="p" disabled={workingId !== null} onClick={() => respond(invitation.id, true)}>
              {workingId === `advertiser-${invitation.id}` ? '…' : t('agency_accept')}
            </button>
            <button type="button" className="s" disabled={workingId !== null} onClick={() => respond(invitation.id, false)}>
              {t('agency_decline')}
            </button>
          </div>
        </div>
      ))}
      {teamInvitations.map((invitation) => (
        <div className="row" key={`team-${invitation.id}`}>
          <div>
            <b>{invitation.agency_name}</b> {t('agency_team_invited')}
            <p className="m">{t(invitation.role === 'admin' ? 'agency_team_role_admin' : 'agency_team_role_member')}</p>
          </div>
          <div className="actions">
            <button type="button" className="p" disabled={workingId !== null}
              onClick={() => respondToTeam(invitation.id, invitation.agency_id, true)}>
              {workingId === `team-${invitation.id}` ? '…' : t('agency_accept')}
            </button>
            <button type="button" className="s" disabled={workingId !== null}
              onClick={() => respondToTeam(invitation.id, invitation.agency_id, false)}>
              {t('agency_decline')}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
