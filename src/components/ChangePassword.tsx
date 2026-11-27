import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorText, Field, Input, Modal, useToast } from './ui';

/** Anyone signed in changes their own password (Firebase Authentication); other devices are signed out. */
export function ChangePassword({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const mismatch = again.length > 0 && again !== next;
  const save = async () => {
    setBusy(true); setErr(undefined);
    try { await api('/me/password', { body: { current, next } }); toast('Password changed. Other devices were signed out.'); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Change my password" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save} disabled={!current || !next || next !== again}>Change password</Button></>}>
      <div className="space-y-4">
        <Field label="Current password"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint="12+ characters with letters and numbers"><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="Confirm new password" error={mismatch ? 'Passwords do not match.' : undefined}><Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}
