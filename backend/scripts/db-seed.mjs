// Fills YOUR development database (from DATABASE_URL) with fictional starter data. Safe to run again:
// rows that already exist are left alone. Run `pnpm db:migrate` first.
import 'dotenv/config';
import bcrypt from 'bcrypt';
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL ?? '');
const dbName = url.pathname.slice(1);
if (!dbName || /prod|staging/i.test(dbName) || !/^(dev_|ageless_dev|ageless_test|platform_test)/.test(dbName)) {
  console.error(`Refusing to seed "${dbName}". Only development databases (dev_*, ageless_dev, ageless_test) can be seeded.`);
  process.exit(1);
}

/** Development password for every demo login. Never use it anywhere real. */
const DEMO_PASSWORD = 'demo-pass-1';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Fixed public ids, so the same people, logins and roles exist on every PC.
// Demo Supervisor is on site only (site work of the tickets they supervise): nobody reports to them, and they add no
// people, create no logins and approve nothing. Demo Manager leads the AE team (second job in AE, see below).
const people = [
  { n: 1, display: 'Demo Supervisor', full: 'Demo Supervisor One', company: 'AE', code: 'AE-D001', phone: '+910000000001', email: 'demo.supervisor@example.com', role: 'supervisor', scope: 'team' },
  { n: 2, display: 'Demo Technician', full: 'Demo Technician Two', company: 'AE', code: 'AE-D002', phone: '+910000000002', email: 'demo.technician@example.com', role: 'employee', scope: 'own', manager: 9 },
  { n: 3, display: 'Demo Engineer', full: 'Demo Engineer Three', company: 'ATPL', code: 'ATPL-D001', phone: null, email: 'demo.engineer@example.com', role: 'employee', scope: 'own' },
  { n: 4, display: 'Demo HR', full: 'Demo HR Four', company: 'AE', code: 'AE-D003', phone: null, email: 'demo.hr@example.com', role: 'hr', scope: 'all' },
  { n: 5, display: 'Demo Admin', full: 'Demo Admin Five', company: 'ATPL', code: 'ATPL-D002', phone: null, email: 'demo.admin@example.com', role: 'system_admin', scope: 'all', grantedBy: 4 },
  { n: 6, display: 'Demo CEO', full: 'Demo CEO Six', company: 'AE', code: 'AE-D004', phone: null, email: 'demo.ceo@example.com', role: 'ceo', scope: 'team' },
  // Designing (ATPL): Demo Head heads the department; Demo Manager reports to Demo Head. Both lead with the Manager role;
  // a department head is whoever is set as head of the department (no separate role). (n 7 is skipped: …0107 is in use.)
  { n: 8, display: 'Demo Head', full: 'Demo Head Eight', company: 'ATPL', code: 'ATPL-D004', phone: '+910000000008', email: 'demo.head@example.com', role: 'manager', scope: 'team',
    department: 'ATD', designation: 'Senior Designer', heads: 'ATD' },
  { n: 9, display: 'Demo Manager', full: 'Demo Manager Nine', company: 'ATPL', code: 'ATPL-D005', phone: '+910000000009', email: 'demo.manager@example.com', role: 'manager', scope: 'team',
    department: 'ATD', designation: 'Designer', manager: 8 },
];

// Roles for tenant 1 and their permissions (the permission list itself comes from migration 0005).
const HR = ['hrms.people.view', 'hrms.people.create', 'hrms.letters.manage', 'hrms.people.update', 'hrms.contacts.manage', 'hrms.contacts.review', 'hrms.employments.manage', 'hrms.employments.update',
  'hrms.expenses.submit', 'hrms.expenses.approve', 'hrms.expenses.pay', 'hrms.expenses.report',
  'hrms.attendance.punch', 'hrms.attendance.view', 'hrms.attendance.rebuild', 'hrms.attendance.approve', 'hrms.calendar.manage',
  'hrms.leave.apply', 'hrms.leave.approve', 'hrms.leave.manage', 'hrms.leave.report', 'core.policies.manage', 'hrms.positions.manage',
  'hrms.skills.manage', 'hrms.skills.add', 'hrms.skills.verify', 'hrms.skills.view', 'hrms.month.lock', 'payroll.payslip.own',
  'hrms.dashboard.view', 'hrms.private.view', 'hrms.private.manage', 'tickets.types.view', 'tickets.view', 'tickets.numbering.manage'];
const roles = [
  { code: 'employee', name: 'Employee', permissions: ['hrms.people.view', 'hrms.expenses.submit', 'hrms.attendance.punch', 'hrms.leave.apply',
    'hrms.skills.add', 'hrms.skills.view', 'payroll.payslip.own', 'tickets.types.view', 'tickets.view', 'tickets.work'] },
  // Manager: leads a team: approvals, add people and logins, create and run tickets, the full report of tickets they
  // manage (tickets.report). (Was the Supervisor role.)
  { code: 'manager', name: 'Manager', permissions: ['hrms.people.view', 'hrms.people.create', 'hrms.employments.update', 'hrms.expenses.submit', 'hrms.expenses.approve',
    'hrms.attendance.punch', 'hrms.attendance.view', 'hrms.attendance.approve', 'hrms.leave.apply', 'hrms.leave.approve', 'hrms.leave.report',
    'hrms.skills.add', 'hrms.skills.verify', 'hrms.skills.view', 'hrms.dashboard.view', 'payroll.payslip.own',
    'tickets.types.view', 'tickets.types.manage', 'tickets.view', 'tickets.work', 'tickets.manage', 'tickets.create', 'tickets.time.adjust', 'tickets.report',
    'core.users.team'] },
  // Supervisor: on site only: own self-service plus the site work of the tickets they supervise (tickets.site).
  { code: 'supervisor', name: 'Supervisor', permissions: ['hrms.people.view', 'hrms.expenses.submit', 'hrms.attendance.punch', 'hrms.leave.apply',
    'hrms.skills.add', 'hrms.skills.view', 'payroll.payslip.own', 'tickets.types.view', 'tickets.view', 'tickets.work', 'tickets.site'] },
  // Payroll: prepares runs, salaries and bank details. Payroll Approver: approves runs (never one they prepared).
  { code: 'payroll', name: 'Payroll', permissions: ['payroll.prepare', 'payroll.payslip.own'] },
  { code: 'payroll_approver', name: 'Payroll Approver', permissions: ['payroll.approve', 'payroll.payslip.own'] },
  { code: 'hr', name: 'HR', permissions: HR },
  { code: 'admin_user', name: 'Admin user', permissions: ['tickets.types.view', 'tickets.types.manage', 'tickets.view', 'tickets.manage'] },
  { code: 'system_admin', name: 'System admin', permissions: ['core.users.manage', 'core.policies.manage', 'hrms.people.view', 'hrms.attendance.rebuild', 'hrms.month.unlock'] },
  // Last approver (after the manager, department head and HR); scope team: decides requests that name them.
  // Their own requests need no approval (policy hrms.approvals.auto_approve_roles). The CEO does not apply for leave.
  { code: 'ceo', name: 'CEO', permissions: ['hrms.people.view', 'hrms.expenses.submit', 'hrms.attendance.punch', 'hrms.attendance.approve', 'hrms.leave.approve', 'hrms.leave.report',
    'payroll.payslip.own', 'tickets.types.view'] },
  // Management (the CEO, scope all): reads every HRMS record and payroll, decides any pending request (never their own),
  // sees private details masked and may reveal them (audited); sees and manages every intercompany agreement.
  { code: 'management', name: 'Management', permissions: ['hrms.management', 'hrms.people.view', 'hrms.attendance.view', 'hrms.attendance.approve',
    'hrms.leave.approve', 'hrms.leave.report', 'hrms.expenses.approve', 'hrms.expenses.report', 'hrms.skills.view', 'hrms.dashboard.view',
    'hrms.private.view', 'hrms.private.reveal', 'hrms.letters.manage', 'payroll.payslip.own', 'tickets.types.view', 'tickets.types.manage', 'tickets.view', 'tickets.manage', 'tickets.time.adjust',
    'tickets.report', 'intercompany.view', 'intercompany.manage'] },
];
// Second roles: Demo HR runs payroll, Demo CEO approves it and has Management access (granted by Demo Admin).
// (n 227, Manager for Demo Supervisor, is no longer given: older databases have it ended below.)
const extraRoles = [{ n: 214, person: 4, role: 'payroll' }, { n: 216, person: 6, role: 'payroll_approver' }, { n: 226, person: 6, role: 'management' }];

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`INSERT INTO core.tenants (id, name) OVERRIDING SYSTEM VALUE VALUES (1, 'Ageless (development)') ON CONFLICT (id) DO NOTHING`);
  await client.query(`SELECT setval(pg_get_serial_sequence('core.tenants', 'id'), (SELECT max(id) FROM core.tenants))`);
  await client.query(`
    INSERT INTO core.legal_entities (tenant_id, code, name, legal_form) VALUES
      (1, 'AE', 'Ageless Entertainments', 'other'),
      (1, 'ATPL', 'Ageless Technologies', 'private_limited')
    ON CONFLICT (tenant_id, code) DO NOTHING`);

  // Leave types: Sick and Earned (paid, 1 day each a month: policy hrms.leave.monthly_accrual), Leave without pay
  // (unpaid). General leave stays for history but can no longer be applied for.
  await client.query(`INSERT INTO hrms.leave_types (tenant_id, code, name, policy_key, is_paid, is_active) VALUES
      (1, 'SL', 'Sick leave', 'hrms.leave.sl', true, true), (1, 'EL', 'Earned leave', 'hrms.leave.el', true, true),
      (1, 'LWP', 'Leave without pay', 'hrms.leave.lwp', false, true), (1, 'GL', 'General leave', 'hrms.leave.gl', true, false)
    ON CONFLICT (tenant_id, code) DO NOTHING`);

  // Ageless Technologies: departments (code prefix starts the employee codes: ATS001 ...; heads are set later by HR)
  // and the designations its positions use.
  for (const [name, prefix] of [
    ['Designing', 'ATD'], ['Software Development', 'ATS'], ['Hardware & IoT', 'ATH'], ['CGI Content Development', 'ATC'], ['HR & Accounts', 'ATHR'],
  ]) {
    await client.query(`INSERT INTO hrms.departments (tenant_id, legal_entity_id, name, code_prefix)
      SELECT 1, id, $1, $2 FROM core.legal_entities WHERE tenant_id = 1 AND code = 'ATPL'
      ON CONFLICT (legal_entity_id, code_prefix) DO NOTHING`, [name, prefix]);
  }
  for (const name of ['Designer', 'Senior Designer', '3D Designer', 'Senior Software Engineer', 'Developer', 'Intern', 'Engineer',
    'Senior IoT Design Engineer', 'Senior CG Content Developer', 'CG Artist', '3D/VFX Artist', 'HR Executive', 'Accounts Executive']) {
    await client.query(`INSERT INTO hrms.designations (tenant_id, legal_entity_id, name)
      SELECT 1, id, $1 FROM core.legal_entities WHERE tenant_id = 1 AND code = 'ATPL'
      ON CONFLICT (legal_entity_id, name) DO NOTHING`, [name]);
  }

  // Expense categories for tenant 1 (receipt_required: whether a receipt file must be attached).
  for (const [code, name, receiptRequired] of [
    ['fuel', 'Fuel', true], ['travel', 'Travel', true], ['food', 'Food', false], ['materials', 'Materials', true], ['other', 'Other', true],
  ]) {
    await client.query(`INSERT INTO hrms.expense_categories (tenant_id, code, name, receipt_required) VALUES (1, $1, $2, $3)
      ON CONFLICT (tenant_id, code) DO NOTHING`, [code, name, receiptRequired]);
  }

  for (const r of roles) {
    await client.query(`INSERT INTO core.roles (tenant_id, code, name) VALUES (1, $1, $2) ON CONFLICT (tenant_id, code) DO NOTHING`, [r.code, r.name]);
    await client.query(
      `INSERT INTO core.role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM core.roles r JOIN core.permissions p ON p.code = ANY($2::text[])
        WHERE r.tenant_id = 1 AND r.code = $1
       ON CONFLICT DO NOTHING`, [r.code, r.permissions]);
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const p of people) {
    await client.query(
      `INSERT INTO core.persons (tenant_id, public_id, person_type, display_name, full_name)
       VALUES (1, $1, 'employee', $2, $3) ON CONFLICT (public_id) DO NOTHING`,
      [id(p.n), p.display, p.full]);
    await client.query(
      `INSERT INTO hrms.employments (tenant_id, public_id, person_id, legal_entity_id, employee_code, employment_type, joined_on, is_primary)
       SELECT 1, $1, p.id, le.id, $2, 'permanent', DATE '2025-04-01', true
         FROM core.persons p JOIN core.legal_entities le ON le.tenant_id = 1 AND le.code = $4
        WHERE p.public_id = $3
       ON CONFLICT (public_id) DO NOTHING`,
      [id(100 + p.n), p.code, id(p.n), p.company]);
    await client.query(
      `INSERT INTO core.users (tenant_id, public_id, person_id, login_phone, login_email, password_hash)
       SELECT 1, $1, id, $2, $3, $4 FROM core.persons WHERE public_id = $5
       ON CONFLICT (person_id) DO NOTHING`,
      [id(300 + p.n), p.phone, p.email, passwordHash, id(p.n)]);
    // every login needs an email now (sign-in codes): fill one in for a demo login seeded before that rule
    if (p.email) {
      await client.query(`UPDATE core.users SET login_email = $1 WHERE public_id = $2 AND login_email IS NULL`, [p.email, id(300 + p.n)]);
    }
  }
  // Demo Supervisor also works in ATPL (second, non-primary job), so they can be named the on-site supervisor of tickets
  // in both companies (a ticket's supervisor must have an active job in the ticket's company).
  await client.query(
    `INSERT INTO hrms.employments (tenant_id, public_id, person_id, legal_entity_id, employee_code, employment_type, joined_on, is_primary)
     SELECT 1, $1, p.id, le.id, 'ATPL-D003', 'permanent', DATE '2025-04-01', false
       FROM core.persons p JOIN core.legal_entities le ON le.tenant_id = 1 AND le.code = 'ATPL'
      WHERE p.public_id = $2
     ON CONFLICT (public_id) DO NOTHING`,
    [id(107), id(1)]);
  // Demo Manager also works in AE (second, non-primary job): they lead the AE team there (Demo Technician reports to them),
  // add AE people and create their logins. Left alone if the job, the code or an active AE job of theirs already exists.
  await client.query(
    `INSERT INTO hrms.employments (tenant_id, public_id, person_id, legal_entity_id, employee_code, employment_type, joined_on, is_primary)
     SELECT 1, $1, p.id, le.id, 'AE-D005', 'permanent', DATE '2025-04-01', false
       FROM core.persons p JOIN core.legal_entities le ON le.tenant_id = 1 AND le.code = 'AE'
      WHERE p.public_id = $2
     ON CONFLICT DO NOTHING`,
    [id(110), id(9)]);

  // The 13 standard ticket types, for every company (is_standard: only admin user and Management may change them).
  // Written by Demo Admin; safe to run again (a type that exists is left alone).
  const F = (key, label, type, required = false) => ({ key, label, type, required });
  const rules = (...on) => Object.fromEntries(['photo_required', 'file_required', 'checklist_required', 'customer_signoff_required',
    'head_approval_required', 'daily_update_required'].map((k) => [k, on.includes(k)]));
  const standardTypes = [
    ['sales_visit', 'Sales visit', [F('customer', 'Customer', 'customer', true), F('purpose', 'Purpose', 'text'), F('outcome', 'Outcome', 'text')], rules('daily_update_required'), []],
    ['survey', 'Survey', [F('site_address', 'Site address', 'text', true), F('measurements', 'Measurements', 'text')], rules('photo_required', 'file_required'), []],
    ['design', 'Design', [F('drawing_version', 'Drawing version', 'text'), F('design_file', 'Design file', 'file')], rules('file_required'), []],
    ['budgeting', 'Budgeting', [F('budget_amount', 'Budget amount', 'money', true)], rules('head_approval_required'), []],
    ['purchase', 'Purchase', [F('vendor', 'Vendor', 'text', true), F('items', 'Items', 'text', true), F('amount', 'Amount', 'money', true)], rules('head_approval_required', 'file_required'), []],
    ['production', 'Production', [F('item', 'Item', 'text', true), F('quantity', 'Quantity', 'number'), F('drawing_ref', 'Drawing reference', 'text')], rules('daily_update_required'), []],
    ['workshop', 'Workshop', [F('job_details', 'Job details', 'text'), F('materials_used', 'Materials used', 'text')], rules('photo_required'), []],
    ['qc', 'QC', [F('checked_item', 'Checked item', 'text', true)], rules('checklist_required'),
      ['Dimensions as per drawing', 'Finish quality', 'Fixings and safety', 'Function test']],
    // Completion: every required field filled (always checked), so no extra rule.
    ['packing_transport', 'Packing and transportation', [F('items', 'Items', 'text', true), F('vehicle_number', 'Vehicle number', 'text', true), F('driver', 'Driver', 'text'),
      F('dispatch_date', 'Dispatch date', 'date', true), F('eway_bill_number', 'E-way bill number', 'text')], rules(), []],
    ['site_work', 'Site work', [F('site', 'Site', 'text', true), F('crew', 'Crew', 'text')], rules('photo_required'), []],
    ['installation', 'Installation', [F('site', 'Site', 'text', true), F('machines_installed', 'Machines installed', 'text')], rules('checklist_required', 'photo_required'),
      ['Positioned as per layout', 'Power and wiring checked', 'Safety checks done', 'Test run passed']],
    ['training_handover', 'Training and handover', [F('customer_contact', 'Customer contact', 'text', true), F('people_trained', 'People trained', 'text')], rules('customer_signoff_required'), []],
    // "service report, or a daily update": a type has one set of rules, so the report is what is required.
    ['service', 'Service', [F('customer', 'Customer', 'customer', true), F('machine', 'Machine', 'text'), F('fault', 'Fault', 'text', true),
      F('coverage', 'Coverage (warranty, amc or paid)', 'text')], rules('file_required'), []],
  ];
  const { rows: companies } = await client.query('SELECT id FROM core.legal_entities WHERE tenant_id = 1 ORDER BY id');
  for (const company of companies) {
    for (const [i, [code, name, fields, completion, checklist]] of standardTypes.entries()) {
      await client.query(
        `INSERT INTO tickets.ticket_types (tenant_id, legal_entity_id, code, name, is_standard, sort_order, fields, completion_rules, checklist_items, created_by)
         SELECT 1, $1, $2, $3, true, $4, $5::jsonb, $6::jsonb, $7::jsonb, p.id FROM core.persons p WHERE p.public_id = $8
         ON CONFLICT DO NOTHING`,
        [company.id, code, name, (i + 1) * 10, JSON.stringify(fields), JSON.stringify(completion), JSON.stringify(checklist), id(5)]);
    }
  }

  // Team: Demo Technician reports to Demo Manager, Demo Manager to Demo Head (only filled in when no manager is set yet).
  for (const p of people.filter((x) => x.manager)) {
    await client.query(
      `UPDATE hrms.employments SET manager_person_id = (SELECT id FROM core.persons WHERE public_id = $1)
        WHERE public_id = $2 AND manager_person_id IS NULL`, [id(p.manager), id(100 + p.n)]);
  }
  // Older seeds had Demo Technician report to Demo Supervisor: move them to Demo Manager (only while that is still so).
  await client.query(
    `UPDATE hrms.employments SET manager_person_id = (SELECT id FROM core.persons WHERE public_id = $1)
      WHERE public_id = $2 AND manager_person_id = (SELECT id FROM core.persons WHERE public_id = $3)`,
    [id(9), id(102), id(1)]);
  // Department and designation of a demo job, and the department a demo person heads (left alone once HR has set them).
  for (const p of people.filter((x) => x.department)) {
    await client.query(
      `UPDATE hrms.employments e SET department_id = d.id, designation = COALESCE(e.designation, $3)
         FROM hrms.departments d
        WHERE e.public_id = $1 AND e.department_id IS NULL AND d.legal_entity_id = e.legal_entity_id AND d.code_prefix = $2`,
      [id(100 + p.n), p.department, p.designation]);
  }
  for (const p of people.filter((x) => x.heads)) {
    await client.query(
      `UPDATE hrms.departments d SET head_person_id = p.id
         FROM core.persons p, core.legal_entities le
        WHERE p.public_id = $1 AND le.tenant_id = 1 AND le.code = $2 AND d.legal_entity_id = le.id AND d.code_prefix = $3
          AND d.head_person_id IS NULL`,
      [id(p.n), p.company, p.heads]);
  }

  // POLICY: until HR confirms — weekly off for both companies: every Sunday and the 2nd and 4th Saturday (set by Demo HR).
  const weeklyOff = { weekdays: [0], nthWeekdays: [{ weekday: 6, nth: [2, 4] }] };
  for (const [n, company] of [[401, 'AE'], [402, 'ATPL']]) {
    await client.query(
      `INSERT INTO hrms.weekly_off_rules (tenant_id, public_id, legal_entity_id, valid_from, rule, created_by)
       SELECT 1, $1, le.id, DATE '2025-04-01', $2::jsonb, hr.id
         FROM core.legal_entities le, core.persons hr
        WHERE le.tenant_id = 1 AND le.code = $3 AND hr.public_id = $4
       ON CONFLICT (public_id) DO NOTHING`,
      [id(n), JSON.stringify(weeklyOff), company, id(4)]);
  }

  // POLICY: until HR confirms — group defaults (version 1, all companies), set by Demo HR. HR adds new versions via the API.
  const policies = [
    ['core.auth.session_hours', 12], ['hrms.attendance.full_day_minutes', 480], ['hrms.attendance.half_day_minutes', 240],
    ['hrms.attendance.max_open_punch_hours', 16], ['hrms.leave.balance_check', false], ['hrms.overtime.payable', false],
    ['hrms.attendance.auto_punch_out_hours', 8],
  ];
  for (const [i, [key, value]] of policies.entries()) {
    await client.query(
      `INSERT INTO core.policies (tenant_id, public_id, legal_entity_id, policy_key, value, version, effective_from, approved_by)
       SELECT 1, $1, NULL, $2, $3::jsonb, 1, DATE '2025-04-01', id FROM core.persons WHERE public_id = $4
       ON CONFLICT (public_id) DO NOTHING`,
      [id(501 + i), key, JSON.stringify(value), id(4)]);
  }

  // Roles: granted by Demo Admin, whose own role is granted by Demo HR (nobody grants themselves).
  for (const p of people) {
    await client.query(
      `INSERT INTO core.role_assignments (tenant_id, public_id, person_id, role_id, scope, valid_from, granted_by)
       SELECT 1, $1, person.id, r.id, $2, DATE '2025-04-01', granter.id
         FROM core.persons person, core.roles r, core.persons granter
        WHERE person.public_id = $3 AND r.tenant_id = 1 AND r.code = $4 AND granter.public_id = $5
       ON CONFLICT (public_id) DO NOTHING`,
      [id(200 + p.n), p.scope, id(p.n), p.role, id(p.grantedBy ?? 5)]);
  }
  for (const x of extraRoles) {
    await client.query(
      `INSERT INTO core.role_assignments (tenant_id, public_id, person_id, role_id, scope, valid_from, granted_by)
       SELECT 1, $1, person.id, r.id, $5, DATE '2025-04-01', granter.id
         FROM core.persons person, core.roles r, core.persons granter
        WHERE person.public_id = $2 AND r.tenant_id = 1 AND r.code = $3 AND granter.public_id = $4
       ON CONFLICT (public_id) DO NOTHING`,
      [id(x.n), id(x.person), x.role, id(5), x.scope ?? 'all']);
  }
  // Older seeds also gave Demo Supervisor the Manager role (n 227). Supervisors are on site only, so end it (ended, never
  // deleted; left alone once ended), as ending a role in the app does.
  await client.query(
    `UPDATE core.role_assignments ra SET ended_at = now()
       FROM core.persons person, core.roles r
      WHERE ra.public_id = $1 AND ra.ended_at IS NULL AND ra.person_id = person.id AND person.public_id = $2
        AND ra.role_id = r.id AND r.tenant_id = 1 AND r.code = 'manager'`,
    [id(227), id(1)]);

  await client.query('COMMIT');
  const { rows } = await client.query(`SELECT
    (SELECT count(*) FROM core.tenants) AS tenants, (SELECT count(*) FROM core.legal_entities) AS legal_entities,
    (SELECT count(*) FROM core.persons) AS persons, (SELECT count(*) FROM hrms.employments) AS employments,
    (SELECT count(*) FROM core.users) AS logins, (SELECT count(*) FROM core.role_assignments) AS role_assignments,
    (SELECT count(*) FROM hrms.expense_categories) AS expense_categories, (SELECT count(*) FROM hrms.weekly_off_rules) AS weekly_off_rules,
    (SELECT count(*) FROM core.policies) AS policies`);
  console.log(`Seeded "${dbName}":`, rows[0]);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
