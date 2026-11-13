import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Role, TaskStatus } from '../shared/types';
import { errorMessage } from './api';

export type IconName = 'overview' | 'people' | 'project' | 'task' | 'approval' | 'monitor' | 'audit' | 'plus' | 'arrow' | 'chevron' | 'close' | 'refresh' | 'logout' | 'shield' | 'check' | 'alert' | 'play' | 'stop' | 'edit' | 'search' | 'menu' | 'code' | 'file' | 'clock';
const paths: Record<IconName, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  people: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3" /></>,
  project: <><path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 12h18" /></>,
  task: <><rect x="5" y="4" width="15" height="17" rx="2" /><path d="M9 4V2m7 2V2M9 10h7m-7 4h7m-7 4h4M2 8v10" /></>,
  approval: <><path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z" /><path d="m8 12 3 3 5-6" /></>,
  monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8m-4-4v4M5 11h3l2-5 4 8 2-4h3" /></>,
  audit: <><path d="M14 2H5v20h14V7Zm0 0v5h5M8 12h8m-8 4h8" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  refresh: <><path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6" /></>,
  logout: <><path d="M10 3H4v18h6m-1-9h12m-5-5 5 5-5 5" /></>,
  shield: <><path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z" /><path d="M12 8v5m0 3h.01" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  alert: <><path d="m12 3 10 18H2Z" /><path d="M12 9v5m0 3h.01" /></>,
  play: <path d="m8 4 12 8-12 8Z" />,
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  edit: <><path d="m15 4 5 5M4 16l-1 5 5-1L21 7l-5-5Z" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" /></>,
  file: <><path d="M14 2H5v20h14V7Zm0 0v5h5M8 12h8m-8 4h5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></>,
};
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M8 8h16L10 24h14M8 16h16" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" /></svg></span><span><strong>智研司</strong>{!compact && <small>AI COMPANY · 工作台</small>}</span></div>;
}
export type Tone = 'neutral' | 'teal' | 'indigo' | 'amber' | 'red';
export function Badge({ children, tone = 'neutral', dot = false }: { children: ReactNode; tone?: Tone; dot?: boolean }) {
  return <span className={`badge badge-${tone}`}>{dot && <span className="badge-dot" />}{children}</span>;
}
export const roleLabels: Record<Role, string> = { director: '研发总监', lead: '项目负责人', developer: '开发工程师', qa: '质量工程师', ops: '运维工程师' };
export const statusLabels: Record<TaskStatus, string> = {
  draft: '待启动', planning: '规划中', assigned: '已分派', developing: '开发中', awaiting_test: '待测试', testing: '测试中',
  changes_requested: '待修订', awaiting_merge: '待合并审批', awaiting_release: '待发布审批', release_authorized: '发布已授权',
  monitoring: '观察中', closed: '已完成', blocked: '已阻塞', cancelled: '已取消',
};
export const activeStatuses: TaskStatus[] = ['planning', 'assigned', 'developing', 'awaiting_test', 'testing'];
export function TaskBadge({ status }: { status: TaskStatus }) {
  const tone: Tone = status === 'blocked' ? 'red' : status === 'changes_requested' || status.startsWith('awaiting_') ? 'amber' : status === 'closed' || status === 'release_authorized' || status === 'monitoring' ? 'teal' : activeStatuses.includes(status) ? 'indigo' : 'neutral';
  return <Badge tone={tone} dot>{statusLabels[status] ?? status}</Badge>;
}
export function ModeBadge({ mode }: { mode: 'simulation' | 'zcode' | null }) {
  return mode === 'simulation' ? <Badge tone="amber">模拟 · 不可真实批准</Badge> : mode === 'zcode' ? <Badge tone="indigo">真实执行</Badge> : <Badge>未执行</Badge>;
}
export function Empty({ icon = 'project', title, description, action }: { icon?: IconName; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={28} /></span><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="notice notice-error" role="alert"><Icon name="alert" /><span>{message}</span>{retry && <button type="button" className="text-button" onClick={retry}>重试</button>}</div>;
}
export function Loading({ label = '正在读取本机数据…' }: { label?: string }) {
  return <div className="loading-state" role="status"><span className="spinner" /><span>{label}</span></div>;
}
export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
export function Modal({ title, eyebrow, children, onClose, wide = false, busy = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = ref.current;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => { element?.close(); focused?.focus(); };
  }, []);
  return <dialog className={`modal ${wide ? 'modal-wide' : ''}`} ref={ref} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><header className="modal-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id={titleId}>{title}</h2></div><button className="icon-button" type="button" aria-label="关闭对话框" onClick={onClose} disabled={busy}><Icon name="close" /></button></header>{children}</dialog>;
}
export function FormDialog({ title, eyebrow, onClose, onSubmit, children, submitLabel = '保存', wide = false, disabled = false }: {
  title: string; eyebrow?: string; onClose: () => void; onSubmit: (data: FormData) => Promise<void>; children: ReactNode; submitLabel?: string; wide?: boolean; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || disabled) return;
    const data = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try { await onSubmit(data); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <Modal title={title} eyebrow={eyebrow} onClose={onClose} busy={busy} wide={wide}><form onSubmit={submit}><div className="modal-body"><fieldset disabled={busy} className="form-fields">{children}</fieldset>{error && <ErrorNotice message={error} />}</div><footer className="modal-footer"><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>取消</button><button className="button button-primary" type="submit" disabled={busy || disabled}>{busy ? <span className="spinner" /> : <Icon name="check" size={17} />}{busy ? '正在提交…' : submitLabel}</button></footer></form></Modal>;
}
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export function formatDate(value: string | null | undefined): string {
  if (!value) return '尚无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : dateFormat.format(date);
}
export function text(data: FormData, name: string) { return String(data.get(name) ?? '').trim(); }
export function bytes(value: number): string { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; }
