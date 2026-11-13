import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { FileChange, Project, Stage } from '../../shared/types.js';

const MAX_FILES = 50;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_ENTRIES = 200;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const forbidden = new Set(['.git', '.env', 'node_modules']);
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const manifestNames = /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|(?:pnpm-lock|yarn)\.(?:yaml|lock)|deno\.jsonc?|bun\.lockb?)$/i;
const demo: FileChange[] = [
  { path: 'src/add.mjs', content: 'export function add(a, b) {\n  return a + b;\n}\n' },
  { path: 'tests/add.test.mjs', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.mjs';\n\ntest('adds two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n" },
  { path: 'README.md', content: '# Demo\n\nA dependency-free Node.js add(a, b) module.\nRun tests with node --test tests/*.test.mjs.\n' },
];

type Entry = { path: string; content: Buffer };
export interface WorkspaceSnapshot {
  hash: string;
  files: { path: string; sha256: string; bytes: number }[];
}
function fail(message: string): never { throw new Error(`Workspace: ${message}`); }
function id(value: string): string {
  if (typeof value !== 'string' || !ID.test(value) || reserved.test(value) || forbidden.has(value.toLowerCase())) fail('invalid project/task id');
  return value;
}
function relativeFile(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240
    || /[\\:\x00-\x1f\x7f]/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    fail('unsafe relative file path');
  }
  const segments = value.split('/');
  if (segments.length > 12 || segments.some((part) => !part || part === '.' || part === '..'
    || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || reserved.test(part)
    || forbidden.has(part.toLowerCase()) || part.toLowerCase().startsWith('.env.')
    || part.startsWith('.'))) fail(`forbidden file path: ${value}`);
  return value;
}
function same(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function existingStat(file: string) {
  try { return lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
// Walk every ancestor: realpath on only the final file would conceal a linked parent.
function safePath(file: string, allowMissing = false): void {
  if (!path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)
    || file.startsWith('\\\\') || file.startsWith('//')) fail('unsafe absolute workspace root');
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (let index = 0; index <= parts.length; index++) {
    if (index) current = path.join(current, parts[index - 1]);
    const stat = existingStat(current);
    if (!stat) {
      if (allowMissing) return;
      fail('workspace path is missing');
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
      || !same(path.resolve(realpathSync.native(current)), path.resolve(current))) {
      fail('symlink/reparse or special path is forbidden');
    }
    if (index < parts.length && !stat.isDirectory()) fail('parent is not a directory');
    if (stat.isFile() && stat.nlink !== 1) fail('hard-linked files are forbidden');
  }
}
function ensureDirectory(directory: string): void {
  safePath(directory, true);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  safePath(directory);
  if (!lstatSync(directory).isDirectory()) fail('expected a directory');
}
function readRegular(file: string): Buffer {
  safePath(file);
  const before = lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) fail('invalid or oversized file');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino
      || stat.size > MAX_FILE_BYTES) fail('file changed during validation');
    const content = readFileSync(fd);
    if (content.length > MAX_FILE_BYTES) fail('file exceeds 128KB');
    safePath(file);
    return content;
  } finally { closeSync(fd); }
}
function scan(directory: string): Entry[] {
  safePath(directory);
  if (!lstatSync(directory).isDirectory()) fail('workspace is not a directory');
  const files: Entry[] = [];
  let total = 0;
  let entries = 0;
  const walk = (folder: string, prefix: string): void => {
    safePath(folder);
    for (const name of readdirSync(folder).sort()) {
      if (++entries > MAX_ENTRIES) fail('too many filesystem entries');
      const relative = relativeFile(prefix ? `${prefix}/${name}` : name);
      const target = path.join(directory, ...relative.split('/'));
      safePath(target);
      const stat = lstatSync(target);
      if (stat.isDirectory()) walk(target, relative);
      else {
        if (files.length >= MAX_FILES) fail('more than 50 files');
        const content = readRegular(target);
        total += content.length;
        if (total > MAX_TOTAL_BYTES) fail('workspace exceeds 1MB');
        files.push({ path: relative, content });
      }
    }
  };
  walk(directory, '');
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const insensitive = new Set<string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (insensitive.has(key)) fail('case-colliding file paths');
    insensitive.add(key);
  }
  return files;
}
function digest(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function manifest(entries: Entry[]) {
  return entries.map((entry) => ({ path: entry.path, sha256: digest(entry.content), bytes: entry.content.length }));
}
function fingerprint(entries: Entry[]): string {
  return createHash('sha256').update(JSON.stringify(manifest(entries))).digest('hex');
}
function validateStagePath(relative: string, stage: Stage): void {
  relativeFile(relative);
  if (stage !== 'development' && stage !== 'qa') fail('this stage cannot change files');
  if (manifestNames.test(path.posix.basename(relative))) fail('model cannot change manifests, locks, or package scripts');
  if (stage === 'qa' && !/^tests\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/.test(relative)) {
    fail('QA can only change tests/*.test.mjs');
  }
  if (stage === 'development' && !/^src\/[A-Za-z0-9][A-Za-z0-9_./-]*\.(?:mjs|js|cjs|ts|tsx|jsx|json|css)$/.test(relative)
    && relative !== 'README.md') fail('development can only change src files or README.md, not tests');
  if (stage === 'development' && relative.split('/').some((part) => /^(?:tests?|__tests__)$/i.test(part)
    || /\.(?:test|spec)\./i.test(part))) fail('development cannot edit tests');
}
function validateManifest(snapshot: WorkspaceSnapshot): void {
  if (!snapshot || !/^[a-f0-9]{64}$/.test(snapshot.hash) || !Array.isArray(snapshot.files)
    || snapshot.files.length > MAX_FILES) fail('invalid candidate snapshot');
  const names = new Set<string>();
  let bytes = 0;
  let previous: string | undefined;
  const files = snapshot.files.map((file) => {
    if (!file || typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES) fail('invalid snapshot file');
    const relative = relativeFile(file.path);
    const key = relative.toLowerCase();
    if (names.has(key) || (previous !== undefined && previous >= relative)) fail('duplicate or unordered snapshot paths');
    for (const present of names) {
      if (present.startsWith(`${key}/`) || key.startsWith(`${present}/`)) fail('colliding file paths');
    }
    names.add(key);
    previous = relative;
    bytes += file.bytes;
    return { path: relative, sha256: file.sha256, bytes: file.bytes };
  });
  if (bytes > MAX_TOTAL_BYTES || createHash('sha256').update(JSON.stringify(files)).digest('hex') !== snapshot.hash) {
    fail('invalid snapshot hash or byte limits');
  }
}
/** Validate a manifest diff without restoring, deleting, or otherwise changing candidate files. */
export function validateCandidateChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot, stage: Stage): WorkspaceSnapshot {
  if (!['planning', 'development', 'qa', 'ops'].includes(stage)) fail('invalid stage');
  validateManifest(before);
  validateManifest(after);
  const previous = new Map(before.files.map((file) => [file.path, file]));
  const current = new Map(after.files.map((file) => [file.path, file]));
  for (const name of previous.keys()) if (!current.has(name)) fail('candidate file deletions are forbidden');
  for (const file of after.files) {
    const old = previous.get(file.path);
    if (!old || old.sha256 !== file.sha256 || old.bytes !== file.bytes) validateStagePath(file.path, stage);
  }
  return after;
}
function validateFileChanges(directory: string, existing: Entry[], files: FileChange[], stage: Stage): void {
  if (!Array.isArray(files) || files.length > MAX_FILES) fail('file changes must be an array of at most 50 files');
  if (stage !== 'development' && stage !== 'qa') fail('this stage cannot change files');
  const candidate = new Map(existing.map((entry) => [entry.path, entry.content]));
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || typeof file.content !== 'string') fail('invalid file change');
    const relative = relativeFile(file.path);
    if (seen.has(relative.toLowerCase())) fail('duplicate file change');
    seen.add(relative.toLowerCase());
    validateStagePath(relative, stage);
    const content = Buffer.from(file.content);
    total += content.length;
    if (content.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) fail('file changes exceed byte limits');
    for (const present of candidate.keys()) {
      if (present !== relative && (present.toLowerCase() === relative.toLowerCase()
        || present.toLowerCase().startsWith(`${relative.toLowerCase()}/`)
        || relative.toLowerCase().startsWith(`${present.toLowerCase()}/`))) fail('colliding file paths');
    }
    safePath(path.join(directory, ...relative.split('/')), true);
    candidate.set(relative, content);
  }
  if (candidate.size > MAX_FILES || [...candidate.values()].reduce((sum, content) => sum + content.length, 0) > MAX_TOTAL_BYTES) {
    fail('resulting workspace exceeds file/byte limits');
  }
}
function writeRegular(directory: string, relative: string, content: Buffer | string, exclusive = false): void {
  const target = path.join(directory, ...relativeFile(relative).split('/'));
  ensureDirectory(path.dirname(target));
  safePath(target, true);
  const before = existingStat(target);
  if (before && (!before.isFile() || before.nlink !== 1)) fail('unsafe write destination');
  const flags = constants.O_WRONLY | constants.O_CREAT | (exclusive ? constants.O_EXCL : 0)
    | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(target, flags, 0o644);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1
      || (before && (stat.dev !== before.dev || stat.ino !== before.ino))) fail('write destination changed');
    // Truncate only after the descriptor has been checked, not as part of open().
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    // writeFile on an existing descriptor does not truncate trailing bytes.
    writeFileSync(fd, data);
    ftruncateSync(fd, data.length);
    safePath(target);
  } finally { closeSync(fd); }
}
const managedRoots = new Map<string, WorkspaceManager>();
/** Runner-only trust boundary: roots are registered by application-created managers, never by candidate files. */
export function assertManagedTaskWorkspace(workspace: string): string {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || /[\x00-\x1f\x7f,]/.test(workspace)
    || /^[/\\]{2}/.test(workspace) || workspace.split(/[/\\]/).includes('..')) fail('invalid task workspace path');
  const absolute = path.resolve(workspace);
  for (const root of managedRoots.keys()) {
    const parts = path.relative(root, absolute).split(path.sep);
    if (parts.length !== 2 || parts[0] !== 'tasks') continue;
    id(parts[1]);
    safePath(absolute);
    scan(absolute);
    return absolute;
  }
  fail('runner workspace must be within the authoritative root/tasks/<id>');
}
/** Return only a previously registered manager; a runner must never provision roots from model input. */
export function managerForTaskWorkspace(workspace: string): WorkspaceManager {
  const absolute = assertManagedTaskWorkspace(workspace);
  for (const [root, manager] of managedRoots) {
    if (same(root, path.dirname(path.dirname(absolute)))) return manager;
  }
  fail('task workspace manager is unavailable');
}
function boundedText(text: string): string {
  const data = Buffer.from(text);
  if (data.length <= MAX_TEXT_BYTES) return text;
  const suffix = '\n[truncated: 64KB output limit]\n';
  return data.subarray(0, MAX_TEXT_BYTES - Buffer.byteLength(suffix) - 3).toString('utf8') + suffix;
}

export class WorkspaceManager {
  private readonly root: string;
  constructor(root: string) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root)
      || root.startsWith('\\\\') || root.startsWith('//')
      || root.split(/[\\/]/).some((part) => part === '..' || forbidden.has(part.toLowerCase()))) {
      fail('root must be an absolute local application workspace directory');
    }
    this.root = path.resolve(root);
    ensureDirectory(this.root);
    for (const section of ['projects', 'tasks', 'baselines']) ensureDirectory(path.join(this.root, section));
    managedRoots.set(this.root, this);
  }

  private location(workspace: string): { directory: string; kind: string; id: string } {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)
      || /[\x00-\x1f\x7f]/.test(workspace) || workspace.split(/[\\/]/).includes('..')) fail('invalid workspace path');
    const directory = path.resolve(workspace);
    const parts = path.relative(this.root, directory).split(path.sep);
    if (parts.length !== 2 || !['projects', 'tasks'].includes(parts[0])) fail('workspace is outside managed projects/tasks');
    id(parts[1]);
    safePath(directory);
    return { directory, kind: parts[0], id: parts[1] };
  }

  private baselinePath(kind: string, identifier: string): string {
    // Task baseline is exactly root/baselines/<taskId>; project baselines have a private namespace.
    return kind === 'tasks' ? path.join(this.root, 'baselines', identifier)
      : path.join(this.root, 'baselines', '_projects', identifier);
  }

  private baseline(kind: string, identifier: string): Entry[] {
    const directory = this.baselinePath(kind, identifier);
    const entries = scan(directory);
    const seal = path.join(this.root, 'baselines', '_seals', `${kind}-${identifier}.sha256`);
    if (readRegular(seal).toString('utf8') !== fingerprint(entries)) fail('immutable baseline integrity check failed');
    return entries;
  }

  private saveBaseline(kind: string, identifier: string, entries: Entry[]): void {
    const directory = this.baselinePath(kind, identifier);
    safePath(directory, true);
    if (existingStat(directory)) fail('baseline already exists; refusing to replace it');
    ensureDirectory(directory);
    for (const entry of entries) {
      writeRegular(directory, entry.path, entry.content, true);
      chmodSync(path.join(directory, ...entry.path.split('/')), 0o400);
    }
    const seals = path.join(this.root, 'baselines', '_seals');
    ensureDirectory(seals);
    const seal = `${kind}-${identifier}.sha256`;
    writeRegular(seals, seal, fingerprint(entries), true);
    chmodSync(path.join(seals, seal), 0o400);
  }

  createProject(projectId: string): string {
    const identifier = id(projectId);
    const workspace = path.join(this.root, 'projects', identifier);
    safePath(workspace, true);
    if (existingStat(workspace)) {
      scan(workspace);
      this.baseline('projects', identifier);
      return workspace;
    }
    if (existingStat(this.baselinePath('projects', identifier))) fail('project baseline exists without a candidate');
    ensureDirectory(workspace);
    for (const file of demo) writeRegular(workspace, file.path, file.content, true);
    this.saveBaseline('projects', identifier, scan(workspace));
    return workspace;
  }

  createTask(project: Project, taskId: string): string {
    const identifier = id(taskId);
    const projectId = id(project.id);
    const source = this.location(project.workspace);
    if (source.kind !== 'projects' || source.id !== projectId) fail('project path must match root/projects/<projectId>');
    const workspace = path.join(this.root, 'tasks', identifier);
    safePath(workspace, true);
    if (existingStat(workspace)) {
      scan(workspace);
      this.baseline('tasks', identifier);
      return workspace; // Revision/retry must not erase the candidate or reset the baseline.
    }
    if (existingStat(this.baselinePath('tasks', identifier))) fail('task baseline exists without a candidate');
    const entries = scan(source.directory);
    ensureDirectory(workspace);
    for (const entry of entries) writeRegular(workspace, entry.path, entry.content, true);
    this.saveBaseline('tasks', identifier, entries);
    return workspace;
  }

  validateChanges(workspace: string, files: FileChange[], stage: Stage): void {
    const location = this.location(workspace);
    const existing = scan(location.directory);
    this.baseline(location.kind, location.id);
    validateFileChanges(location.directory, existing, files, stage);
  }

  applyChanges(workspace: string, files: FileChange[], stage: Stage): void {
    this.validateChanges(workspace, files, stage);
    const location = this.location(workspace);
    // Validate the entire batch before any writes, so a rejected second entry cannot sneak in the first.
    for (const file of files) writeRegular(location.directory, file.path, file.content);
  }

  assertStageChanges(workspace: string, beforeSnapshot: WorkspaceSnapshot, stage: Stage): WorkspaceSnapshot {
    const location = this.location(workspace);
    this.baseline(location.kind, location.id);
    const entries = scan(location.directory); // Hidden settings, links, and oversized files also fail closed.
    return validateCandidateChanges(beforeSnapshot, { hash: fingerprint(entries), files: manifest(entries) }, stage);
  }

  snapshot(workspace: string): WorkspaceSnapshot {
    const location = this.location(workspace);
    const entries = scan(location.directory);
    return { hash: fingerprint(entries), files: manifest(entries) };
  }

  readContext(workspace: string): string {
    const location = this.location(workspace);
    return boundedText(scan(location.directory)
      .filter((entry) => /^(?:src\/|tests\/|README(?:\.[A-Za-z0-9]+)?$)/i.test(entry.path))
      .map((entry) => `--- ${entry.path} ---\n${entry.content.toString('utf8')}`).join('\n\n'));
  }

  diff(workspace: string): string {
    const location = this.location(workspace);
    const before = new Map(this.baseline(location.kind, location.id).map((entry) => [entry.path, entry.content]));
    const after = new Map(scan(location.directory).map((entry) => [entry.path, entry.content]));
    const sections: string[] = [];
    for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const old = before.get(name);
      const next = after.get(name);
      if (old?.equals(next ?? Buffer.alloc(0)) && next !== undefined) continue;
      const lines = [`--- ${old ? `a/${name}` : '/dev/null'}`, `+++ ${next ? `b/${name}` : '/dev/null'}`];
      if (old) lines.push(...old.toString('utf8').split('\n').map((line) => `-${line}`));
      if (next) lines.push(...next.toString('utf8').split('\n').map((line) => `+${line}`));
      sections.push(lines.join('\n'));
    }
    return boundedText(sections.join('\n\n'));
  }
}
