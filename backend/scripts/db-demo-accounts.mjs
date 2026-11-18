// Adds (or removes) FICTIONAL Accounts data in YOUR development database, for testing the Accounts screens.
//   node scripts/db-demo-accounts.mjs          add the demo data (safe to run again)
//   node scripts/db-demo-accounts.mjs remove   delete exactly the rows this script added, nothing else
// Every row it adds has a public_id starting 00000000-0000-4000-9000- , so removal never touches real work.
// Needs `pnpm db:seed` first (it uses the demo people and the AE / ATPL companies).
// The journal and the Tally tables refuse deletes on purpose; `remove` switches those guards off inside one
// transaction, only for the demo rows, and switches them on again before it commits.
import 'dotenv/config';
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL ?? '');
const dbName = url.pathname.slice(1);
if (!dbName || /prod|staging/i.test(dbName) || !/^(dev_|ageless_dev|ageless_test|platform_test)/.test(dbName)) {
  console.error(`Refusing to touch "${dbName}". Only development databases (dev_*, ageless_dev, ageless_test) are allowed.`);
  process.exit(1);
}

const mode = process.argv[2] ?? 'add';
if (!['add', 'remove'].includes(mode)) { console.error('Use: add (default) or remove'); process.exit(1); }

const DEMO = '00000000-0000-4000-9000-%';
const demoId = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const person = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;   // from db-seed.mjs
const ACCOUNTANT = person(7), CEO = person(6), HR = person(4);

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();

async function add() {
  const pid = async (publicId) => (await client.query('SELECT id FROM core.persons WHERE public_id = $1', [publicId])).rows[0]?.id;
  const accountant = await pid(ACCOUNTANT), ceo = await pid(CEO), hr = await pid(HR);
  if (!accountant || !ceo || !hr) throw new Error('Demo people not found. Run `pnpm db:seed` first.');
  const entities = Object.fromEntries((await client.query(`SELECT code, id FROM core.legal_entities WHERE tenant_id = 1`)).rows.map((r) => [r.code, r.id]));
  if (!entities.AE || !entities.ATPL) throw new Error('Companies AE and ATPL not found. Run `pnpm db:seed` first.');

  // Tally company per entity (approved by a different person) and a few approved ledger names.
  const tally = { AE: 'Demo Ageless Entertainments (test)', ATPL: 'Demo Ageless Technologies (test)' };
  let n = 1;
  for (const code of ['AE', 'ATPL']) {
    await client.query(
      `INSERT INTO accounts.tally_companies (tenant_id, public_id, legal_entity_id, tally_company_name, books_from, state, drafted_by, approved_by, approved_at)
       VALUES (1, $1, $2, $3, DATE '2026-04-01', 'approved', $4, $5, now()) ON CONFLICT DO NOTHING`,
      [demoId(n++), entities[code], tally[code], accountant, ceo]);
  }
  const ledgerNames = {
    'salary.expense': 'Salary Expense', 'payable.salary': 'Salary Payable', 'payable.reimbursements': 'Reimbursements Payable',
    'stat.pf': 'PF Payable', 'expense.fuel': 'Fuel Expense', 'expense.travel': 'Travel Expense', 'bank.operating': 'Operating Bank A/c',
  };
  for (const code of ['AE', 'ATPL']) {
    for (const [key, name] of Object.entries(ledgerNames)) {
      await client.query(
        `INSERT INTO accounts.tally_ledger_map (tenant_id, public_id, legal_entity_id, ledger_key, tally_ledger_name, state, drafted_by, approved_by, approved_at)
         VALUES (1, $1, $2, $3, $4, 'approved', $5, $6, now()) ON CONFLICT DO NOTHING`,
        [demoId(10 + n++), entities[code], key, name, accountant, ceo]);
    }
  }
  // One ledger left as a draft, so the "waiting for approval" state can be tried.
  await client.query(
    `INSERT INTO accounts.tally_ledger_map (tenant_id, public_id, legal_entity_id, ledger_key, tally_ledger_name, state, drafted_by)
     VALUES (1, $1, $2, 'tax.input_cgst', 'Input CGST', 'draft', $3) ON CONFLICT DO NOTHING`, [demoId(60), entities.ATPL, accountant]);

  // A soft-closed period (no entries in it) and a posting rule version.
  await client.query(
    `INSERT INTO accounts.periods (tenant_id, public_id, legal_entity_id, year, month, state, closed_by, closed_at)
     VALUES (1, $1, $2, 2026, 8, 'soft_closed', $3, now()) ON CONFLICT DO NOTHING`, [demoId(61), entities.ATPL, ceo]);
  await client.query(
    `INSERT INTO accounts.posting_rules (tenant_id, public_id, legal_entity_id, event_type, debit_ledger_key, credit_ledger_key, version, effective_from, created_by)
     SELECT 1, $1, $2, 'expense_paid', 'payable.reimbursements', 'bank.operating', COALESCE(max(version), 0) + 1, DATE '2026-04-01', $3
       FROM accounts.posting_rules WHERE tenant_id = 1 AND legal_entity_id = $2 AND event_type = 'expense_paid'
     ON CONFLICT DO NOTHING`, [demoId(62), entities.ATPL, hr]);

  // Journal entries: [n, company, sourceType, date, description, lines [key, debitPaise, creditPaise]]
  const entries = [
    [101, 'AE', 'expense_approved', '2026-10-05', 'Demo: fuel claim approved', [['expense.fuel', 250000, 0], ['payable.reimbursements', 0, 250000]]],
    [102, 'AE', 'expense_approved', '2026-10-09', 'Demo: travel claim approved', [['expense.travel', 480050, 0], ['payable.reimbursements', 0, 480050]]],
    [103, 'AE', 'expense_paid', '2026-10-15', 'Demo: fuel claim paid', [['payable.reimbursements', 250000, 0], ['bank.operating', 0, 250000]]],
    [104, 'ATPL', 'expense_approved', '2026-10-12', 'Demo: travel claim approved', [['expense.travel', 125075, 0], ['payable.reimbursements', 0, 125075]]],
    [105, 'ATPL', 'payroll_approved', '2026-10-31', 'Demo: October payroll approved', [['salary.expense', 45000000, 0], ['payable.salary', 0, 41400000], ['stat.pf', 0, 3600000]]],
    [106, 'ATPL', 'salary_paid', '2026-11-03', 'Demo: October salary paid', [['payable.salary', 41400000, 0], ['bank.operating', 0, 41400000]]],
    [107, 'ATPL', 'expense_approved', '2026-11-10', 'Demo: fuel claim approved', [['expense.fuel', 99900, 0], ['payable.reimbursements', 0, 99900]]],
    [108, 'AE', 'payroll_approved', '2026-11-14', 'Demo: payroll approved (to be reversed)', [['salary.expense', 1000000, 0], ['payable.salary', 0, 1000000]]],
  ];
  for (const [num, company, source, date, description, lines] of entries) {
    const r = await client.query(
      `INSERT INTO accounts.journal_entries (tenant_id, public_id, legal_entity_id, source_type, source_public_id, entry_date, description, created_by)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`,
      [demoId(num), entities[company], source, demoId(num + 1000), date, description, accountant]);
    if (!r.rows[0]) continue;   // already there
    for (const [i, [key, debit, credit]] of lines.entries()) {
      await client.query(
        `INSERT INTO accounts.journal_lines (tenant_id, entry_id, legal_entity_id, line_no, ledger_key, debit_minor, credit_minor) VALUES (1, $1, $2, $3, $4, $5, $6)`,
        [r.rows[0].id, entities[company], i + 1, key, debit, credit]);
    }
  }
  // A reversal of entry 108.
  const orig = await client.query(`SELECT id FROM accounts.journal_entries WHERE public_id = $1`, [demoId(108)]);
  const rev = await client.query(
    `INSERT INTO accounts.journal_entries (tenant_id, public_id, legal_entity_id, source_type, source_public_id, entry_date, description, reverses_entry_id, created_by)
     VALUES (1, $1, $2, 'reversal', $3, DATE '2026-11-15', 'Demo: reversal of the payroll entry', $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
    [demoId(109), entities.AE, demoId(1109), orig.rows[0].id, ceo]);
  if (rev.rows[0]) {
    await client.query(`INSERT INTO accounts.journal_lines (tenant_id, entry_id, legal_entity_id, line_no, ledger_key, debit_minor, credit_minor) VALUES
      (1, $1, $2, 1, 'payable.salary', 1000000, 0), (1, $1, $2, 2, 'salary.expense', 0, 1000000)`, [rev.rows[0].id, entities.AE]);
  }

  // Two Tally batches for AE: one built (waiting for a checker), one imported.
  const batches = [
    [201, 'built', [101, 102], 730050],
    [202, 'imported', [103], 250000],
  ];
  for (const [num, state, entryNums, total] of batches) {
    const finished = state === 'imported';
    const now = new Date();
    const b = await client.query(
      `INSERT INTO accounts.tally_batches (tenant_id, public_id, legal_entity_id, tally_company_name, state, entry_count, total_minor, request_xml, import_result,
         created_by, approved_by, approved_at, downloaded_at, finished_by, finished_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, '<ENVELOPE><!-- demo data, not a real Tally request --></ENVELOPE>', $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT DO NOTHING RETURNING id`,
      [demoId(num), entities.AE, tally.AE, state, entryNums.length, total, finished ? 'Demo: Tally answered, 1 created, 0 failed' : null, accountant,
        finished ? ceo : null, finished ? now : null, finished ? now : null, finished ? ceo : null, finished ? now : null]);
    if (!b.rows[0]) continue;
    for (const [i, e] of entryNums.entries()) {
      const eid = (await client.query(`SELECT id FROM accounts.journal_entries WHERE public_id = $1`, [demoId(e)])).rows[0].id;
      await client.query(
        `INSERT INTO accounts.tally_exports (tenant_id, public_id, batch_id, entry_id, legal_entity_id, remote_id, voucher_type, state, finished_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)`,
        [demoId(num * 10 + i), b.rows[0].id, eid, entities.AE, demoId(e), e === 103 ? 'Platform Payment' : 'Platform Journal',
          finished ? 'created' : 'pending', finished ? now : null]);
    }
  }
  // Payment requests, batches and bank lines (ATPL), one of everything so each screen and action can be tried.
  const now = new Date();
  const req = [   // [n, payee, kind, purpose, paise, state, batch n]
    [401, 'Demo Stationery Mart', 'vendor', 'Office stationery, November', 12500000, 'pending'],
    [402, 'Demo Technician', 'employee', 'Travel advance for site visit', 850000, 'pending'],
    [403, 'Demo Cloud Hosting', 'vendor', 'Server hosting, November', 4500000, 'approved'],
    [404, 'Demo Caterer', 'vendor', 'Team lunch (not budgeted)', 600000, 'rejected'],
    [405, 'Demo Courier', 'vendor', 'Courier charges (raised twice)', 120000, 'cancelled'],
    [411, 'Demo Electricals', 'vendor', 'Cables and connectors', 3000000, 'batched', 301],
    [412, 'Demo Printers', 'vendor', 'Brochure printing', 6000000, 'paid', 302],
    [413, 'Demo Packaging', 'vendor', 'Packing material', 4000000, 'paid', 302],
    [414, 'Demo Lab Supplies', 'vendor', 'Test equipment', 7500000, 'paid', 303],
    [415, 'Demo Travel Desk', 'vendor', 'Flight tickets', 2000000, 'batched', 304],
  ];
  // [n, state, bank, paidOn, reference]; totals are the sum of their requests
  const pbatches = [[301, 'draft', 'bank.operating'], [302, 'paid', 'bank.operating', '2026-11-05', 'DEMO-UTR-0001'],
    [303, 'paid', 'bank.operating', '2026-11-09', 'DEMO-UTR-0002'], [304, 'approved', 'bank.operating']];
  const batchDbId = {};
  for (const [bn, state, bank, paidOn, ref] of pbatches) {
    const mine = req.filter((r) => r[6] === bn);
    const approvedBy = state === 'draft' ? null : ceo;
    const r = await client.query(
      `INSERT INTO accounts.payment_batches (tenant_id, public_id, legal_entity_id, bank_ledger_key, state, request_count, total_minor, created_by,
         approved_by, approved_at, paid_by, paid_at, paid_on, bank_reference)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT DO NOTHING RETURNING id`,
      [demoId(bn), entities.ATPL, bank, state, mine.length, mine.reduce((t, x) => t + x[4], 0), accountant, approvedBy, approvedBy ? now : null,
        state === 'paid' ? accountant : null, state === 'paid' ? now : null, paidOn ?? null, ref ?? null]);
    batchDbId[bn] = r.rows[0]?.id ?? (await client.query(`SELECT id FROM accounts.payment_batches WHERE public_id = $1`, [demoId(bn)])).rows[0].id;
  }
  for (const [rn, payee, kind, purpose, paise, state, bn] of req) {
    const decided = ['pending', 'cancelled'].includes(state) ? null : ceo;
    await client.query(
      `INSERT INTO accounts.payment_requests (tenant_id, public_id, legal_entity_id, payee_name, payee_kind, purpose, amount_minor, due_date, state,
         requested_by, decided_by, decided_at, decision_note, batch_id)
       VALUES (1, $1, $2, $3, $4, $5, $6, DATE '2026-11-30', $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
      [demoId(rn), entities.ATPL, payee, kind, purpose, paise, state, accountant, decided, decided ? now : null,
        state === 'rejected' ? 'Not in the budget' : state === 'cancelled' ? 'Raised twice' : null, bn ? batchDbId[bn] : null]);
  }
  const bank = [   // [n, date, description, reference, debit, credit, matched batch n]
    [501, '2026-11-05', 'NEFT out: printers and packaging', 'DEMO-UTR-0001', 10000000, 0, 302],
    [502, '2026-11-09', 'NEFT out: lab supplies', 'DEMO-UTR-0002', 7500000, 0, null],
    [503, '2026-11-12', 'Customer receipt', 'DEMO-RCPT-0100', 0, 25000000, null],
    [504, '2026-11-13', 'Bank charges', 'DEMO-CHG-01', 11800, 0, null],
  ];
  for (const [bn, date, description, reference, debit, credit, matched] of bank) {
    await client.query(
      `INSERT INTO accounts.bank_lines (tenant_id, public_id, legal_entity_id, bank_ledger_key, txn_date, description, reference, debit_minor, credit_minor,
         state, matched_batch_id, matched_by, matched_at, imported_by)
       VALUES (1, $1, $2, 'bank.operating', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
      [demoId(bn), entities.ATPL, date, description, reference, debit, credit, matched ? 'matched' : 'unmatched', matched ? batchDbId[matched] : null,
        matched ? accountant : null, matched ? now : null, accountant]);
  }
}

async function remove() {
  const guarded = ['bank_lines', 'payment_requests', 'payment_batches', 'journal_entries', 'journal_lines', 'posting_rules', 'periods', 'tally_ledger_map', 'tally_companies', 'tally_batches', 'tally_exports'];
  for (const t of guarded) await client.query(`ALTER TABLE accounts.${t} DISABLE TRIGGER USER`);
  const gone = {};
  const del = async (label, sql) => { gone[label] = (await client.query(sql, [DEMO])).rowCount; };
  await del('bank_lines', `DELETE FROM accounts.bank_lines WHERE public_id::text LIKE $1`);
  await del('payment_requests', `DELETE FROM accounts.payment_requests WHERE public_id::text LIKE $1`);
  await del('payment_batches', `DELETE FROM accounts.payment_batches WHERE public_id::text LIKE $1`);
  await del('tally_exports', `DELETE FROM accounts.tally_exports WHERE public_id::text LIKE $1`);
  await del('tally_batches', `DELETE FROM accounts.tally_batches WHERE public_id::text LIKE $1`);
  const ids = `(SELECT id FROM accounts.journal_entries WHERE public_id::text LIKE $1)`;
  await del('journal_lines', `DELETE FROM accounts.journal_lines WHERE entry_id IN ${ids}`);
  await del('reversals', `DELETE FROM accounts.journal_entries WHERE public_id::text LIKE $1 AND reverses_entry_id IS NOT NULL`);
  await del('journal_entries', `DELETE FROM accounts.journal_entries WHERE public_id::text LIKE $1`);
  await del('posting_rules', `DELETE FROM accounts.posting_rules WHERE public_id::text LIKE $1`);
  await del('periods', `DELETE FROM accounts.periods WHERE public_id::text LIKE $1`);
  await del('tally_ledger_map', `DELETE FROM accounts.tally_ledger_map WHERE public_id::text LIKE $1`);
  await del('tally_companies', `DELETE FROM accounts.tally_companies WHERE public_id::text LIKE $1`);
  for (const t of guarded) await client.query(`ALTER TABLE accounts.${t} ENABLE TRIGGER USER`);
  return gone;
}

try {
  await client.query('BEGIN');
  const result = mode === 'add' ? await add() : await remove();
  await client.query('COMMIT');
  const { rows } = await client.query(`SELECT
    (SELECT count(*) FROM accounts.journal_entries WHERE public_id::text LIKE $1) AS demo_entries,
    (SELECT count(*) FROM accounts.tally_batches WHERE public_id::text LIKE $1) AS demo_batches,
    (SELECT count(*) FROM accounts.payment_requests WHERE public_id::text LIKE $1) AS demo_payment_requests,
    (SELECT count(*) FROM accounts.payment_batches WHERE public_id::text LIKE $1) AS demo_payment_batches,
    (SELECT count(*) FROM accounts.bank_lines WHERE public_id::text LIKE $1) AS demo_bank_lines,
    (SELECT count(*) FROM accounts.tally_ledger_map WHERE public_id::text LIKE $1) AS demo_ledger_rows`, [DEMO]);
  console.log(mode === 'add' ? `Demo Accounts data added to "${dbName}":` : `Demo Accounts data removed from "${dbName}":`, mode === 'add' ? rows[0] : { deleted: result, remaining: rows[0] });
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
