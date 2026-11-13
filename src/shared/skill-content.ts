import type { LearningProposal, SkillContent } from './types.js';

const fields = ['title', 'purpose', 'conditions', 'steps', 'cautions', 'verification', 'tags'] as const;
const encoder = new TextEncoder();
export const SKILL_CONTENT_MAX_BYTES = 12 * 1024;

// This is a data-only validator. Neither content nor proposals grant execution rights.
export function hasSkillSecret(value: string): boolean {
  return /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i.test(value)
    || /\bbearer\s+[A-Za-z0-9._~+/=-]{3,}/i.test(value)
    || /(?:\b(?:[A-Za-z0-9_]*[_-])?(?:password|passwd|pwd|token|api[_ -]?key|api[_ -]?secret|client[_ -]?secret|access[_ -]?key|secret[_ -]?key|secret|authorization)\b|密码|口令|密钥)\s*["']?\s*[:=：]\s*["']?[^\s"',;，；}]+/i.test(value)
    || /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/.test(value)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)
    || /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value);
}

function fail(message: string): never { throw new Error(message); }
function string(value: unknown, name: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string') fail(`技能 ${name} 必须是文本`);
  const result = value.trim();
  if ((!allowEmpty && !result) || encoder.encode(value).length > maxBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`技能 ${name} 为空、超长或包含控制字符`);
  if (hasSkillSecret(value)) fail('技能内容可能包含凭据或私钥，请删除敏感值后重试');
  return result;
}
function strings(value: unknown, name: string, maxCount: number, maxBytes: number, minCount = 0): string[] {
  if (!Array.isArray(value) || value.length < minCount || value.length > maxCount) fail(`技能 ${name} 数量无效`);
  return value.map(item => string(item, name, maxBytes));
}

export function validateSkillContent(value: unknown): SkillContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('技能内容必须是 JSON 对象');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('技能内容必须是普通 JSON 对象');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !(fields as readonly string[]).includes(key))) fail('技能内容字段必须且只能包含 title/purpose/conditions/steps/cautions/verification/tags');
  // Reject accessors as well: validating data must not execute user-supplied code.
  for (const field of fields) if (!Object.getOwnPropertyDescriptor(value, field) || !('value' in Object.getOwnPropertyDescriptor(value, field)!)) fail('技能字段必须是普通数据');
  const item = value as Record<string, unknown>;
  const content: SkillContent = {
    title: string(item.title, 'title', 256),
    purpose: string(item.purpose, 'purpose', 2048),
    conditions: string(item.conditions, 'conditions', 2048),
    steps: strings(item.steps, 'steps', 12, 2048, 1),
    cautions: strings(item.cautions, 'cautions', 10, 1024),
    verification: string(item.verification, 'verification', 2048),
    tags: strings(item.tags, 'tags', 8, 96),
  };
  if (new Set(content.tags).size !== content.tags.length) fail('技能 tags 不得重复');
  if (encoder.encode(JSON.stringify(content)).length > SKILL_CONTENT_MAX_BYTES) fail('技能内容总大小不得超过 12 KiB');
  return content;
}

export function validateLearningProposals(value: unknown): LearningProposal[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) fail('learningProposals 必须是最多 3 条技能建议的数组');
  return value.map(validateSkillContent);
}
