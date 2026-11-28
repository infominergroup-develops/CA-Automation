import { gstLabel } from '../gst';
import { Field, Select } from './ui';

/** Which GST registration (state) a task is for. Shown only for a client registered in more than one state. */
export function GstStateField({ gstins, value, onChange }: { gstins: string[] | undefined; value: string; onChange: (gstin: string) => void }) {
  if (!gstins || gstins.length < 2) return null;
  return (
    <Field label="GST state" optional>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not for one state</option>
        {gstins.map((g) => <option key={g} value={g}>{gstLabel(g)}</option>)}
      </Select>
    </Field>
  );
}
