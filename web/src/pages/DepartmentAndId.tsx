import { useEffect, useState } from 'react';
import type { Department, NextEmployeeCode } from '@ageless/shared';
import { api, errText } from '../api';
import { useLoad } from '../hooks';

/** What a new job sends: the department's code prefix, and an employee ID only when one was typed (else it is generated). */
export interface JobCodes { departmentCode?: string; employeeCode?: string }

/**
 * Department and employee ID of a new job (Add person, Add an employment). The ID is automatic: the next number for the
 * department's prefix (ATS004 …), shown here and assigned when saving, so two people saved at once never get the same one.
 * `mayTypeId` (HR): "Use an existing employee ID" lets them type one, e.g. for staff brought over with their old code.
 */
export default function DepartmentAndId({ company, idPrefix, mayTypeId, onChange }: {
  company: string; idPrefix: string; mayTypeId: boolean; onChange: (v: JobCodes) => void;
}) {
  const depts = useLoad(() => api<Department[]>(`/hrms/departments?company=${company}`), [company]);
  const [department, setDepartment] = useState('');   // the department's publicId
  const [next, setNext] = useState('');
  const [own, setOwn] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const dept = depts.data?.find((d) => d.publicId === department);
  const none = !depts.loading && !depts.error && (depts.data?.length ?? 0) === 0;

  // another company: its departments are different
  useEffect(() => { setDepartment(''); setNext(''); setError(''); }, [company]);
  // the next ID for the chosen department (shown only: the server assigns it on save)
  useEffect(() => {
    if (!department) { setNext(''); return; }
    let live = true;
    api<NextEmployeeCode>(`/hrms/departments/${department}/next-employee-code`)
      .then((n) => { if (live) { setNext(n.code); setError(''); } })
      .catch((e) => { if (live) setError(errText(e)); });
    return () => { live = false; };
  }, [department]);
  useEffect(() => {
    onChange({ departmentCode: dept?.codePrefix, employeeCode: own ? (typed.trim() || undefined) : undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dept?.codePrefix, own, typed]);

  return <>
    <label>Department
      <select id={`${idPrefix}-dept`} value={department} onChange={(e) => setDepartment(e.target.value)} required key={`${company}${depts.data?.length ?? 0}`}>
        <option value="">{depts.loading ? 'Loading…' : none ? 'No departments yet' : 'Choose'}</option>
        {depts.data?.map((d) => <option key={d.publicId} value={d.publicId}>{d.name} ({d.codePrefix})</option>)}</select></label>
    <label>Employee ID {!own && <span className="optional">automatic</span>}
      {own
        ? <input id={`${idPrefix}-code`} value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={20} required placeholder="The existing ID, e.g. ATS015" autoFocus />
        : <input id={`${idPrefix}-code`} value={next} readOnly tabIndex={-1} placeholder={department ? 'Loading…' : 'Choose a department first'} />}</label>
    {!own && next && <p className="span-two muted-text">{next} is the next number in {dept?.name}; it is given when you save.</p>}
    {none && <p className="span-two field-error">{company} has no departments yet, so no employee ID can be made. HR adds departments under Organisation.</p>}
    {mayTypeId && <label className="span-two check-label"><input type="checkbox" checked={own} onChange={(e) => { setOwn(e.target.checked); setTyped(''); }} />
      Use an existing employee ID (staff brought over with their old code)</label>}
    {error && <p className="span-two field-error">{error}</p>}
  </>;
}
