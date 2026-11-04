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
const people = [
  { n: 1, display: 'Demo Supervisor', full: 'Demo Supervisor One', company: 'AE', code: 'AE-D001', phone: '+910000000001', email: 'demo.supervisor@example.com', role: 'supervisor', scope: 'team' },
  { n: 2, display: 'Demo Technician', full: 'Demo Technician Two', company: 'AE', code: 'AE-D002', phone: '+910000000002', email: null, role: 'employee', scope: 'own', manager: 1 },
  { n: 3, display: 'Demo Engineer', full: 'Demo Engineer Three', company: 'ATPL', code: 'ATPL-D001', phone: null, email: 'demo.engineer@example.com', role: 'employee', scope: 'own' },
  { n: 4, display: 'Demo HR', full: 'Demo HR Four', company: 'AE', code: 'AE-D003', phone: null, email: 'demo.hr@example.com', role: 'hr', scope: 'all' },
  { n: 5, display: 'Demo Admin', full: 'Demo Admin Five', company: 'ATPL', code: 'ATPL-D002', phone: null, email: 'demo.admin@example.com', role: 'system_admin', scope: 'all', grantedBy: 4 },
  { n: 6, display: 'Demo CEO', full: 'Demo CEO Six', company: 'AE', code: 'AE-D004', phone: null, email: 'demo.ceo@example.com', role: 'ceo', scope: 'team' },
];

// Roles for tenant 1 and their permissions (the permission list itself comes from migration 0005).
const HR = ['hrms.people.view', 'hrms.people.create', 'hrms.people.update', 'hrms.contacts.manage', 'hrms.contacts.review', 'hrms.employments.manage', 'hrms.employments.update',
  'hrms.expenses.submit', 'hrms.expenses.approve', 'hrms.expenses.pay', 'hrms.expenses.report',
  'hrms.attendance.punch', 'hrms.attendance.view', 'hrms.attendance.rebuild', 'hrms.attendance.approve', 'hrms.calendar.manage',
  'hrms.leave.apply', 'hrms.leave.approve', 'hrms.leave.manage', 'hrms.leave.report', 'core.policies.manage', 'hrms.positions.manage',
  'hrms.skills.manage', 'hrms.skills.add', 'hrms.skills.verify', 'hrms.skills.view', 'hrms.month.lock'];
const roles = [
  { code: 'employee', name: 'Employee', permissions: ['hrms.people.view', 'hrms.expenses.submit', 'hrms.attendance.punch', 'hrms.leave.apply',
    'hrms.skills.add', 'hrms.skills.view'] },
  { code: 'supervisor', name: 'Supervisor', permissions: ['hrms.people.view', 'hrms.employments.update', 'hrms.expenses.submit', 'hrms.expenses.approve',
    'hrms.attendance.punch', 'hrms.attendance.view', 'hrms.attendance.approve', 'hrms.leave.apply', 'hrms.leave.approve', 'hrms.leave.report',
    'hrms.skills.add', 'hrms.skills.verify', 'hrms.skills.view'] },
  { code: 'hr', name: 'HR', permissions: HR },
  { code: 'admin_user', name: 'Admin user', permissions: [] },
  { code: 'system_admin', name: 'System admin', permissions: ['core.users.manage', 'core.policies.manage', 'hrms.people.view', 'hrms.attendance.rebuild', 'hrms.month.unlock'] },
  // Last approver for leave (after the manager and HR); scope team: decides requests that name them.
  { code: 'ceo', name: 'CEO', permissions: ['hrms.people.view', 'hrms.attendance.punch', 'hrms.attendance.approve', 'hrms.leave.apply', 'hrms.leave.approve', 'hrms.leave.report'] },
];

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

  // POLICY: until HR confirms the leave types — one paid type for now.
  await client.query(`INSERT INTO hrms.leave_types (tenant_id, code, name, policy_key, is_paid)
    VALUES (1, 'GL', 'General leave', 'hrms.leave.gl', true) ON CONFLICT (tenant_id, code) DO NOTHING`);

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
  }

  // Team: Demo Technician reports to Demo Supervisor (only filled in when no manager is set yet).
  for (const p of people.filter((x) => x.manager)) {
    await client.query(
      `UPDATE hrms.employments SET manager_person_id = (SELECT id FROM core.persons WHERE public_id = $1)
        WHERE public_id = $2 AND manager_person_id IS NULL`, [id(p.manager), id(100 + p.n)]);
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
