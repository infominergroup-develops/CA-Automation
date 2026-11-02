import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type ComponentProps, type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowLeft, CheckCircle2, Info, Loader2, X, type LucideIcon } from 'lucide-react';
import { ApiError } from '../api';
import { useCountUp, useReveal } from '../motion';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
const MOTION = 'transition-[background-color,border-color,color,box-shadow,transform] duration-300 ease-(--ease-fluid)';

/* ---------------------------------------------------------------- Buttons */

type Variant = 'primary' | 'dark' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  // Orange with dark text: 5.7:1 contrast (white on this orange fails AA).
  primary: 'bg-brand-500 text-ink-900 hover:bg-brand-600 shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_1px_2px_rgb(168_90_14/0.25),0_6px_16px_-8px_rgb(235_138_35/0.6)]',
  dark: 'bg-ink text-white hover:bg-ink-900 shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_6px_16px_-8px_rgb(30_41_59/0.6)]',
  secondary: 'bg-white text-ink ring-1 ring-ink/10 hover:ring-ink/20 hover:bg-slate-50 shadow-[0_1px_2px_rgb(16_24_40/0.05)]',
  ghost: 'text-ink hover:bg-ink/[0.05]',
  danger: 'bg-white text-red-700 ring-1 ring-red-200 hover:bg-red-50 hover:ring-red-300',
};

/**
 * Pill button. `trailing` puts an icon in its own nested circle that nudges on hover ("button in button").
 */
export function Button({ variant = 'primary', size = 'md', busy, icon: Icon, trailing: Trailing, className, children, ...p }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean; icon?: LucideIcon; trailing?: LucideIcon }) {
  return (
    <button
      type="button"
      {...p}
      disabled={p.disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'group relative inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap select-none', MOTION,
        'active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none',
        size === 'sm' ? 'h-8 px-3.5 text-[13px]' : 'h-10 px-4.5 text-sm',
        Trailing && (size === 'sm' ? 'pr-1' : 'pr-1.5'),
        VARIANTS[variant], className,
      )}
    >
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : Icon && <Icon className="size-4" aria-hidden />}
      {children}
      {Trailing && (
        <span className={cx('grid place-items-center rounded-full transition-transform duration-500 ease-(--ease-fluid) group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105',
          size === 'sm' ? 'size-6' : 'size-7', variant === 'primary' ? 'bg-ink-900/10' : variant === 'dark' ? 'bg-white/12' : 'bg-ink/[0.06]')}>
          <Trailing className="size-3.5" aria-hidden />
        </span>
      )}
    </button>
  );
}

export function IconButton({ label, icon: Icon, tone = 'default', className, ...p }:
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: LucideIcon; tone?: 'default' | 'danger' | 'success' }) {
  const color = tone === 'danger' ? 'text-red-600 hover:bg-red-50' : tone === 'success' ? 'text-emerald-700 hover:bg-emerald-50' : 'text-slate-500 hover:text-ink hover:bg-ink/[0.05]';
  return (
    <button type="button" aria-label={label} title={label} {...p}
      className={cx('inline-grid place-items-center size-9 rounded-full active:scale-95', MOTION, color, className)}>
      <Icon className="size-[18px]" aria-hidden />
    </button>
  );
}

/* ---------------------------------------------------------------- Surfaces */

/** Double-bezel card: an outer tray and an inner panel, revealed with the page. */
export function Card({ title, description, actions, children, className, padded = true }:
  { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  const ref = useReveal<HTMLElement>();
  return (
    <section ref={ref} className={cx('bezel', className)}>
      <div className="bezel-core h-full overflow-hidden">
        {(title || actions) && (
          <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-line/80">
            <div className="min-w-0">
              {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
              {description && <p className="text-[13px] text-slate-500 mt-0.5">{description}</p>}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </header>
        )}
        <div className={padded ? 'p-5' : ''}>{children}</div>
      </div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back, eyebrow }:
  { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string }; eyebrow?: ReactNode }) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className="mb-7">
      {back && (
        <Link to={back.to} className="group inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-500 hover:text-ink mb-4">
          <ArrowLeft className="size-4 transition-transform duration-300 ease-(--ease-fluid) group-hover:-translate-x-0.5" aria-hidden />{back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <div className="eyebrow mb-3">{eyebrow}</div>}
          <h1 className="text-[26px] sm:text-[32px] font-bold leading-[1.1]">{title}</h1>
          {subtitle && <div className="text-sm text-slate-500 mt-2">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Badges */

const TONES = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  brand: 'bg-brand-50 text-brand-800 ring-brand-200',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  blue: 'bg-sky-50 text-sky-800 ring-sky-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  ink: 'bg-ink text-white ring-ink',
};
const DOTS = { slate: 'bg-slate-400', brand: 'bg-brand-500', green: 'bg-emerald-500', red: 'bg-red-500', blue: 'bg-sky-500', amber: 'bg-amber-500', ink: 'bg-white' };
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'slate', dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', TONES[tone])}>
      {dot && <span className={cx('size-1.5 rounded-full', DOTS[tone])} aria-hidden />}
      {children}
    </span>
  );
}

const STATUS: Record<string, [Tone, string]> = {
  requested: ['amber', 'Client request'], assigned: ['slate', 'Assigned'], in_progress: ['blue', 'In progress'],
  submitted: ['brand', 'Awaiting review'], rework: ['red', 'Rework'], approved: ['green', 'Approved'], cancelled: ['slate', 'Cancelled'],
  Received: ['slate', 'Received'], 'In progress': ['blue', 'In progress'], 'Under review': ['brand', 'Under review'],
  Completed: ['green', 'Completed'], Cancelled: ['slate', 'Cancelled'],
  pending: ['amber', 'Pending review'], accepted: ['green', 'Accepted'], reupload: ['red', 'Re-upload needed'], not_needed: ['slate', 'Not needed'],
  granted: ['green', 'Granted'], rejected: ['red', 'Rejected'], revoked: ['slate', 'Revoked'],
  open: ['amber', 'Open'], closed: ['green', 'Closed'], contained: ['blue', 'Contained'],
  pending_approval: ['amber', 'Needs approval'], ok: ['green', 'Logged'], active: ['green', 'Active'], disabled: ['red', 'Disabled'],
};
/** Status is always shown as dot + words, never colour alone. */
export function StatusBadge({ status }: { status: string }) {
  const [tone, label] = STATUS[status] ?? ['slate', status];
  return <Badge tone={tone} dot>{label}</Badge>;
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span aria-hidden className={cx('inline-grid place-items-center rounded-full bg-gradient-to-br from-ink to-ink-900 text-white font-semibold shrink-0 ring-2 ring-white shadow-[0_2px_6px_-2px_rgb(30_41_59/0.5)]', size === 'sm' ? 'size-7 text-[11px]' : 'size-9 text-xs')}>
      {initials}
    </span>
  );
}

/* ---------------------------------------------------------------- Forms */

const FieldCtx = createContext<{ id?: string; describedBy?: string; invalid?: boolean }>({});

export function Field({ label, hint, error, children, optional }: { label: string; hint?: ReactNode; error?: string; optional?: boolean; children: ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <FieldCtx.Provider value={{ id, describedBy: hint || error ? hintId : undefined, invalid: !!error }}>
      <div>
        <label htmlFor={id} className="flex items-baseline justify-between text-[13px] font-medium text-ink mb-1.5">
          {label}{optional && <span className="text-xs font-normal text-slate-500">Optional</span>}
        </label>
        {children}
        {(hint || error) && <p id={hintId} className={cx('text-xs mt-1.5', error ? 'text-red-700' : 'text-slate-500')}>{error ?? hint}</p>}
      </div>
    </FieldCtx.Provider>
  );
}

const control = cx(
  'w-full rounded-xl border-0 bg-white px-3.5 text-sm text-ink-900 ring-1 ring-ink/10 placeholder:text-slate-400',
  'shadow-[0_1px_2px_rgb(16_24_40/0.04)] transition-shadow duration-300 ease-(--ease-fluid)',
  'hover:ring-ink/20 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:shadow-[0_0_0_5px_rgb(235_138_35/0.12)]',
  'disabled:bg-slate-50 disabled:text-slate-500 aria-[invalid=true]:ring-red-400',
);
function useFieldProps() {
  const f = useContext(FieldCtx);
  return { id: f.id, 'aria-describedby': f.describedBy, 'aria-invalid': f.invalid || undefined };
}
export function Input({ className, ...p }: ComponentProps<'input'>) {
  return <input {...useFieldProps()} {...p} className={cx(control, p.type === 'file' ? 'py-1.5 file:mr-3 file:rounded-full file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-ink' : 'h-10', className)} />;
}
export function Select({ className, ...p }: ComponentProps<'select'>) {
  return <select {...useFieldProps()} {...p} className={cx(control, 'h-10 pr-8', className)} />;
}
export function Textarea({ className, ...p }: ComponentProps<'textarea'>) {
  return <textarea rows={3} {...useFieldProps()} {...p} className={cx(control, 'py-2.5 leading-relaxed', className)} />;
}

/** Selectable pill (multi-select chips). */
export function Chip({ selected, onToggle, children }: { selected: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={selected} onClick={onToggle}
      className={cx('h-8 px-3.5 rounded-full text-[13px] font-medium active:scale-95', MOTION,
        selected ? 'bg-ink text-white shadow-[0_4px_12px_-6px_rgb(30_41_59/0.6)]' : 'bg-white text-ink ring-1 ring-ink/10 hover:ring-ink/25')}>
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- Feedback */

export function Alert({ tone = 'error', title, children }: { tone?: 'error' | 'success' | 'info' | 'warning'; title?: ReactNode; children?: ReactNode }) {
  const s = {
    error: ['bg-red-50/80 ring-red-200 text-red-800', AlertCircle],
    success: ['bg-emerald-50/80 ring-emerald-200 text-emerald-900', CheckCircle2],
    info: ['bg-sky-50/80 ring-sky-200 text-sky-900', Info],
    warning: ['bg-amber-50/80 ring-amber-200 text-amber-900', AlertCircle],
  }[tone] as [string, LucideIcon];
  const Icon = s[1];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex gap-3 rounded-2xl ring-1 px-4 py-3.5 text-sm', s[0])}>
      <Icon className="size-5 shrink-0 mt-px" aria-hidden />
      <div className="min-w-0">{title && <div className="font-semibold">{title}</div>}{children}</div>
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError || error instanceof Error ? error.message : String(error);
  return <Alert tone="error">{msg}</Alert>;
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center py-12 px-4">
      <span className="relative grid place-items-center size-14 rounded-2xl bg-gradient-to-b from-white to-slate-50 ring-1 ring-ink/[0.07] shadow-card text-slate-500 mb-4">
        <Icon className="size-6" aria-hidden />
      </span>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {children && <p className="text-sm text-slate-500 mt-1 max-w-sm">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
/** Kept for short inline "nothing here" lines. */
export const Empty = ({ children }: { children: ReactNode }) => <p className="text-sm text-slate-500 py-6 text-center">{children}</p>;

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-xl bg-ink/[0.06]', className)} />;
}
export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}
    </div>
  );
}

/** Animated number (GSAP count-up); plain number when motion is reduced. */
export function CountUp({ value, format = (n: number) => n.toLocaleString('en-IN') }: { value: number; format?: (n: number) => string }) {
  const ref = useCountUp(value, format);
  return <span ref={ref}>{format(value)}</span>;
}

export function Stat({ label, value, icon: Icon, tone = 'slate', hint, onClick }:
  { label: string; value: number | string; icon?: LucideIcon; tone?: 'slate' | 'brand' | 'red' | 'green'; hint?: string; onClick?: () => void }) {
  const ref = useReveal<HTMLDivElement>();
  const iconBg = {
    slate: 'from-slate-50 to-slate-100 text-ink ring-ink/[0.06]', brand: 'from-brand-50 to-brand-100 text-brand-700 ring-brand-200/60',
    red: 'from-red-50 to-red-100 text-red-600 ring-red-200/60', green: 'from-emerald-50 to-emerald-100 text-emerald-700 ring-emerald-200/60',
  }[tone];
  const Comp = onClick ? 'button' : 'div';
  return (
    <div ref={ref} className="bezel">
      <Comp onClick={onClick}
        className={cx('bezel-core group w-full text-left p-4 flex items-start gap-3.5', MOTION, onClick && 'hover:-translate-y-0.5 hover:shadow-lift active:translate-y-0')}>
        {Icon && <span className={cx('grid place-items-center size-11 rounded-xl shrink-0 bg-gradient-to-b ring-1', iconBg)}><Icon className="size-5" aria-hidden /></span>}
        <span className="min-w-0">
          <span className={cx('block text-[26px] font-bold leading-none tabular-nums tracking-tight', tone === 'red' && Number(value) > 0 ? 'text-red-600' : 'text-ink')}>
            {typeof value === 'number' ? <CountUp value={value} /> : value}
          </span>
          <span className="block text-[13px] font-medium text-slate-500 mt-2">{label}</span>
          {hint && <span className="block text-xs text-slate-500 mt-0.5">{hint}</span>}
        </span>
      </Comp>
    </div>
  );
}

/* ---------------------------------------------------------------- Tables */

/** Scrollable table region; focusable so keyboard users can scroll it too. */
export function Table({ head, children, className, label = 'Table' }: { head: ReactNode[]; children: ReactNode; className?: string; label?: string }) {
  return (
    <div className={cx('overflow-x-auto', className)} tabIndex={0} role="region" aria-label={label}>
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            {head.map((h, i) => <th key={i} scope="col" className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 whitespace-nowrap bg-slate-50/70">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) =>
  <td className={cx('px-5 py-3.5 align-middle', className)}>{children}</td>;

/* ---------------------------------------------------------------- Tabs (segmented control) */

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string; count?: number }[] }) {
  return (
    <div className="mb-6 overflow-x-auto [scrollbar-width:none] -mx-1 px-1 py-1">
      <div role="tablist" className="inline-flex gap-1 rounded-full bg-ink/[0.045] p-1 ring-1 ring-ink/[0.05]">
        {items.map((t) => {
          const on = value === t.value;
          return (
            <button key={t.value} role="tab" aria-selected={on} onClick={() => onChange(t.value)}
              className={cx('relative h-9 px-4 rounded-full text-sm font-medium whitespace-nowrap', MOTION,
                on ? 'bg-white text-ink shadow-[0_1px_2px_rgb(16_24_40/0.06),0_4px_12px_-6px_rgb(16_24_40/0.18)] ring-1 ring-ink/[0.06]' : 'text-slate-500 hover:text-ink')}>
              {t.label}
              {t.count !== undefined && <span className={cx('ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums', on ? 'bg-brand-50 text-brand-800' : 'bg-ink/[0.06] text-slate-600')}>{t.count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Modal */

export function Modal({ title, description, onClose, children, footer, wide }:
  { title: string; description?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button:not([data-close])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) { // keep focus inside the dialog
        const els = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select, textarea')];
        if (!els.length) return;
        if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els.at(-1)!.focus(); }
        else if (!e.shiftKey && document.activeElement === els.at(-1)) { e.preventDefault(); els[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; prev?.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="absolute inset-0 bg-ink-900/40 backdrop-blur-sm animate-fade-in" onClick={onClose} aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={cx('relative w-full animate-pop-in sm:rounded-[28px] rounded-t-[28px] bg-white/60 p-1.5 ring-1 ring-white/50 shadow-pop', wide ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
        <div className="bezel-core rounded-[22px]! max-h-[90dvh] flex flex-col overflow-hidden">
          <header className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
              {description && <p className="text-sm text-slate-500 mt-1">{description}</p>}
            </div>
            <IconButton data-close label="Close" icon={X} onClick={onClose} className="-mr-2 -mt-1" />
          </header>
          <div className="px-6 pb-6 overflow-y-auto">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 px-6 py-4 border-t border-line/80 bg-slate-50/70">{footer}</footer>}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Toasts */

type Toast = { id: number; tone: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed z-[60] bottom-5 right-5 left-5 sm:left-auto flex flex-col items-end gap-2 sm:w-[26rem] pointer-events-none">
        {toasts.map((t) => {
          const Icon = t.tone === 'success' ? CheckCircle2 : t.tone === 'error' ? AlertCircle : Info;
          return (
            <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex items-start gap-3 rounded-2xl bg-ink-900/95 backdrop-blur text-white pl-4 pr-2 py-3 shadow-pop ring-1 ring-white/10 animate-pop-in text-sm">
              <Icon className={cx('size-5 shrink-0', t.tone === 'success' ? 'text-emerald-400' : t.tone === 'error' ? 'text-red-400' : 'text-sky-300')} aria-hidden />
              <span className="flex-1 pt-px">{t.text}</span>
              <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss" className="grid place-items-center size-6 rounded-full text-slate-300 hover:text-white hover:bg-white/10"><X className="size-4" /></button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ---------------------------------------------------------------- Confirm dialog */

interface ConfirmOpts { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; input?: { label: string; required?: boolean; placeholder?: string } }
type ConfirmFn = (o: ConfirmOpts) => Promise<false | { value: string }>;
const ConfirmCtx = createContext<ConfirmFn>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: false | { value: string }) => void }) | null>(null);
  const [value, setValue] = useState('');
  const confirm = useCallback<ConfirmFn>((o) => new Promise((resolve) => { setValue(''); setState({ ...o, resolve }); }), []);
  const close = (v: false | { value: string }) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => close(false)} footer={
          <>
            <Button variant="secondary" onClick={() => close(false)}>Cancel</Button>
            <Button variant={state.danger ? 'dark' : 'primary'} className={state.danger ? 'bg-red-600! hover:bg-red-700! text-white!' : ''}
              disabled={!!state.input?.required && value.trim().length < 3} onClick={() => close({ value: value.trim() })}>
              {state.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }>
          {state.body && <div className="text-sm text-slate-600 mb-4">{state.body}</div>}
          {state.input && (
            <Field label={state.input.label}><Textarea autoFocus value={value} placeholder={state.input.placeholder} onChange={(e) => setValue(e.target.value)} /></Field>
          )}
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

/* ---------------------------------------------------------------- Data loading */

/** Small data-loading hook: returns [data, error, reload, loading]. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): [T | undefined, unknown, () => void, boolean] {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setError(undefined);
    setLoading(true);
    fn().then((d) => live && setData(d)).catch((e) => live && setError(e)).finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return [data, error, () => setN((x) => x + 1), loading];
}

/** Runs an async action with busy state, toast on success, and error capture. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await fn();
      if (success) toast(success);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { busy, run };
}
