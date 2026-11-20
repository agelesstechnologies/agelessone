import { useEffect, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import type { DesignAccessInfo } from '@ageless/shared';
import { downloadFile, errText } from '../../api';
import { invalidate } from '../../query';
import type { Tone } from '../../ui';

/** After any change in Design: every cached Design answer (lists, jobs, drawings, reports) is read again. */
export const refreshDesign = () => invalidate('/design');

/** Shared bits of the Design screens (jobs, drawings, QC, transmittals, reports). */

export const JOB_STATUS_LABEL: Record<string, string> = {
  received: 'Received', accepted: 'Accepted', in_design: 'In design', on_hold: 'On hold', closed: 'Closed', cancelled: 'Cancelled',
};
export const JOB_TONE: Record<string, Tone> = { received: 'amber', accepted: 'blue', in_design: 'blue', on_hold: 'red', closed: 'green', cancelled: 'gray' };
export const REV_LABEL: Record<string, string> = {
  draft: 'Draft', submitted: 'Waiting for QC', qc_approved: 'QC approved', changes_needed: 'Changes needed', issued: 'Issued',
  accepted: 'Accepted by client', returned: 'Returned by client', superseded: 'Superseded', no_revision: 'No revision yet',
};
export const REV_TONE: Record<string, Tone> = {
  draft: 'gray', submitted: 'amber', qc_approved: 'blue', changes_needed: 'red', issued: 'blue', accepted: 'green', returned: 'red', superseded: 'gray', no_revision: 'gray',
};
export const PURPOSE_LABEL: Record<string, string> = { for_approval: 'For approval', for_construction: 'For construction', for_information: 'For information' };
/** The disciplines of policy design.disciplines as shipped; the server has the final list (and says so when one is wrong). */
export const DISCIPLINES: { code: string; name: string }[] = [
  { code: 'MEC', name: 'Mechanical' }, { code: 'ELE', name: 'Electrical' }, { code: 'IOT', name: 'IoT' }, { code: 'SW', name: 'Software' },
  { code: 'CGI', name: 'CGI' }, { code: 'ARC', name: 'Architecture' },
];
export const disciplineName = (code: string) => DISCIPLINES.find((d) => d.code === code)?.name ?? code;
export const FILE_KIND_LABEL: Record<string, string> = { pdf: 'Drawing PDF', source: 'Source', bom: 'BOM' };
/** What each file input offers (the server checks the bytes). */
export const ACCEPT = {
  pdf: 'application/pdf,.pdf',
  source: '.dwg,.dxf,.step,.stp,.igs,.iges,.sldprt,.sldasm,.slddrw,.ipt,.iam,.idw,.skp,.3dm,.f3d,.zip',
  bom: '.csv,.xlsx,.pdf',
  markup: 'application/pdf,image/jpeg,image/png',
  attachment: '.pdf,.jpg,.jpeg,.png,.docx,.txt,.csv,.xlsx,.dwg,.dxf,.step,.stp,.igs,.iges,.sldprt,.sldasm,.slddrw,.ipt,.iam,.idw,.skp,.3dm,.f3d,.zip',
};

export const fileSize = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
export const stampIst = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const dateIst = (iso: string): string => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

/** The part of the address after #design/, e.g. ['jobs', '<id>']; follows the browser's back and forward. */
export function useDesignRoute(): string[] {
  const read = () => window.location.hash.replace(/^#/, '').split('/').slice(1).filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}
export const goDesign = (...parts: string[]) => { window.location.hash = ['design', ...parts].join('/'); };

/** The companies whose design work the person sees (and that take design jobs). */
export const viewedCompanies = (a: DesignAccessInfo) => a.companies.filter((c) => c.enabled && (c.view || c.manage || c.qc));
export const accessIn = (a: DesignAccessInfo, company: string) => a.companies.find((c) => c.company === company);

/** Downloads a file of the API (with the sign-in token). */
export function DownloadButton({ path, name, label, onError, primary }: { path: string; name: string; label?: string; onError: (m: string) => void; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { await downloadFile(path, name); } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  }
  return <button type="button" className={primary ? 'primary-btn' : 'outline-btn'} disabled={busy} onClick={() => void go()} title={name}>
    <Download size={13} /> {busy ? 'Preparing…' : label ?? name}</button>;
}

/** A button that opens the file picker and uploads what is chosen at once. */
export function UploadButton({ label, accept, multiple, busy, onFiles }: { label: string; accept: string; multiple?: boolean; busy?: boolean; onFiles: (f: File[]) => Promise<void> }) {
  return <label className="outline-btn" style={{ cursor: busy ? 'wait' : 'pointer' }}><Upload size={13} /> {busy ? 'Uploading…' : label}
    <input type="file" accept={accept} multiple={multiple} hidden disabled={busy}
      onChange={(e) => { const i = e.currentTarget; const files = [...(i.files ?? [])]; if (files.length) void onFiles(files).then(() => { i.value = ''; }); }} /></label>;
}
