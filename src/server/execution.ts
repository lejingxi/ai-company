import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store, id, now } from './db.js';
import { AppError } from './policy.js';
import type { AppConfig } from './config.js';
import type { Capability, ExecutionCheck, ExecutionStatus, Project, ModelBinding, Employee, Task } from '../shared/types.js';
import { ModelCatalogService } from './model-catalog.js';
import { runProcess } from './runners/process.js';
import { fingerprintCurrentZcode, redactRunDiagnostic, ZcodeRunner, type ZcodeOptions, type ZcodeTransport } from './runners/zcode.js';
import { ZcodeSessionTransport } from './runners/zcode-session.js';
import { WorkspaceManager } from './runners/workspace.js';
import { runDockerTests } from './runners/docker.js';

const POLICY = 'selected-model-zcode-v2';
const WARNING = '复用本机 ZCode 账号与全局配置；当前用户受控进程，不是操作系统沙箱。未证明全部插件可用，不允许操作其他项目或生产环境。';
const TTL = 30 * 60_000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function diagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/1113|余额不足|无可用资源包/.test(raw)) return 'ZCode CLI 当前模型服务返回 1113：余额不足或无可用资源包。请在 ZCode 中确认默认服务与额度；不会自动切换模型或重试扣费。';
  if (/401|unauthorized|authentication|登录|未认证/i.test(raw)) return '现有 ZCode 认证未通过，请在原客户端检查账号。CLI 默认模型可能与桌面会话不同。';
  return redactRunDiagnostic(raw).split('\n').slice(0, 3).join('\n').slice(0, 1200);
}
function testProject(workspace: string, projectId: string, image: string): Project {
  return { id: projectId, name: '接入检查专用项目', description: '自动生成，仅用于显式连接验证，不是业务项目', workspace, leadId: null, stack: 'node', testCommand: ['node', '--test', 'tests'], dockerImage: image, createdAt: now() };
}

export class Execution {
  readonly instanceId = randomUUID();
  readonly models: ModelCatalogService;
  readonly zcodeTransport: ZcodeTransport;
  private active: { checkId: string; controller: AbortController; promise: Promise<void> } | null = null;
  private probes: WorkspaceManager;
  constructor(readonly store: Store, readonly config: AppConfig) {
    this.probes = new WorkspaceManager(path.join(config.dataDir, 'connection-checks'));
    const personalConfigPath = config.modelCatalogPath ?? path.join(config.dataDir, 'model-config-not-provisioned.json');
    const builtinConfigPath = config.builtinModelConfigPath ?? path.resolve(path.dirname(config.zcode.cliPath), '../config/provider/zcode-builtin.json');
    this.zcodeTransport = new ZcodeSessionTransport({
      electronPath: config.zcode.electronPath, cliPath: config.zcode.cliPath,
      personalConfigPath, builtinConfigPath, cliConfigPath: path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.zcode', 'cli', 'config.json'), timeoutMs: config.zcode.timeoutMs,
    });
    this.models = new ModelCatalogService(store, { configPath: personalConfigPath, builtinConfigPath, bindingSupport: binding => this.zcodeTransport.supports(binding) });
    for (const check of store.all('executionChecks').filter(item => item.status === 'checking')) store.put('executionChecks', { ...check, status: 'blocked', result: '服务重启中断检查，请重新显式验证', expiresAt: null });
  }
  private latest(target: 'zcode' | 'docker', projectId: string | null = null, employeeId: string | null = null) {
    return this.store.all('executionChecks').filter(check => check.target === target && (target === 'zcode' ? (check.employeeId ?? null) === employeeId : check.projectId === projectId)).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0] ?? null;
  }
  private resolveBinding(expected?: ModelBinding, employeeId?: string | null): ModelBinding {
    const owner = employeeId ?? (expected && 'employeeId' in expected && typeof expected.employeeId === 'string' ? expected.employeeId : null);
    return owner ? this.models.effectiveBinding(owner, expected) : this.models.resolveSelectedModel(expected);
  }
  private fingerprint(binding?: ModelBinding): string { return fingerprintCurrentZcode({ ...this.config.zcode, modelBinding: binding ?? this.models.resolveSelectedModel() }); }
  private assess(check: ExecutionCheck | null, target: 'zcode' | 'docker', project: Project | null = null, employeeId: string | null = null): Capability {
    if (target === 'zcode') {
      try {
        const binding = this.resolveBinding(check?.modelBinding, employeeId ?? check?.employeeId);
        const support = this.models.bindingSupport(binding);
        if (!support.ready) return support;
        if (!check?.modelBinding) return { ready: false, reason: '旧检查未绑定所选模型，不能继续使用' };
      } catch (error) { return { ready: false, reason: diagnostic(error) }; }
    }
    if (!check) return { ready: false, reason: target === 'zcode' ? '尚未执行 ZCode 模型、读取与编辑工具检查' : '尚未执行项目 Docker 镜像与容器检查' };
    if (check.status !== 'ready') return { ready: false, reason: check.result || '检查未通过' };
    if (check.processInstanceId !== this.instanceId || !check.expiresAt || Date.parse(check.expiresAt) <= Date.now() || check.policyVersion !== POLICY) return { ready: false, reason: '验收已过期或服务已重启，请重新检查' };
    if (target === 'zcode') {
      if (!this.config.zcode.enabled || this.config.zcode.environmentMode !== 'existing-user') return { ready: false, reason: '未启用原位复用本机 ZCode 模式' };
      try { if (check.fingerprint !== this.fingerprint(this.resolveBinding(check.modelBinding, check.employeeId))) return { ready: false, reason: 'ZCode 入口或全局配置已变化，请重新检查' }; }
      catch { return { ready: false, reason: 'ZCode 入口或用户环境当前不可用' }; }
    } else if (!project || check.image !== project.dockerImage || !check.imageDigest) return { ready: false, reason: '当前项目的测试镜像与验收不匹配' };
    return { ready: true, reason: check.result };
  }
  status(): ExecutionStatus {
    const zcodeCheck = this.latest('zcode');
    const zcode = this.assess(zcodeCheck, 'zcode');
    const projects = this.store.all('projects').map(project => ({ id: project.id, name: project.name, image: project.dockerImage, ...this.assess(this.latest('docker', project.id), 'docker', project) }));
    const dockerCheck = this.store.all('executionChecks').filter(check => check.target === 'docker').sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0] ?? null;
    const docker: Capability = { ready: projects.some(project => project.ready), reason: projects.some(project => project.ready) ? '已有项目镜像通过实测；运行时仍逐项目核对' : dockerCheck?.result ?? '尚未验证 Docker；本机此前未安装 WSL／Docker' };
    const modelState = this.models.read();
    return { environmentMode: 'existing-user', warning: WARNING, checking: !!this.active, zcode, docker, zcodeCheck, dockerCheck, projects, modelSelection: modelState.selection, modelBindingSupport: modelState.bindingSupport };
  }
  async startCheck(target: 'zcode' | 'docker', userId: string, projectId: string | null = null, employeeId: string | null = null): Promise<ExecutionStatus> {
    if (target !== 'zcode' && target !== 'docker') throw new AppError('检查目标无效');
    if (this.active) throw new AppError('已有连接检查正在运行', 409);
    if (Number((this.store.sql.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')").get() as { n: number }).n)) throw new AppError('先等待或取消运行中的任务，再进行连接检查', 409);
    if (target === 'zcode' && (!this.config.zcode.enabled || this.config.zcode.environmentMode !== 'existing-user')) throw new AppError('ZCode 原位复用未配置', 409);
    const binding = target === 'zcode' ? this.resolveBinding(undefined, employeeId) : undefined;
    if (binding) {
      const support = this.models.bindingSupport(binding);
      if (!support.ready) throw new AppError(support.reason, 409);
    }
    const project = projectId ? this.store.get('projects', projectId) : null;
    if (target === 'docker' && !project) throw new AppError('请选择要验收 Docker 镜像的项目');
    const check: ExecutionCheck = { id: id('connection'), target, status: 'checking', environmentMode: 'existing-user', policyVersion: POLICY, fingerprint: null, checkedAt: now(), expiresAt: null, checkedBy: userId, processInstanceId: this.instanceId, projectId: project?.id ?? null, taskId: null, image: project?.dockerImage ?? null, imageDigest: null, result: '正在检查；不会自动安装组件或切换模型', model: null, observedTools: [], sessionId: null, employeeId: target === 'zcode' ? employeeId : null, ...(binding ? { modelBinding: binding } : {}) };
    this.store.insert('executionChecks', check);
    this.store.audit(userId, '显式启动执行接入检查', check.id, target === 'zcode' ? '复用现有配置；最多两次小范围模型调用，仅使用新建测试目录' : '仅测试选定项目的本地容器镜像；不自动拉取');
    const controller = new AbortController();
    const promise = this.perform(check, project, controller.signal);
    this.active = { checkId: check.id, controller, promise };
    void promise.finally(() => { if (this.active?.checkId === check.id) this.active = null; });
    return this.status();
  }
  private async perform(check: ExecutionCheck, project: Project | null, signal: AbortSignal) {
    try {
      const probeId = id('probe');
      const projectWorkspace = this.probes.createProject(probeId);
      const probe = testProject(projectWorkspace, probeId, project?.dockerImage ?? this.config.docker.image);
      const workspace = this.probes.createTask(probe, id('checktask'));
      if (check.target === 'zcode') await this.probeZcode(check, workspace, signal);
      else {
        fs.writeFileSync(path.join(workspace, 'tests', 'isolation.test.mjs'), [
          "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os';",
          "test('fixed container isolation properties', () => {",
          "  assert.equal(process.getuid(), 1000);",
          "  assert.ok(!fs.existsSync('/var/run/docker.sock'));",
          "  assert.throws(() => fs.writeFileSync('/workspace/should-not-write', 'x'), e => ['EROFS','EACCES','EPERM'].includes(e.code));",
          "  assert.throws(() => fs.writeFileSync('/etc/should-not-write', 'x'), e => ['EROFS','EACCES','EPERM'].includes(e.code));",
          "  assert.ok(Object.values(os.networkInterfaces()).flat().every(i => !i || i.internal));",
          "  const status = fs.readFileSync('/proc/self/status', 'utf8');",
          "  assert.match(status, /NoNewPrivs:\\s+1/); assert.match(status, /CapEff:\\s+0+\\s/);",
          "});",
        ].join('\n'));
        const before = await this.dockerFingerprint(probe.dockerImage, signal);
        const result = await runDockerTests(workspace, { ...this.config.docker, image: probe.dockerImage }, signal);
        if (result.status !== 'passed' || result.exitCode !== 0 || !result.imageDigest) throw new Error(result.log || 'Docker 隔离验证未通过');
        const after = await this.dockerFingerprint(probe.dockerImage, signal);
        if (before.fingerprint !== after.fingerprint || result.imageDigest !== after.digest) throw new Error('Docker 镜像或引擎在检查过程中变化');
        this.complete(check.id, { fingerprint: after.fingerprint, imageDigest: result.imageDigest, result: 'Docker 固定镜像、禁网/只读容器启动、真实测试与精准清理通过；仅对选定项目有效' });
      }
    } catch (error) {
      const current = this.store.get('executionChecks', check.id);
      if (current?.status === 'checking') {
        this.store.put('executionChecks', { ...current, status: 'blocked', result: signal.aborted ? '检查已取消，不能作为通过证据' : diagnostic(error), expiresAt: null });
        this.store.audit('system', '执行接入检查未通过', check.id, signal.aborted ? '取消' : diagnostic(error));
      }
    }
  }
  private complete(checkId: string, patch: Partial<ExecutionCheck>) {
    const current = this.store.get('executionChecks', checkId);
    if (current?.status !== 'checking') return;
    if (current.target === 'zcode') {
      try {
        if (!current.modelBinding) throw new Error('missing model binding');
        this.resolveBinding(current.modelBinding, current.employeeId);
      } catch {
        this.store.put('executionChecks', { ...current, status: 'blocked', expiresAt: null, result: '检查期间模型选择发生变化；迟到结果不作为成功证据' });
        return;
      }
    }
    this.store.transaction(() => {
      this.store.put('executionChecks', { ...current, ...patch, status: 'ready', expiresAt: new Date(Date.now() + TTL).toISOString() });
      this.store.audit('system', '执行接入检查完成', checkId, '仅为当前配置及本次进程的限时证据，不是硬沙箱或生产授权');
    });
  }
  private async probeZcode(check: ExecutionCheck, workspace: string, signal: AbortSignal) {
    if (!check.modelBinding) throw new AppError('检查没有绑定模型，拒绝使用默认模型', 409);
    const binding = this.resolveBinding(check.modelBinding, check.employeeId);
    const support = this.models.bindingSupport(binding);
    if (!support.ready) throw new AppError(support.reason, 409);
    const fingerprint = this.fingerprint(binding);
    const nonce = randomUUID();
    fs.writeFileSync(path.join(workspace, 'README.md'), `# 连接检查\n仅限当前目录，禁止访问其他项目和配置。\n验证口令：${nonce}\n`);
    const original = this.probes.snapshot(workspace);
    const probeId = id('modelprobe');
    const project = testProject(workspace, probeId, this.config.docker.image);
    const baseTask: Task = { id: probeId, title: '模型绑定检查', goal: '只验证已选择模型的文件工具', projectId: probeId, leaderId: 'probe-leader', developerId: 'probe-developer', qaId: 'probe-qa', status: 'planning', mode: 'zcode', version: 1, modelBinding: binding, contentHash: null, plan: null, blockedReason: null, createdAt: now(), updatedAt: now() };
    const invoke = async (prompt: string, stage: 'planning' | 'development') => {
      this.resolveBinding(binding);
      const employee: Employee = { id: stage === 'planning' ? 'probe-leader' : 'probe-developer', name: '连接检查', role: stage === 'planning' ? 'lead' : 'developer', duties: '仅操作当前检查目录', reportsTo: null, projectIds: [probeId], enabled: true, createdAt: now() };
      // Use the identical model-bound transport as actual employees; no raw -p default fallback.
      const nativeBindingSupport = this.zcodeTransport.requiresModelEvidence && this.zcodeTransport.supports(binding).ready;
      const effectiveReasoningLevel = nativeBindingSupport ? this.models.effectiveReasoning(binding) : binding.reasoningLevel;
      return new ZcodeRunner({ ...this.config.zcode, modelBinding: binding, effectiveReasoningLevel,
        personalConfigPath: this.config.modelCatalogPath, builtinConfigPath: this.config.builtinModelConfigPath,
        cliConfigPath: path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.zcode', 'cli', 'config.json'), verificationFingerprint: fingerprint
      }, this.zcodeTransport).run({ employee, project, task: baseTask, stage, workspace, prompt, signal });
    };
    const read = await invoke('这是管理员显式连接验收，只在当前新建演示目录。使用读取工具读取 README.md 的验证口令，不改文件、不读取其他目录或配置、不执行命令。只返回 JSON {"summary":"读取到的验证口令","files":[]}。', 'planning');
    this.probes.assertStageChanges(workspace, original, 'planning');
    if (!read.summary.includes(nonce) || !read.executionMetadata?.observedTools.some(name => /read|grep|search/i.test(name))) throw new Error('缺少读取口令及文件工具的真实证据');
    const content = `export const probe = ${JSON.stringify(randomUUID())};\n`;
    const edit = await invoke(`使用文件编辑工具在当前目录创建 src/probe.mjs，内容严格为：\n${content}\n不改其他文件、不执行命令。只返回 JSON {"summary":"编辑检查完成","files":[]}。`, 'development');
    this.probes.assertStageChanges(workspace, original, 'development');
    if (fs.readFileSync(path.join(workspace, 'src', 'probe.mjs'), 'utf8') !== content || !edit.executionMetadata?.observedTools.some(name => /write|edit/i.test(name))) throw new Error('缺少编辑工具与文件内容证据');
    this.resolveBinding(binding);
    if (this.fingerprint(binding) !== fingerprint) throw new Error('检查期间模型环境变化');
    this.complete(check.id, { fingerprint, modelBinding: binding, observedTools: [...new Set([...read.executionMetadata.observedTools, ...edit.executionMetadata.observedTools])], sessionId: edit.sessionId ?? null, result: '模型绑定、读取和编辑证据通过；当前用户受控进程，不是硬沙箱', model: edit.executionMetadata.model ?? read.executionMetadata.model });
  }
  private async dockerFingerprint(image: string, signal?: AbortSignal): Promise<{ fingerprint: string; digest: string }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,254}$/.test(image)) throw new AppError('Docker 镜像引用无效');
    const options = { cwd: this.config.dataDir, timeoutMs: 10_000, signal, maxOutputBytes: 256 * 1024 };
    const engine = await runProcess(this.config.docker.executable, ['info', '--format', '{{json .ID}}'], options);
    const inspected = await runProcess(this.config.docker.executable, ['image', 'inspect', '--format', '{{json .}}', image], options);
    if (engine.exitCode !== 0 || inspected.exitCode !== 0 || engine.cancelled || inspected.cancelled || engine.timedOut || inspected.timedOut) throw new Error('Docker 引擎或本地镜像不可用，不会自动安装或拉取');
    const metadata = JSON.parse(inspected.stdout) as { Id: string; RepoDigests?: string[] };
    if (!/^sha256:[a-f0-9]{64}$/.test(metadata.Id)) throw new Error('Docker 未返回固定镜像 ID');
    const digest = metadata.RepoDigests?.find(value => /@sha256:[a-f0-9]{64}$/.test(value)) ?? metadata.Id;
    return { fingerprint: hash({ policy: POLICY, engine: engine.stdout.trim(), imageId: metadata.Id, digest }), digest };
  }
  async assertProjectReady(project: Project, signal?: AbortSignal, expectedBinding?: ModelBinding): Promise<{ options: ZcodeOptions; zcodeCheckId: string; dockerDigest: string; modelBinding: ModelBinding }> {
    if (!this.config.realExecutionEnabled) throw new AppError('真实执行意图未启用', 409);
    const binding = this.resolveBinding(expectedBinding);
    const support = this.models.bindingSupport(binding);
    if (!support.ready) throw new AppError(support.reason, 409);
    const employeeId = 'employeeId' in binding && typeof binding.employeeId === 'string' ? binding.employeeId : null;
    const zcodeCheck = this.latest('zcode', null, employeeId);
    const zcode = this.assess(zcodeCheck, 'zcode', null, employeeId);
    if (!zcode.ready || !zcodeCheck?.fingerprint) throw new AppError(zcode.reason, 409);
    const dockerCheck = this.latest('docker', project.id);
    const docker = this.assess(dockerCheck, 'docker', project);
    if (!docker.ready || !dockerCheck?.fingerprint) throw new AppError(docker.reason, 409);
    const actual = await this.dockerFingerprint(project.dockerImage, signal);
    this.resolveBinding(binding);
    const currentZcode = this.latest('zcode', null, employeeId);
    const currentDocker = this.latest('docker', project.id);
    if (currentZcode?.id !== zcodeCheck.id || currentDocker?.id !== dockerCheck.id || !this.assess(currentZcode, 'zcode', null, employeeId).ready || !this.assess(currentDocker, 'docker', project).ready || currentZcode.fingerprint !== zcodeCheck.fingerprint || actual.fingerprint !== currentDocker.fingerprint) throw new AppError('接入状态已撤销、过期或镜像变化，请重新验证', 409);
    const nativeBindingSupport = this.zcodeTransport.requiresModelEvidence && this.zcodeTransport.supports(binding).ready;
    const effectiveReasoningLevel = nativeBindingSupport ? this.models.effectiveReasoning(binding) : binding.reasoningLevel;
    return { options: { ...this.config.zcode, environmentMode: 'existing-user', verificationFingerprint: currentZcode.fingerprint!, modelBinding: binding,
      effectiveReasoningLevel, personalConfigPath: this.config.modelCatalogPath, builtinConfigPath: this.config.builtinModelConfigPath,
      cliConfigPath: path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.zcode', 'cli', 'config.json') }, zcodeCheckId: currentZcode.id, dockerDigest: actual.digest, modelBinding: binding };
  }
  invalidateModels(scope: 'app' | 'employee', userId: string, employeeId?: string): void {
    const affected = (check: ExecutionCheck) => {
      if (check.target !== 'zcode') return false;
      if (scope === 'employee') return check.employeeId === employeeId;
      return !check.employeeId || !check.modelBinding || !('source' in check.modelBinding) || check.modelBinding.source === 'app-default';
    };
    if (this.active) {
      const check = this.store.get('executionChecks', this.active.checkId);
      if (check && affected(check)) this.active.controller.abort();
    }
    for (const check of this.store.all('executionChecks').filter(affected)) this.store.put('executionChecks', { ...check, status: 'revoked', expiresAt: null, result: '对应模型配置已变化，请重新验证；其他员工独立覆盖不受影响' });
    this.store.audit(userId, '模型检查按作用域失效', employeeId ?? 'app-default', scope);
  }
  revoke(target: 'zcode' | 'docker', userId: string): ExecutionStatus {
    if (this.active && this.store.get('executionChecks', this.active.checkId)?.target === target) this.active.controller.abort();
    const checks = this.store.all('executionChecks').filter(check => check.target === target && check.status !== 'revoked');
    for (const check of checks) this.store.put('executionChecks', { ...check, status: 'revoked', expiresAt: null, result: '用户已撤销接入验收；后续运行必须重新验证' });
    this.store.audit(userId, '撤销执行接入', target, '不修改现有 ZCode 账号、全局配置或凭据');
    return this.status();
  }
  async shutdown() { if (this.active) { this.active.controller.abort(); await this.active.promise; } }
}
