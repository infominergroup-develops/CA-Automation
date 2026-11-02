import { Link } from 'react-router-dom';
import { ArrowLeft, Printer, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { InfominerLogo } from '../components/InfominerLogo';
import { Button, ErrorText, LoadingRows, useLoad } from '../components/ui';
import { NoticeBody, type Notice } from './Gates';

/**
 * Public, shareable privacy policy. Reachable at /privacy-policy without signing in (routed before the auth
 * gate in App.tsx) and served the notice from the public /api/privacy/notice endpoint. Clients can be sent
 * this link directly; it is the same DPDP notice they accept inside the portal.
 */
export function PrivacyPolicy() {
  const [notice, error, , loading] = useLoad(() => api<Notice>('/privacy/notice'));
  const firm = notice?.firm || 'Infominer';

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 bg-canvas/80 backdrop-blur-xl border-b border-line/70 print:hidden">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <Link to="/" aria-label={`${firm} home`}><InfominerLogo size="sm" /></Link>
          <Link to="/" className="group inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-ink">
            <ArrowLeft className="size-4 transition-transform duration-300 ease-(--ease-fluid) group-hover:-translate-x-0.5" aria-hidden />
            Back to sign in
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
        <div className="eyebrow mb-4"><ShieldCheck className="size-3.5" aria-hidden />Digital Personal Data Protection Act, 2023</div>
        <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
          <div>
            <h1 className="text-[30px] sm:text-[38px] font-bold leading-[1.1]">Privacy Policy</h1>
            <p className="text-sm text-slate-500 mt-2">
              How {firm} collects, uses and protects your personal data.
              {notice && <> Version {notice.version}.</>}
            </p>
          </div>
          <Button variant="secondary" icon={Printer} onClick={() => window.print()} className="print:hidden">Print / save PDF</Button>
        </div>

        <article className="bezel rounded-[28px]!">
          <div className="bezel-core rounded-[23px]! p-6 sm:p-9">
            {error ? <ErrorText error={error} /> : loading && !notice ? <LoadingRows rows={8} /> : notice && <NoticeBody n={notice} />}
          </div>
        </article>

        <footer className="mt-8 text-center text-xs text-slate-500">
          © {new Date().getFullYear()} {firm}. This notice is published under the DPDP Act, 2023. ·{' '}
          <Link to="/" className="underline underline-offset-2 hover:text-ink">Sign in to the portal</Link>
        </footer>
      </main>
    </div>
  );
}
