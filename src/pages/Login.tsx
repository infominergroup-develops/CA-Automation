import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Building2, Fingerprint, KeyRound, Lock, ShieldCheck, UserRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEntrance } from '../motion';
import { api } from '../api';
import { useAuth } from '../auth';
import { InfominerLogo } from '../components/InfominerLogo';
import { Button, ErrorText, Field, Input } from '../components/ui';

const TRUST = [
  { icon: Lock, title: 'Encrypted documents', text: 'Every file is encrypted before storage and fingerprinted against tampering.' },
  { icon: KeyRound, title: 'One-time code sign-in', text: 'A fresh code on every sign-in, sent to your registered number.' },
  { icon: Fingerprint, title: 'Complete audit trail', text: 'Every view and download is recorded in a tamper-evident log.' },
  { icon: ShieldCheck, title: 'DPDP Act, 2023', text: 'Data hosted in India and processed only with your consent.' },
];

/** Decorative echo of the logo mark. */
function Mark() {
  return (
    <svg viewBox="0 0 364 416" className="absolute -right-24 -bottom-24 w-[520px] opacity-[0.07]" aria-hidden>
      <polygon points="0,110 212,0 212,210 0,318" fill="#e8a020" />
      <polygon points="77,157 289,48 289,258 77,366" fill="#eb8a23" />
      <polygon points="151,208 363,99 363,307 151,416" fill="#ffffff" />
    </svg>
  );
}

export function Login() {
  const { refresh } = useAuth();
  const [mode, setMode] = useState<'client' | 'staff'>('client');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<{ challengeId: string; sentTo: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const requestCode = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const r = await api<{ challengeId: string; sentTo: string; signedIn?: boolean }>('/auth/login', { body: mode === 'client' ? { mode, identifier } : { mode, identifier, password } });
      // Server has OTP turned off: the password alone started the session.
      if (r.signedIn) { setPassword(''); await refresh(); return; }
      setChallenge(r);
      setCode('');
      setResendIn(30);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await api('/auth/verify', { body: { challengeId: challenge!.challengeId, code } });
      setPassword('');
      await refresh();
    } catch (err) { setError(err); setCode(''); } finally { setBusy(false); }
  };

  const back = () => { setChallenge(null); setCode(''); setError(undefined); };

  // Entrance: the brand panel settles first, then the trust points, then the form.
  const stage = useEntrance((tl, q) => {
    tl.from(q('[data-a="mark"]'), { autoAlpha: 0, scale: 0.92, rotate: -4, duration: 1.4 }, 0)
      .from(q('[data-a="logo"]'), { autoAlpha: 0, y: -8 }, 0.1)
      .from(q('[data-a="line"]'), { autoAlpha: 0, y: 28, stagger: 0.12 }, 0.2)
      .from(q('[data-a="trust"]'), { autoAlpha: 0, y: 16, stagger: 0.07 }, 0.55)
      .from(q('[data-a="form"]'), { autoAlpha: 0, y: 20, scale: 0.985 }, 0.3);
  });

  return (
    <div ref={stage} className="min-h-dvh grid lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden m-3 rounded-[30px] bg-gradient-to-br from-ink via-ink to-ink-900 text-white p-12 xl:p-16 shadow-pop">
        <div data-a="mark" aria-hidden className="pointer-events-none absolute inset-0"><Mark /></div>
        <div aria-hidden className="absolute inset-0 rounded-[30px] ring-1 ring-inset ring-white/10" />
        <div className="relative" data-a="logo"><InfominerLogo size="md" variant="light" tagline="Chartered Accountants" /></div>
        <div className="relative max-w-lg">
          <span data-a="line" className="eyebrow bg-white/10! text-brand-200! ring-white/15! mb-6">Client portal</span>
          <h1 className="text-4xl xl:text-[48px] font-bold leading-[1.06] text-white">
            <span data-a="line" className="block">Your books, documents</span>
            <span data-a="line" className="block">and filings, <span className="text-brand-300">in one</span></span>
            <span data-a="line" className="block text-brand-300">secure place.</span>
          </h1>
          <ul className="mt-12 grid grid-cols-2 gap-3">
            {TRUST.map((t) => (
              <li key={t.title} data-a="trust" className="rounded-2xl bg-white/[0.05] ring-1 ring-white/10 p-4">
                <span className="grid place-items-center size-9 rounded-xl bg-white/10 mb-3"><t.icon className="size-[18px] text-brand-300" aria-hidden /></span>
                <div className="text-sm font-semibold">{t.title}</div>
                <div className="text-[13px] text-slate-300 mt-0.5 leading-relaxed">{t.text}</div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-slate-300/80">Authorised users only. Unauthorised access is an offence under the Information Technology Act, 2000.</p>
      </aside>

      <main className="flex flex-col justify-center px-4 py-10 sm:px-12">
        <div data-a="form" className="w-full max-w-[26rem] mx-auto bezel rounded-[30px]! p-1.5!">
        <div className="bezel-core rounded-[24px]! px-6 py-8 sm:px-8 sm:py-10">
          <div className="lg:hidden mb-10"><InfominerLogo size="md" tagline="Chartered Accountants" /></div>

          {!challenge ? (
            <>
              <h2 className="text-[28px] font-bold">Sign in</h2>
              <p className="text-sm text-slate-500 mt-1">Choose how you work with us.</p>

              <div className="mt-6 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Account type">
                {([['client', 'I am a client', Building2], ['staff', 'Firm staff', UserRound]] as const).map(([m, label, Icon]) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => { setMode(m); setError(undefined); }}
                    className={`flex flex-col items-start gap-2 rounded-2xl p-3.5 text-left transition-all duration-300 ease-(--ease-fluid) active:scale-[0.98] ${
                      mode === m ? 'bg-brand-50 ring-2 ring-brand-500 shadow-[0_6px_18px_-10px_rgb(235_138_35/0.8)]' : 'bg-white ring-1 ring-ink/10 hover:ring-ink/25'}`}>
                    <Icon className={`size-5 ${mode === m ? 'text-brand-700' : 'text-slate-400'}`} aria-hidden />
                    <span className="text-sm font-semibold text-ink">{label}</span>
                  </button>
                ))}
              </div>

              <form onSubmit={requestCode} className="mt-6 space-y-4" noValidate>
                <Field label={mode === 'client' ? 'Registered mobile number or email' : 'Work email'}>
                  <Input autoFocus required autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)}
                    inputMode={mode === 'client' ? 'tel' : 'email'} type={mode === 'staff' ? 'email' : 'text'}
                    placeholder={mode === 'client' ? '98765 43210' : 'name@firm.in'} />
                </Field>
                {mode === 'staff' && (
                  <Field label="Password">
                    <Input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </Field>
                )}
                <ErrorText error={error} />
                <Button type="submit" busy={busy} trailing={ArrowRight} disabled={!identifier || (mode === 'staff' && !password)} className="w-full h-12">
                  {mode === 'client' ? 'Send one-time code' : 'Continue'}
                </Button>
              </form>
              <p className="mt-6 text-xs text-slate-500 leading-relaxed">
                {mode === 'client'
                  ? "Don't have access yet? Ask your relationship manager at the firm to add your mobile number."
                  : 'After your password, a one-time code is sent to your registered mobile.'}
              </p>
            </>
          ) : (
            <form onSubmit={verify} className="space-y-5">
              <button type="button" onClick={back} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-500 hover:text-ink">
                <ArrowLeft className="size-4" aria-hidden />Back
              </button>
              <div>
                <h2 className="text-[28px] font-bold">Enter your code</h2>
                <p className="text-sm text-slate-500 mt-1">
                  If this account exists, we sent a 6-digit code to <b className="text-ink">{challenge.sentTo}</b>. It expires in 5 minutes.
                </p>
              </div>
              <Field label="One-time code">
                <Input autoFocus required inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6}
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="h-14! text-center text-2xl font-mono tracking-[0.6em] pl-[0.6em]" aria-label="6-digit code" />
              </Field>
              <ErrorText error={error} />
              <Button type="submit" busy={busy} trailing={ArrowRight} disabled={code.length !== 6} className="w-full h-12">Verify and sign in</Button>
              <div className="text-center text-sm text-slate-500">
                {resendIn > 0 ? <>Resend code in <span className="tabular-nums">{resendIn}s</span></> : (
                  <button type="button" onClick={() => requestCode()} className="font-semibold text-brand-700 hover:underline">Resend code</button>
                )}
              </div>
            </form>
          )}
        </div>
        </div>
        <p className="mt-6 text-center text-xs text-slate-500">
          By signing in you agree to our{' '}
          <Link to="/privacy-policy" className="font-medium text-brand-700 hover:underline underline-offset-2">Privacy Policy</Link>.
        </p>
      </main>
    </div>
  );
}
