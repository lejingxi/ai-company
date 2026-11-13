export type Role = 'director' | 'lead' | 'developer' | 'qa' | 'ops';
export type TaskStatus = 'draft' | 'planning' | 'assigned' | 'developing' | 'awaiting_test' | 'testing' | 'changes_requested' | 'awaiting_merge' | 'awaiting_release' | 'release_authorized' | 'monitoring' | 'closed' | 'blocked' | 'cancelled';
export type RunMode = 'simulation' | 'zcode';
export type Stage = 'planning' | 'development' | 'qa' | 'ops';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Employee {
  id: string; name: string; role: Role; duties: string; reportsTo: string | null;
  projectIds: string[]; enabled: boolean; createdAt: string;
}
export interface Project {
  id: string; name: string; description: string; workspace: string; leadId: string | null;
  stack: string; testCommand: string[]; dockerImage: string; createdAt: string;
}
export interface Task {
  id: string; title: string; goal: string; projectId: string; leaderId: string;
  developerId: string; qaId: string; status: TaskStatus; mode: RunMode | null;
  version: number; contentHash: string | null; plan: string | null;
  blockedReason: string | null; createdAt: string; updatedAt: string;
  batchId?: string | null;
  modelBinding?: ModelBinding | null;
  participantModelBindings?: Record<string, EffectiveModelBinding>;
}
export interface AgentRun {
  id: string; taskId: string; employeeId: string; stage: Stage; mode: RunMode;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'; sessionId: string | null;
  startedAt: string; endedAt: string | null; exitCode: number | null;
  output: string; error: string | null;
  taskVersion?: number; batchId?: string; projectId?: string;
  outputTruncated?: boolean; applicationStatus?: 'not_applicable' | 'pending' | 'applied' | 'rejected' | 'unknown';
  learningProposals?: LearningProposal[]; skillsUsed?: SkillUsage[]; contextFingerprint?: string;
  learningCaptureStatus?: 'pending' | 'saved' | 'failed';
  executionMetadata?: { environmentMode: 'existing-user'; verificationFingerprint: string; observedTools: string[]; model: string | null };
  connectionCheckId?: string;
  modelBinding?: ModelBinding;
}
export interface TestRun {
  id: string; taskId: string; reviewerId: string; mode: RunMode;
  status: 'passed' | 'failed' | 'blocked'; exitCode: number | null; image: string;
  imageDigest: string | null; command: string[]; log: string; contentHash: string;
  createdAt: string; durationMs: number;
  taskVersion?: number; batchId?: string; agentRunId?: string;
}
export interface Approval {
  id: string; taskId: string; kind: 'merge' | 'release'; userId: string;
  taskVersion: number; contentHash: string; decision: 'approved' | 'rejected';
  note: string; createdAt: string;
}
export interface Incident {
  id: string; projectId: string; title: string; severity: 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved'; detail: string; createdAt: string;
}
export interface AuditEvent {
  id: string; actor: string; action: string; targetId: string | null;
  detail: string; createdAt: string;
}
export interface Monitor {
  id: string; projectId: string; url: string; enabled: boolean; intervalSeconds: number;
  lastCheckedAt: string | null; lastStatus: 'healthy' | 'failed' | 'unknown'; detail: string;
}
export interface Capability {
  ready: boolean; reason: string;
}
export interface ExecutionCheck {
  id: string; target: 'zcode' | 'docker'; status: 'checking' | 'ready' | 'blocked' | 'revoked';
  environmentMode: 'existing-user'; policyVersion: string; fingerprint: string | null;
  checkedAt: string; expiresAt: string | null; checkedBy: string; processInstanceId: string;
  projectId: string | null; taskId: string | null; image: string | null; imageDigest: string | null;
  result: string; model: string | null; observedTools: string[]; sessionId: string | null;
  modelBinding?: ModelBinding;
  employeeId?: string | null;
}
export interface ExecutionStatus {
  environmentMode: 'existing-user'; warning: string; checking: boolean;
  zcode: Capability; docker: Capability; zcodeCheck: ExecutionCheck | null; dockerCheck: ExecutionCheck | null;
  projects: { id: string; name: string; image: string; ready: boolean; reason: string }[];
  modelSelection?: AppModelSelection | null;
  modelBindingSupport?: Capability;
}
export interface Capabilities {
  zcode: Capability; docker: Capability; realExecution: Capability;
  mergeExecution: Capability; releaseExecution: Capability;
}
export interface Dashboard {
  employees: Employee[]; projects: Project[]; tasks: Task[]; runs: AgentRun[];
  tests: TestRun[]; approvals: Approval[]; incidents: Incident[];
  audit: AuditEvent[]; monitors: Monitor[]; capabilities: Capabilities;
  appVersion: string;
  skillDrafts: SkillDraft[]; skillVersions: SkillVersion[];
  skillAssignments: SkillAssignment[]; skillReviews: SkillReview[]; skillAvailability: SkillAvailability[];
  employeeModels?: EmployeeModelState[];
}
export interface AuthState {
  setupRequired: boolean; user: { id: string; username: string } | null; csrfToken?: string;
}
export interface FileChange { path: string; content: string; }
export interface AgentOutput {
  summary: string; files: FileChange[]; verdict?: 'passed' | 'failed';
  acceptanceCriteria?: string[]; sessionId?: string; raw?: string;
  learningProposals?: LearningProposal[];
  executionMetadata?: { environmentMode: 'existing-user'; verificationFingerprint: string; observedTools: string[]; model: string | null };
}
export interface RunnerInput {
  employee: Employee; task: Task; project: Project; stage: Stage; workspace: string;
  prompt: string; sessionId?: string; signal: AbortSignal;
}
export interface TestResult {
  status: 'passed' | 'failed' | 'blocked'; exitCode: number | null; log: string;
  image: string; imageDigest: string | null; command: string[]; durationMs: number;
}

export interface SkillContent {
  title: string; purpose: string; conditions: string; steps: string[];
  cautions: string[]; verification: string; tags: string[];
}
export type LearningProposal = SkillContent;
export type SkillUsePolicy = 'simulation_only' | 'manual_unverified' | 'task_observation';
export interface SkillSource {
  kind: 'manual' | 'task'; taskId: string | null; taskVersion: number | null;
  batchId: string | null; employeeId: string | null; projectId: string | null;
  runId: string | null; testIds: string[]; stage: Stage | null; mode: RunMode | null;
  outcome: 'manual' | 'passed' | 'failed' | 'blocked' | 'cancelled' | 'interrupted' | 'unknown';
  evidenceHash: string; limitations: string[];
}
export interface SkillDraft {
  id: string; skillId: string; baseVersionId: string | null;
  content: SkillContent; roles: Role[]; projectIds: string[];
  status: 'draft' | 'rejected' | 'published'; revision: number; contentHash: string;
  source: SkillSource; usePolicy: SkillUsePolicy; dedupeKey: string;
  rejectionReason: string | null; publishedVersionId: string | null;
  createdBy: string; createdAt: string; updatedAt: string;
}
export interface SkillVersion {
  id: string; skillId: string; version: number; draftId: string; baseVersionId: string | null;
  content: SkillContent; roles: Role[]; projectIds: string[];
  source: SkillSource; usePolicy: SkillUsePolicy; contentHash: string;
  publishedBy: string; publishedAt: string;
}
export interface SkillAssignment {
  id: string; employeeId: string; versionId: string; projectIds: string[];
  assignedBy: string; assignedAt: string;
}
export interface SkillReview {
  id: string; draftId: string; revision: number; contentHash: string;
  action: 'publish' | 'reject'; userId: string; note: string;
  versionId: string | null; createdAt: string;
}
export interface SkillAvailability {
  id: string; versionId: string; enabled: boolean; updatedBy: string; updatedAt: string;
}
export interface SkillUsage {
  versionId: string; skillId: string; version: number; title: string;
  contentHash: string; usePolicy: SkillUsePolicy;
}
export interface SkillCatalog {
  drafts: SkillDraft[]; versions: SkillVersion[]; assignments: SkillAssignment[];
  reviews: SkillReview[]; availability: SkillAvailability[];
}
export interface SkillDetail {
  draft: SkillDraft | null; version: SkillVersion | null; baseVersion: SkillVersion | null;
  reviews: SkillReview[]; run: AgentRun | null; tests: TestRun[]; warnings: string[];
}

export interface ModelRef { providerId: string; modelId: string; }
export interface ConfiguredModel extends ModelRef {
  id: string; providerLabel: string; label: string; enabled: boolean;
  availabilityConfigured: boolean; reasoningLevels: string[];
  reasoningDefault?: string | null; reasoningSource?: 'personal' | 'builtin' | 'unknown' | 'unsupported';
  reasoningSupport?: 'supported' | 'unsupported' | 'unknown';
  source: 'personal-config'; executionSupport: 'session-adapter' | 'unsupported'; reason: string;
}
export interface ModelCatalog {
  models: ConfiguredModel[]; source: 'zcode-personal-config'; coverage: 'partial' | 'unavailable';
  reason: string; catalogRevision: string | null; configuredDefault: ModelRef | null;
  refreshedAt: string;
}
export interface ModelBinding extends ModelRef {
  catalogId: string; reasoningLevel: string | null; selectionRevision: number;
  catalogRevision: string; selectionFingerprint: string;
}
export interface EffectiveModelBinding extends ModelBinding { source: 'app-default' | 'employee-override'; employeeId: string; }
export interface EmployeeModelPreference {
  id: string; employeeId: string; mode: 'inherit-app' | 'override'; revision: number; binding: ModelBinding | null;
  updatedBy: string; updatedAt: string;
}
export interface AppModelSelection extends ModelBinding {
  id: 'app-default'; providerLabel: string; label: string; updatedAt: string; updatedBy: string;
}
export interface ModelCatalogState {
  catalog: ModelCatalog; selection: AppModelSelection | null;
  selectionRevision: number; selectionStatus: 'unset' | 'configured' | 'stale';
  bindingSupport: Capability;
}
export interface EmployeeModelState {
  employeeId: string; mode: 'inherit-app' | 'override'; preferenceRevision: number;
  selection: ModelBinding | null; effectiveBinding: EffectiveModelBinding | null;
  effectiveStatus: 'unset' | 'configured' | 'stale'; reason: string;
  catalog: ModelCatalog; effectiveReasoning: string | null;
}
export interface ModelApiTest {
  id: string; requestId: string; scope: 'app' | 'employee'; employeeId: string | null;
  binding: ModelBinding; effectiveReasoning: string | null;
  status: 'running' | 'passed' | 'failed' | 'cancelled' | 'stale';
  code: string; message: string; durationMs: number | null;
  startedAt: string; endedAt: string | null; userId: string;
  reasoningHonored: 'not-confirmed' | 'reported';
}
export interface ModelApiTestState { active: boolean; latest: ModelApiTest | null; }
