import { useState, type ReactNode } from 'react';
import { Ban, Check, ShieldCheck, Timer } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { InfominerLogo } from '../components/InfominerLogo';
import { Button, ErrorText, LoadingRows, useLoad } from '../components/ui';

export interface Notice {
  version: string;
  firm: string;
  purposes: { code: string; required: boolean; label: string }[];
  dataCollected: string[];
  rights: string[];
  retention: string;
  security: string;
  grievanceOfficer: { name: string; email: string; phone: string };
  responseDays: number;
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section>
    <h3 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 mb-2">{title}</h3>
    <div className="text-sm text-slate-700 leading-relaxed">{children}</div>
  </section>
);

export function NoticeBody({ n }: { n: Notice }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-700 leading-relaxed">
        <b className="text-ink">{n.firm}</b> processes your personal data only to provide the services you engaged us for.
        This notice is given under the Digital Personal Data Protection Act, 2023 <span className="text-slate-400">(version {n.version})</span>.
      </p>
      <Section title="What we collect"><ul className="list-disc pl-5 space-y-1">{n.dataCollected.map((d) => <li key={d}>{d}</li>)}</ul></Section>
      <Section title="Your rights"><ul className="list-disc pl-5 space-y-1">{n.rights.map((d) => <li key={d}>{d}</li>)}</ul></Section>
      <Section title="How long we keep it">{n.retention}</Section>
      <Section title="How we protect it">{n.security}</Section>
      <Section title="Grievance Officer">
        {n.grievanceOfficer.name || 'To be appointed'}
        {n.grievanceOfficer.email && <> · <a className="text-brand-700 underline" href={`mailto:${n.grievanceOfficer.email}`}>{n.grievanceOfficer.email}</a></>}
        {n.grievanceOfficer.phone && ` · ${n.grievanceOfficer.phone}`}. We respond within {n.responseDays} days.
      </Section>
    </div>
  );
}

function GateShell({ icon: Icon, title, children }: { icon: typeof ShieldCheck; title: string; children: ReactNode }) {
  return (
    <div className="min-h-dvh py-8 sm:py-14 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6"><InfominerLogo size="sm" /></div>
        <div className="bezel rounded-[28px]! animate-pop-in"><div className="bezel-core rounded-[23px]! overflow-hidden">
          <div className="px-6 sm:px-8 pt-7 pb-5 border-b border-line flex items-center gap-3">
            <span className="grid place-items-center size-11 rounded-xl bg-brand-50 text-brand-700"><Icon className="size-6" aria-hidden /></span>
            <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          </div>
          {children}
        </div></div>
      </div>
    </div>
  );
}

/** Clients must give informed, specific consent before their data is processed in the portal. */
export function ConsentGate() {
  const { refresh, logout } = useAuth();
  const [notice, error] = useLoad(() => api<Notice>('/privacy/notice'));
  const [chosen, setChosen] = useState<string[]>(['service']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const toggle = (c: string) => setChosen((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));

  const accept = async () => {
    setBusy(true); setErr(undefined);
    try {
      await api('/privacy/consent', { body: { purposes: chosen, version: notice!.version } });
      await refresh();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <GateShell icon={ShieldCheck} title="Before you continue: your privacy">
      <div className="px-6 sm:px-8 py-6 space-y-6">
        <ErrorText error={error} />
        {!notice ? <LoadingRows /> : (
          <>
            <div className="max-h-[42dvh] overflow-y-auto pr-2 -mr-2"><NoticeBody n={notice} /></div>
            <fieldset className="rounded-2xl ring-1 ring-ink/[0.07] bg-slate-50/60 p-4 space-y-3">
              <legend className="px-1 text-sm font-semibold text-ink">I consent to my personal data being used for</legend>
              {notice.purposes.map((p) => {
                const on = chosen.includes(p.code);
                return (
                  <label key={p.code} className={`flex gap-3 items-start rounded-lg p-2 -m-2 ${p.required ? '' : 'hover:bg-white'}`}>
                    <input type="checkbox" className="mt-0.5 size-4 accent-brand-500" checked={on} disabled={p.required} onChange={() => toggle(p.code)} />
                    <span className="text-sm text-slate-700">{p.label}{p.required && <span className="block text-xs text-slate-500 mt-0.5">Needed to use the portal</span>}</span>
                  </label>
                );
              })}
            </fieldset>
            <p className="text-xs text-slate-500">You can withdraw consent any time from <b>Privacy &amp; data</b>. Withdrawing is as easy as giving it.</p>
            <ErrorText error={err} />
          </>
        )}
      </div>
      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 px-6 sm:px-8 py-4 border-t border-line bg-slate-50/60">
        <Button variant="secondary" icon={Ban} onClick={() => logout()}>Decline and sign out</Button>
        <Button busy={busy} icon={Check} onClick={accept} disabled={!notice}>I agree</Button>
      </div>
    </GateShell>
  );
}

/** Staff are told, once and in writing, what the portal records about their work. */
export function MonitoringNotice() {
  const { refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const ack = async () => {
    setBusy(true);
    await api('/me/monitoring-ack', { body: {} }).finally(() => setBusy(false));
    await refresh();
  };
  return (
    <GateShell icon={Timer} title="What this portal records about your work">
      <div className="px-6 sm:px-8 py-6 grid sm:grid-cols-2 gap-6">
        <Section title="Recorded">
          <ul className="space-y-2">
            {['Time you log with the task timer, and manual entries', 'Whether you were active while a timer ran (15 minutes idle is not counted)',
              'Sign-in time, IP address and device', 'Every client document you open or download, and every task action'].map((t) => (
              <li key={t} className="flex gap-2"><Check className="size-4 mt-0.5 text-emerald-600 shrink-0" aria-hidden />{t}</li>
            ))}
          </ul>
        </Section>
        <Section title="Never recorded">
          <ul className="space-y-2">
            {['Screenshots or screen recording', 'Camera or microphone', 'Keystrokes', 'Browsing outside this portal, or location'].map((t) => (
              <li key={t} className="flex gap-2"><Ban className="size-4 mt-0.5 text-red-500 shrink-0" aria-hidden />{t}</li>
            ))}
          </ul>
        </Section>
        <p className="sm:col-span-2 text-sm text-slate-600">Used for client billing, workload planning and keeping client data confidential. You can download your own records any time from <b>Privacy &amp; data</b>.</p>
      </div>
      <div className="flex justify-end px-6 sm:px-8 py-4 border-t border-line bg-slate-50/60">
        <Button busy={busy} icon={Check} onClick={ack}>I have read this</Button>
      </div>
    </GateShell>
  );
}
