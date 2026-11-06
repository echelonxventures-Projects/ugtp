import { ApiError, audit, newId, now, type AuthContext, type Env } from './core';

/**
 * Agent hierarchy. Relationships are tenant-scoped, acyclic and depth-bounded.
 * Permissions are never inherited implicitly from a parent: an agent can only
 * act through explicitly granted permissions.
 */

const MAX_DEPTH = 5;

export async function createAgent(
  env: Env,
  auth: AuthContext,
  input: {
    parentId?: string | null;
    code: string;
    name: string;
    agentType: 'master' | 'regional' | 'sub' | 'distributor' | 'franchise';
    territory?: string;
    permissions?: string[];
    creditLimitMinor?: number;
  },
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  if (input.parentId) await validateParent(env, tenantId, null, input.parentId);
  const id = newId('agt');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agents (id, tenant_id, parent_id, code, name, agent_type, status, territory, permissions_json, credit_limit_minor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).bind(
      id,
      tenantId,
      input.parentId ?? null,
      input.code,
      input.name,
      input.agentType,
      input.territory ?? null,
      JSON.stringify(input.permissions ?? []),
      input.creditLimitMinor ?? 0,
      now(),
    ),
    audit(env, auth, 'agent.created', 'agent', id, { parentId: input.parentId ?? null, type: input.agentType }),
  ]);
  return { id, ...input };
}

async function chain(env: Env, tenantId: string, startId: string): Promise<string[]> {
  const ids: string[] = [];
  let current: string | null = startId;
  for (let depth = 0; depth < MAX_DEPTH + 1 && current; depth++) {
    if (ids.includes(current)) throw new ApiError(409, 'HIERARCHY_CYCLE', 'Agent hierarchy contains a cycle');
    ids.push(current);
    const row: { parent_id: string | null } | null = await env.DB.prepare(
      'SELECT parent_id FROM agents WHERE id = ? AND tenant_id = ?',
    )
      .bind(current, tenantId)
      .first<{ parent_id: string | null }>();
    if (!row) throw new ApiError(400, 'AGENT_INVALID', 'Agent does not belong to this tenant');
    current = row.parent_id;
  }
  if (ids.length > MAX_DEPTH) {
    throw new ApiError(409, 'HIERARCHY_DEPTH', `Agent hierarchy depth cannot exceed ${MAX_DEPTH}`);
  }
  return ids;
}

async function validateParent(env: Env, tenantId: string, agentId: string | null, parentId: string): Promise<void> {
  if (agentId && parentId === agentId) throw new ApiError(409, 'HIERARCHY_SELF_PARENT', 'An agent cannot be its own parent');
  const parent = await env.DB.prepare('SELECT id, status FROM agents WHERE id = ? AND tenant_id = ?')
    .bind(parentId, tenantId)
    .first<{ id: string; status: string }>();
  if (!parent) throw new ApiError(400, 'AGENT_INVALID', 'Parent agent does not belong to this tenant');
  if (parent.status === 'terminated') throw new ApiError(409, 'AGENT_TERMINATED', 'Parent agent is terminated');
  const parentsChain = await chain(env, tenantId, parentId);
  if (agentId && parentsChain.includes(agentId)) {
    throw new ApiError(409, 'HIERARCHY_CYCLE', 'This parent would create a cycle in the agent hierarchy');
  }
  if (parentsChain.length >= MAX_DEPTH) {
    throw new ApiError(409, 'HIERARCHY_DEPTH', `Agent hierarchy depth cannot exceed ${MAX_DEPTH}`);
  }
}

export async function setAgentParent(env: Env, auth: AuthContext, agentId: string, parentId: string | null) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const agent = await env.DB.prepare('SELECT id, status FROM agents WHERE id = ? AND tenant_id = ?')
    .bind(agentId, tenantId)
    .first<{ id: string; status: string }>();
  if (!agent) throw new ApiError(404, 'AGENT_NOT_FOUND', 'Agent not found');
  if (parentId) await validateParent(env, tenantId, agentId, parentId);
  await env.DB.batch([
    env.DB.prepare('UPDATE agents SET parent_id = ? WHERE id = ? AND tenant_id = ?').bind(parentId, agentId, tenantId),
    audit(env, auth, 'agent.parent_changed', 'agent', agentId, { parentId }),
  ]);
  return listAgents(env, tenantId);
}

export async function setAgentStatus(
  env: Env,
  auth: AuthContext,
  agentId: string,
  status: 'active' | 'suspended' | 'terminated',
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  await env.DB.batch([
    env.DB.prepare('UPDATE agents SET status = ? WHERE id = ? AND tenant_id = ?').bind(status, agentId, tenantId),
    audit(env, auth, 'agent.status_changed', 'agent', agentId, { status }),
  ]);
  return listAgents(env, tenantId);
}

export async function listAgents(env: Env, tenantId: string) {
  const rows = await env.DB.prepare(
    `SELECT a.id, a.parent_id, a.code, a.name, a.agent_type, a.status, a.territory, a.credit_limit_minor, a.created_at,
            p.name AS parent_name,
            (SELECT COUNT(*) FROM players pl WHERE pl.agent_id = a.id) AS players,
            COALESCE((SELECT SUM(CASE WHEN e.kind = 'draw' THEN e.amount_minor ELSE -e.amount_minor END)
                      FROM credit_events e JOIN credit_facilities f ON f.id = e.facility_id
                      WHERE f.tenant_id = a.tenant_id AND f.subject_type = 'agent' AND f.subject_id = a.id AND e.status = 'posted'), 0) AS credit_outstanding_minor
     FROM agents a LEFT JOIN agents p ON p.id = a.parent_id
     WHERE a.tenant_id = ? ORDER BY a.created_at`,
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export async function assignPlayer(
  env: Env,
  auth: AuthContext,
  agentId: string | null,
  playerId: string,
) {
  const tenantId = auth.tenantId;
  if (!tenantId) throw new ApiError(403, 'TENANT_REQUIRED', 'Tenant context required');
  const player = await env.DB.prepare('SELECT id FROM players WHERE id = ? AND tenant_id = ?')
    .bind(playerId, tenantId)
    .first<{ id: string }>();
  if (!player) throw new ApiError(404, 'PLAYER_NOT_FOUND', 'Player not found in this tenant');
  if (agentId) {
    const agent = await env.DB.prepare(`SELECT id FROM agents WHERE id = ? AND tenant_id = ? AND status = 'active'`)
      .bind(agentId, tenantId)
      .first<{ id: string }>();
    if (!agent) throw new ApiError(400, 'AGENT_INVALID', 'Agent is not active in this tenant');
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE players SET agent_id = ? WHERE id = ? AND tenant_id = ?').bind(agentId, playerId, tenantId),
    audit(env, auth, 'player.agent_assigned', 'player', playerId, { agentId }),
  ]);
  return { playerId, agentId };
}
