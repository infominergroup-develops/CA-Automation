/** Firestore collection names (one place, no stringly-typed typos) and the document shapes. */

export const C = {
  users: 'users',
  uniqueEmail: 'unique_user_email',
  uniqueMobile: 'unique_user_mobile',
  sessions: 'sessions',
  challenges: 'login_challenges',
  audit: 'audit_log',
  counters: 'counters',
  consents: 'consents',
  settings: 'settings',
  clientGroups: 'client_groups',
  companies: 'companies',
  documentCategories: 'document_categories',
  documents: 'documents',
  tasks: 'tasks',
  accessGrants: 'access_grants',
  timeEntries: 'time_entries',
  dpdpRequests: 'dpdp_requests',
  breachRegister: 'breach_register',
} as const;

export type Role = 'director' | 'manager' | 'employee' | 'client';

export interface ClientGroupDoc { id: string; name: string; created_at: string; created_by: string | null }

export interface CompanyDoc {
  id: string;
  group_id: string;
  legal_name: string;
  pan: string | null;
  gstin: string | null;
  tally_name: string | null;
  manager_id: string | null;
  created_at: string;
  created_by: string | null;
}

export interface UserDoc {
  id: string;
  role: Role;
  name: string;
  email: string | null;
  mobile: string | null;
  password_hash: string | null;
  status: 'active' | 'disabled';
  client_group_id: string | null;
  failed_logins: number;
  locked_until: string | null;
  monitoring_notice_ack_at: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
}

export interface SessionDoc {
  id: string; // = sha256(token)
  user_id: string;
  created_at: string;
  last_seen: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
}

export interface ChallengeDoc {
  id: string;
  user_id: string | null; // null for unknown identifiers (prevents account enumeration)
  code_hash: string;
  expires_at: string;
  attempts: number;
  used_at: string | null;
  ip: string | null;
  created_at: string;
}

export interface AuditDoc {
  seq: number;
  ts: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  company_id: string | null;
  ip: string | null;
  details: string | null; // JSON string, matching the SQLite shape
  prev_hash: string;
  hash: string;
}

export interface ConsentDoc {
  id: string;
  user_id: string;
  notice_version: string;
  purposes: string[];
  given_at: string;
  withdrawn_at: string | null;
  ip: string | null;
}

export type TaskStatus = 'requested' | 'assigned' | 'in_progress' | 'submitted' | 'rework' | 'approved' | 'cancelled';
export interface TaskDoc {
  id: string;
  company_id: string;
  type: string;
  title: string;
  period: string | null;
  instructions: string | null;
  assignee_id: string | null;
  reviewer_id: string | null;
  created_by: string;
  due_date: string | null;
  statutory_due: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: TaskStatus;
  estimate_hours: number | null;
  rework_count: number;
  submission_note: string | null;
  client_note: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
}

export interface TaskEventDoc {
  id: string;
  from_status: string | null;
  to_status: string;
  actor_id: string;
  comment: string | null;
  created_at: string;
}

export interface AccessGrantDoc {
  id: string;
  task_id: string;
  employee_id: string;
  company_id: string;
  category_ids: string[];
  reason: string;
  status: 'requested' | 'granted' | 'rejected' | 'revoked';
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface DpdpRequestDoc {
  id: string;
  user_id: string;
  type: 'access' | 'correction' | 'erasure' | 'grievance' | 'nomination' | 'withdraw_consent';
  details: string;
  status: 'open' | 'in_progress' | 'closed' | 'rejected';
  response: string | null;
  due_at: string;
  handled_by: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface BreachDoc {
  id: string;
  detected_at: string;
  description: string;
  data_affected: string;
  principals_affected: number | null;
  board_intimated_at: string | null;
  principals_notified_at: string | null;
  status: 'open' | 'contained' | 'closed';
  created_by: string;
  created_at: string;
}

export interface TimeEntryDoc {
  id: string;
  user_id: string;
  task_id: string | null;
  category: string | null;
  started_at: string;
  ended_at: string | null;
  last_heartbeat: string | null;
  idle_seconds: number;
  source: 'timer' | 'manual';
  note: string | null;
  status: 'ok' | 'pending_approval' | 'rejected';
  approved_by: string | null;
  created_at: string;
}
