import { useEffect, useState } from "react";
import { api, type Invitation, type Member } from "../api.ts";
import { $members } from "../stores.ts";

export function MembersSettings({ workspaceId }: { workspaceId: string }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invitation[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [membersError, setMembersError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMembers(null); setMembersError(false);
    api.members(workspaceId)
      .then((r) => { if (!cancelled) setMembers(r.members); })
      .catch(() => { if (!cancelled) { setMembers([]); setMembersError(true); } });
    return () => { cancelled = true; };
  }, [workspaceId]);
  useEffect(() => {
    let cancelled = false;
    setInvites(null);
    api.invitations(workspaceId)
      .then((r) => { if (!cancelled) setInvites(r.invitations); })
      .catch(() => { if (!cancelled) setInvites([]); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const inviteUrl = (code: string) => `${window.location.origin}/?invite=${code}`;

  const copyLink = async (inv: Invitation) => {
    try {
      await navigator.clipboard.writeText(inviteUrl(inv.code));
      setCopiedId(inv.id);
      setTimeout(() => setCopiedId((c) => (c === inv.id ? null : c)), 2000);
    } catch { /* clipboard unavailable */ }
  };

  const generate = async () => {
    setCreating(true);
    try {
      const inv = await api.createInvitation(workspaceId);
      setInvites((cur) => [inv, ...(cur ?? [])]);
      await copyLink(inv);
    } finally { setCreating(false); }
  };

  const revoke = async (inv: Invitation) => {
    await api.revokeInvitation(workspaceId, inv.id);
    setInvites((cur) => (cur ?? []).filter((i) => i.id !== inv.id));
  };

  const setNonEngineer = async (member: Member, nonEngineer: boolean) => {
    setMembers((cur) => cur?.map((m) => m.userId === member.userId ? { ...m, nonEngineer } : m) ?? cur);
    $members.set($members.get().map((m) => m.userId === member.userId ? { ...m, nonEngineer } : m));
    try {
      await api.setMemberNonEngineer(workspaceId, member.userId, nonEngineer);
    } catch {
      setMembers((cur) => cur?.map((m) => m.userId === member.userId ? { ...m, nonEngineer: member.nonEngineer } : m) ?? cur);
      $members.set($members.get().map((m) => m.userId === member.userId ? { ...m, nonEngineer: member.nonEngineer } : m));
    }
  };

  return (
    <>
      <h2>Members</h2>
      {members === null && <p className="muted small">Loading…</p>}
      {membersError && <p className="muted small">Couldn't load members. Reload to try again.</p>}
      {members && !membersError && members.length === 0 && (
        <div className="members-empty muted small">No members yet.</div>
      )}
      {members && !membersError && members.length > 0 && (
        <p className="muted small member-engineer-note">
          Non-Engineer PRs will request a review from a relevant engineer.
        </p>
      )}
      {members?.map((m) => (
        <div key={m.userId} className="member-row">
          <div className="member-avatar">{(m.name ?? m.email)[0]?.toUpperCase()}</div>
          <div className="member-info">
            <div className="member-name">{m.name ?? m.email}</div>
            {m.name && <div className="muted small">{m.email}</div>}
          </div>
          <div className="member-engineer-control">
            <select
              value={m.nonEngineer ? "non-engineer" : "engineer"}
              onChange={(e) => void setNonEngineer(m, e.currentTarget.value === "non-engineer")}
              aria-label="Engineering role"
            >
              <option value="engineer">Engineer</option>
              <option value="non-engineer">Non-Engineer</option>
            </select>
          </div>
          <div className="muted small member-role">{m.role}</div>
        </div>
      ))}

      <div className="invite-section">
        <div className="invite-head">
          <h3>Invite links</h3>
          <button className="btn primary" onClick={() => void generate()} disabled={creating}>
            {creating ? "Generating…" : "+ New invite link"}
          </button>
        </div>
        <p className="s-hint">Share a link to let people join this workspace. Links expire in 14 days.</p>
        {invites === null && <p className="muted small">Loading…</p>}
        {invites && invites.length === 0 && (
          <div className="invite-empty">
            <div className="invite-empty-icon">🔗</div>
            <div className="invite-empty-title">No active invite links</div>
            <div className="muted small">Generate a link and share it to add teammates.</div>
            <button className="btn" onClick={() => void generate()} disabled={creating}>
              {creating ? "Generating…" : "Create your first invite link"}
            </button>
          </div>
        )}
        {invites && invites.map((inv) => (
          <div key={inv.id} className="invite-row">
            <code className="invite-code">{inviteUrl(inv.code)}</code>
            <div className="invite-actions">
              <button className="btn ghost small" onClick={() => void copyLink(inv)}>
                {copiedId === inv.id ? "Copied ✓" : "Copy"}
              </button>
              <button className="btn ghost small" onClick={() => void revoke(inv)}>Revoke</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
