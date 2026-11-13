import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Employee, Project, Task, AgentRun, TestRun, Approval, Incident, AuditEvent, Monitor, SkillDraft, SkillVersion, SkillAssignment, SkillReview, SkillAvailability, ExecutionCheck, AppModelSelection, EmployeeModelPreference, ModelApiTest } from '../shared/types.js';

export interface Records {
  employees: Employee; projects: Project; tasks: Task; runs: AgentRun;
  tests: TestRun; approvals: Approval; incidents: Incident; audit: AuditEvent; monitors: Monitor;
  skillDrafts: SkillDraft; skillVersions: SkillVersion; skillAssignments: SkillAssignment;
  skillReviews: SkillReview; skillAvailability: SkillAvailability; executionChecks: ExecutionCheck; modelSelections: AppModelSelection;
  employeeModelPreferences: EmployeeModelPreference; modelApiTests: ModelApiTest;
}
export interface UserRow { id: string; username: string; password_hash: string; salt: string; created_at: string; }
export interface SessionRow { id_hash: string; user_id: string; csrf: string; expires_at: string; }
export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const tables = new Set<keyof Records>(['employees', 'projects', 'tasks', 'runs', 'tests', 'approvals', 'incidents', 'audit', 'monitors', 'skillDrafts', 'skillVersions', 'skillAssignments', 'skillReviews', 'skillAvailability', 'executionChecks', 'modelSelections', 'employeeModelPreferences', 'modelApiTests']);
const immutableTables = new Set<keyof Records>(['skillVersions', 'skillReviews']);

export class Store {
  readonly sql: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        body TEXT NOT NULL CHECK(json_valid(body)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS records_updated ON records(collection, updated_at DESC);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        csrf TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job_per_task ON jobs(task_id)
        WHERE status IN ('queued', 'running');
      CREATE TABLE IF NOT EXISTS agent_sessions (
        employee_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace TEXT NOT NULL,
        session_id TEXT NOT NULL, PRIMARY KEY(employee_id, project_id, workspace)
      );
    `);
    this.transaction(() => {
      const columns = this.sql.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'context_fingerprint')) this.sql.exec("ALTER TABLE agent_sessions ADD COLUMN context_fingerprint TEXT NOT NULL DEFAULT ''");
      this.sql.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS skill_version_number ON records(json_extract(body,'$.skillId'),json_extract(body,'$.version')) WHERE collection='skillVersions';
        CREATE UNIQUE INDEX IF NOT EXISTS skill_version_draft ON records(json_extract(body,'$.draftId')) WHERE collection='skillVersions';
        CREATE UNIQUE INDEX IF NOT EXISTS skill_draft_dedupe ON records(json_extract(body,'$.dedupeKey')) WHERE collection='skillDrafts';
        CREATE UNIQUE INDEX IF NOT EXISTS skill_employee_version ON records(json_extract(body,'$.employeeId'),json_extract(body,'$.versionId')) WHERE collection='skillAssignments';
        CREATE TRIGGER IF NOT EXISTS skill_immutable_update BEFORE UPDATE ON records
          WHEN OLD.collection IN ('skillVersions','skillReviews') OR NEW.collection IN ('skillVersions','skillReviews')
          BEGIN SELECT RAISE(ABORT,'Published skill versions and reviews are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS skill_immutable_delete BEFORE DELETE ON records
          WHEN OLD.collection IN ('skillVersions','skillReviews')
          BEGIN SELECT RAISE(ABORT,'Published skill versions and reviews cannot be deleted'); END;
      `);
      const version = (this.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version < 2) this.sql.exec('PRAGMA user_version=2');
    });
  }
  private table(name: keyof Records) { if (!tables.has(name)) throw new Error('无效数据集合'); return name; }
  all<K extends keyof Records>(name: K): Records[K][] {
    return (this.sql.prepare('SELECT body FROM records WHERE collection=? ORDER BY updated_at DESC, id').all(this.table(name)) as { body: string }[]).map(row => JSON.parse(row.body));
  }
  get<K extends keyof Records>(name: K, recordId: string): Records[K] | null {
    const row = this.sql.prepare('SELECT body FROM records WHERE collection=? AND id=?').get(this.table(name), recordId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  put<K extends keyof Records>(name: K, value: Records[K]): Records[K] {
    if (immutableTables.has(name)) return this.insert(name, value);
    this.sql.prepare('INSERT INTO records(collection,id,body,updated_at) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at').run(this.table(name), value.id, JSON.stringify(value), now());
    return value;
  }
  insert<K extends keyof Records>(name: K, value: Records[K]): Records[K] {
    this.sql.prepare('INSERT INTO records(collection,id,body,updated_at) VALUES(?,?,?,?)').run(this.table(name), value.id, JSON.stringify(value), now());
    return value;
  }
  remove<K extends keyof Records>(name: K, recordId: string): void {
    if (immutableTables.has(name)) throw new Error('正式技能版本与审核记录不能删除');
    this.sql.prepare('DELETE FROM records WHERE collection=? AND id=?').run(this.table(name), recordId);
  }
  transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.sql.exec('COMMIT'); return result; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  audit(actor: string, action: string, targetId: string | null, detail: string) {
    this.put('audit', { id: id('evt'), actor, action, targetId, detail, createdAt: now() });
  }
  sessionFor(employeeId: string, projectId: string, workspace: string, fingerprint = ''): string | undefined {
    const row = this.sql.prepare('SELECT session_id FROM agent_sessions WHERE employee_id=? AND project_id=? AND workspace=? AND context_fingerprint=?').get(employeeId, projectId, workspace, fingerprint) as { session_id: string } | undefined;
    return row?.session_id;
  }
  saveSession(employeeId: string, projectId: string, workspace: string, sessionId: string, fingerprint = '') {
    this.sql.prepare('INSERT INTO agent_sessions(employee_id,project_id,workspace,session_id,context_fingerprint) VALUES(?,?,?,?,?) ON CONFLICT(employee_id,project_id,workspace) DO UPDATE SET session_id=excluded.session_id,context_fingerprint=excluded.context_fingerprint').run(employeeId, projectId, workspace, sessionId, fingerprint);
  }
  close() { this.sql.close(); }
}
