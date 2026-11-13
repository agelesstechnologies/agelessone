import { sql } from 'drizzle-orm';
import { bigint, boolean, char, check, date, foreignKey, index, integer, numeric, PgTableExtraConfigValue, pgSchema, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { legalEntities, persons } from '../core/schema';
import { employments } from '../hrms/people/schema';
import { tickets } from '../tickets/schema';

/** The PostgreSQL schema that only the Intercompany module writes to. */
export const intercompany = pgSchema('intercompany');

/**
 * Services one company of the group provides to another (ATPL → AE). legal_entity_id is the PROVIDER (the company that
 * bills); receiver_legal_entity_id the company billed. Each side names its head (who sees the agreement, with the CEO)
 * and its approver: jobs in that side's company (company-safe keys). draft → active → ended; at most one active
 * agreement per provider and receiver. Never deleted (trigger, migration 0040); an ended agreement no longer changes.
 */
export const icAgreements = intercompany.table('ic_agreements', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  receiverLegalEntityId: bigint('receiver_legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  services: text('services').array().notNull(),
  pricingMethod: text('pricing_method').notNull(),
  costPlusPercent: numeric('cost_plus_percent', { precision: 5, scale: 2 }),
  passedCostHandling: text('passed_cost_handling').notNull().default('at_cost'),
  passedCostPercent: numeric('passed_cost_percent', { precision: 5, scale: 2 }),
  /** days the receiver has to review a monthly bill; default from policy intercompany.review_days */
  reviewDays: integer('review_days').notNull(),
  /** days to pay a bill; default from policy intercompany.payment_terms_days */
  paymentTermsDays: integer('payment_terms_days').notNull(),
  providerHeadEmploymentId: bigint('provider_head_employment_id', { mode: 'number' }).notNull(),
  providerApproverEmploymentId: bigint('provider_approver_employment_id', { mode: 'number' }).notNull(),
  receiverHeadEmploymentId: bigint('receiver_head_employment_id', { mode: 'number' }).notNull(),
  receiverApproverEmploymentId: bigint('receiver_approver_employment_id', { mode: 'number' }).notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  status: text('status').notNull().default('draft'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: bigint('updated_by', { mode: 'number' }).references(() => persons.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'ic_agreements_provider_head_company_fk', columns: [t.providerHeadEmploymentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  foreignKey({ name: 'ic_agreements_provider_approver_company_fk', columns: [t.providerApproverEmploymentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  foreignKey({ name: 'ic_agreements_receiver_head_company_fk', columns: [t.receiverHeadEmploymentId, t.receiverLegalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  foreignKey({ name: 'ic_agreements_receiver_approver_company_fk', columns: [t.receiverApproverEmploymentId, t.receiverLegalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  unique('ic_agreements_id_company_unique').on(t.id, t.legalEntityId),   // target of the rate cards', costs' and billed months' keys
  uniqueIndex('ic_agreements_one_active').on(t.legalEntityId, t.receiverLegalEntityId).where(sql`status = 'active'`),
  index('idx_ic_agreements_receiver').on(t.receiverLegalEntityId),
  check('ic_agreements_two_companies', sql`legal_entity_id <> receiver_legal_entity_id`),
  check('ic_agreements_services_check', sql`cardinality(services) BETWEEN 1 AND 4 AND services <@ ARRAY['design','software','iot_hardware','cgi']::text[]`),
  check('ic_agreements_pricing_check', sql`pricing_method IN ('rate_card','cost_plus')`),
  check('ic_agreements_cost_plus_fields', sql`(pricing_method = 'cost_plus') = (cost_plus_percent IS NOT NULL) AND (cost_plus_percent IS NULL OR cost_plus_percent BETWEEN 0 AND 100)`),
  check('ic_agreements_passed_cost_check', sql`passed_cost_handling IN ('at_cost','percent')`),
  check('ic_agreements_passed_cost_fields', sql`(passed_cost_handling = 'percent') = (passed_cost_percent IS NOT NULL) AND (passed_cost_percent IS NULL OR passed_cost_percent BETWEEN 0 AND 100)`),
  check('ic_agreements_days_check', sql`review_days BETWEEN 1 AND 60 AND payment_terms_days BETWEEN 0 AND 365`),
  check('ic_agreements_status_check', sql`status IN ('draft','active','ended')`),
  check('ic_agreements_end_fields', sql`(status = 'ended') = (end_date IS NOT NULL) AND (end_date IS NULL OR end_date >= start_date)`),
  check('ic_agreements_updated_fields', sql`(updated_by IS NULL) = (updated_at IS NULL)`),
]);

/**
 * An hourly rate of an agreement for a service type OR a grade, from a date. A new rate is a new row; rows are never
 * changed or deleted (trigger), so past months keep the rate in force then. CA TO CONFIRM.
 */
export const icRateCards = intercompany.table('ic_rate_cards', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  agreementId: bigint('agreement_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  serviceType: text('service_type'),
  grade: text('grade'),
  rateMinor: bigint('rate_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  effectiveFrom: date('effective_from').notNull(),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ic_rate_cards_agreement_company_fk', columns: [t.agreementId, t.legalEntityId], foreignColumns: [icAgreements.id, icAgreements.legalEntityId] }),
  unique('ic_rate_cards_item_from_unique').on(t.agreementId, t.serviceType, t.grade, t.effectiveFrom).nullsNotDistinct(),
  check('ic_rate_cards_item_check', sql`(service_type IS NULL) <> (grade IS NULL)`),
  check('ic_rate_cards_service_check', sql`service_type IS NULL OR service_type IN ('design','software','iot_hardware','cgi')`),
  check('ic_rate_cards_grade_check', sql`grade IS NULL OR char_length(grade) BETWEEN 1 AND 40`),
  check('ic_rate_cards_rate_positive', sql`rate_minor > 0`),
  check('ic_rate_cards_currency_check', sql`currency = 'INR'`),
]);

/** A month of an agreement that has been billed. Never changed or deleted (trigger): nothing in that month changes again. */
export const icBilledMonths = intercompany.table('ic_billed_months', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  agreementId: bigint('agreement_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  billedBy: bigint('billed_by', { mode: 'number' }).notNull().references(() => persons.id),
  billedAt: timestamp('billed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ic_billed_months_agreement_company_fk', columns: [t.agreementId, t.legalEntityId], foreignColumns: [icAgreements.id, icAgreements.legalEntityId] }),
  unique('ic_billed_months_agreement_month_unique').on(t.agreementId, t.year, t.month),
  check('ic_billed_months_month_check', sql`month BETWEEN 1 AND 12 AND year BETWEEN 2000 AND 2100`),
]);

/**
 * A cost the provider paid for the receiver (material, travel …), billed on at cost or with a percentage. Counted only
 * once its bill is attached (bill_path). Never deleted; nothing changes in a billed month (trigger).
 */
export const icPassedCosts = intercompany.table('ic_passed_costs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  agreementId: bigint('agreement_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  /** the receiver's project; its foreign key comes with the project register (Operations) */
  projectPublicId: uuid('project_public_id'),
  description: text('description').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  incurredOn: date('incurred_on').notNull(),
  billPath: text('bill_path'),
  billType: text('bill_type'),
  billUploadedBy: bigint('bill_uploaded_by', { mode: 'number' }).references(() => persons.id),
  billUploadedAt: timestamp('bill_uploaded_at', { withTimezone: true }),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ic_passed_costs_agreement_company_fk', columns: [t.agreementId, t.legalEntityId], foreignColumns: [icAgreements.id, icAgreements.legalEntityId] }),
  unique('ic_passed_costs_id_company_unique').on(t.id, t.legalEntityId),   // target of the statement lines' key
  index('idx_ic_passed_costs_agreement_date').on(t.agreementId, t.incurredOn),
  check('ic_passed_costs_amount_positive', sql`amount_minor > 0`),
  check('ic_passed_costs_currency_check', sql`currency = 'INR'`),
  check('ic_passed_costs_description_length', sql`char_length(description) BETWEEN 3 AND 300`),
  check('ic_passed_costs_bill_fields', sql`(bill_path IS NULL) = (bill_type IS NULL) AND (bill_path IS NULL) = (bill_uploaded_by IS NULL) AND (bill_path IS NULL) = (bill_uploaded_at IS NULL)`),
  check('ic_passed_costs_bill_type_check', sql`bill_type IS NULL OR bill_type IN ('jpg','png','pdf')`),
]);

/**
 * A ticket done for another company's project or design request: billable to that company (billable_to_legal_entity_id)
 * by default; the provider's department head may set it not billable with a reason (audited). legal_entity_id is the
 * ticket's company (the provider), kept with a company-safe key to the ticket. One row per ticket; never deleted.
 */
export const icTicketBilling = intercompany.table('ic_ticket_billing', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  billableToLegalEntityId: bigint('billable_to_legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  linkKind: text('link_kind').notNull(),
  /** the other company's project or design request; its foreign key comes with those registers */
  linkPublicId: uuid('link_public_id').notNull(),
  /** what the ticket's time is billed as (its rate card line); null only on links made before migration 0041 */
  serviceType: text('service_type'),
  billable: boolean('billable').notNull().default(true),
  notBillableReason: text('not_billable_reason'),
  changedBy: bigint('changed_by', { mode: 'number' }).notNull().references(() => persons.id),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ic_ticket_billing_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  index('idx_ic_ticket_billing_receiver').on(t.legalEntityId, t.billableToLegalEntityId),
  check('ic_ticket_billing_other_company', sql`billable_to_legal_entity_id <> legal_entity_id`),
  check('ic_ticket_billing_link_kind_check', sql`link_kind IN ('project','design_request')`),
  check('ic_ticket_billing_service_check', sql`service_type IS NULL OR service_type IN ('design','software','iot_hardware','cgi')`),
  check('ic_ticket_billing_reason_check', sql`billable = (not_billable_reason IS NULL) AND (not_billable_reason IS NULL OR char_length(trim(not_billable_reason)) >= 3)`),
]);

/**
 * One agreement's bill for one month. Built (draft) only once the provider's attendance month is locked; rebuilt freely
 * while a draft. draft → approved_by_provider (a department head with ticket time on it, or the CEO; never whoever
 * prepared it last; the month becomes billed) → sent → accepted | partly_disputed → (corrected / explained, sent again)
 * → accepted → invoiced → closed. No answer by review_due_on: accepted automatically (accepted_as automatic). Never deleted.
 */
export const icStatements = intercompany.table('ic_statements', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  agreementId: bigint('agreement_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  status: text('status').notNull().default('draft'),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  /** times sent to the receiver */
  round: integer('round').notNull().default(0),
  preparedBy: bigint('prepared_by', { mode: 'number' }).notNull().references(() => persons.id),
  preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull().defaultNow(),
  approvedBy: bigint('approved_by', { mode: 'number' }).references(() => persons.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedAs: text('approved_as'),
  firstSentAt: timestamp('first_sent_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  sentBy: bigint('sent_by', { mode: 'number' }).references(() => persons.id),
  reviewDueOn: date('review_due_on'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedAs: text('accepted_as'),
  acceptedBy: bigint('accepted_by', { mode: 'number' }).references(() => persons.id),
  invoiceNumber: text('invoice_number'),
  invoicedOn: date('invoiced_on'),
  invoicedBy: bigint('invoiced_by', { mode: 'number' }).references(() => persons.id),
  paidOn: date('paid_on'),
  paymentRef: text('payment_ref'),
  closedBy: bigint('closed_by', { mode: 'number' }).references(() => persons.id),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ic_statements_agreement_company_fk', columns: [t.agreementId, t.legalEntityId], foreignColumns: [icAgreements.id, icAgreements.legalEntityId] }),
  unique('ic_statements_agreement_month_unique').on(t.agreementId, t.year, t.month),
  unique('ic_statements_id_company_unique').on(t.id, t.legalEntityId),
  uniqueIndex('ic_statements_invoice_number_unique').on(t.legalEntityId, t.invoiceNumber).where(sql`invoice_number IS NOT NULL`),
  index('idx_ic_statements_review').on(t.status, t.reviewDueOn),
  check('ic_statements_month_check', sql`month BETWEEN 1 AND 12 AND year BETWEEN 2000 AND 2100`),
  check('ic_statements_status_check', sql`status IN ('draft','approved_by_provider','sent','partly_disputed','accepted','invoiced','closed')`),
  check('ic_statements_currency_check', sql`currency = 'INR'`),
  check('ic_statements_approved_fields', sql`(status = 'draft') = (approved_by IS NULL) AND (approved_by IS NULL) = (approved_at IS NULL)
    AND (approved_by IS NULL) = (approved_as IS NULL) AND (approved_as IS NULL OR approved_as IN ('head','ceo'))`),
  check('ic_statements_not_own_approval', sql`approved_by IS NULL OR approved_by <> prepared_by`),
  check('ic_statements_sent_fields', sql`(status IN ('draft','approved_by_provider')) = (first_sent_at IS NULL) AND (first_sent_at IS NULL) = (sent_at IS NULL)
    AND (sent_at IS NULL) = (sent_by IS NULL) AND (sent_at IS NULL) = (review_due_on IS NULL) AND (first_sent_at IS NULL) = (round = 0) AND round >= 0`),
  check('ic_statements_accepted_fields', sql`(status IN ('accepted','invoiced','closed')) = (accepted_at IS NOT NULL) AND (accepted_at IS NULL) = (accepted_as IS NULL)
    AND (accepted_as IS NULL OR (accepted_as IN ('receiver','automatic') AND (accepted_as = 'automatic') = (accepted_by IS NULL)))`),
  check('ic_statements_invoice_fields', sql`(status IN ('invoiced','closed')) = (invoice_number IS NOT NULL) AND (invoice_number IS NULL) = (invoiced_on IS NULL)
    AND (invoice_number IS NULL) = (invoiced_by IS NULL)`),
  check('ic_statements_closed_fields', sql`(status = 'closed') = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (paid_on IS NULL)
    AND (closed_at IS NULL) = (payment_ref IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL)`),
]);

/**
 * A line of a statement: labour (a person's hours on billable tickets of one project and service type at one rate),
 * a passed-on cost, or a credit (a correction made after invoicing; negative). cost_* is for the CEO only. Written while
 * the statement is a draft; afterwards only the receiver's answer and the provider's correction or explanation change it,
 * and the amount only goes down (trigger, migration 0041).
 */
export const icStatementLines = intercompany.table('ic_statement_lines', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  statementId: bigint('statement_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  kind: text('kind').notNull(),
  description: text('description').notNull(),
  projectKind: text('project_kind'),
  projectPublicId: uuid('project_public_id'),
  serviceType: text('service_type'),
  employmentId: bigint('employment_id', { mode: 'number' }),
  grade: text('grade'),
  minutes: integer('minutes'),
  rateMinor: bigint('rate_minor', { mode: 'number' }),
  costPerHourMinor: bigint('cost_per_hour_minor', { mode: 'number' }),
  costMinor: bigint('cost_minor', { mode: 'number' }),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  originalAmountMinor: bigint('original_amount_minor', { mode: 'number' }),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  passedCostId: bigint('passed_cost_id', { mode: 'number' }),
  creditId: bigint('credit_id', { mode: 'number' }),
  status: text('status').notNull().default('pending'),
  disputeReason: text('dispute_reason'),
  disputedBy: bigint('disputed_by', { mode: 'number' }).references(() => persons.id),
  disputedAt: timestamp('disputed_at', { withTimezone: true }),
  resolution: text('resolution'),
  resolutionReason: text('resolution_reason'),
  resolvedBy: bigint('resolved_by', { mode: 'number' }).references(() => persons.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t): PgTableExtraConfigValue[] => [
  foreignKey({ name: 'ic_statement_lines_statement_company_fk', columns: [t.statementId, t.legalEntityId], foreignColumns: [icStatements.id, icStatements.legalEntityId] }),
  foreignKey({ name: 'ic_statement_lines_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  foreignKey({ name: 'ic_statement_lines_cost_company_fk', columns: [t.passedCostId, t.legalEntityId], foreignColumns: [icPassedCosts.id, icPassedCosts.legalEntityId] }),
  foreignKey({ name: 'ic_statement_lines_credit_company_fk', columns: [t.creditId, t.legalEntityId], foreignColumns: [icCredits.id, icCredits.legalEntityId] }),
  unique('ic_statement_lines_id_company_unique').on(t.id, t.legalEntityId),
  unique('ic_statement_lines_cost_once').on(t.passedCostId),
  unique('ic_statement_lines_credit_once').on(t.creditId),
  index('idx_ic_statement_lines_statement').on(t.statementId),
  check('ic_statement_lines_kind_check', sql`kind IN ('labour','passed_cost','credit')`),
  check('ic_statement_lines_status_check', sql`status IN ('pending','accepted','disputed','removed')`),
  check('ic_statement_lines_currency_check', sql`currency = 'INR'`),
  check('ic_statement_lines_labour_fields', sql`(kind = 'labour') = (employment_id IS NOT NULL AND minutes IS NOT NULL AND rate_minor IS NOT NULL AND service_type IS NOT NULL)
    AND (minutes IS NULL OR minutes > 0) AND (rate_minor IS NULL OR rate_minor >= 0) AND (cost_per_hour_minor IS NULL OR cost_per_hour_minor >= 0)`),
  check('ic_statement_lines_cost_fields', sql`(kind = 'passed_cost') = (passed_cost_id IS NOT NULL) AND (kind = 'credit') = (credit_id IS NOT NULL)`),
  check('ic_statement_lines_amount_check', sql`CASE WHEN kind = 'credit' THEN amount_minor < 0 ELSE amount_minor >= 0 END`),
  check('ic_statement_lines_project_fields', sql`(project_kind IS NULL) = (project_public_id IS NULL) AND (project_kind IS NULL OR project_kind IN ('project','design_request'))`),
  check('ic_statement_lines_service_check', sql`service_type IS NULL OR service_type IN ('design','software','iot_hardware','cgi')`),
  check('ic_statement_lines_dispute_fields', sql`(dispute_reason IS NULL) = (disputed_by IS NULL) AND (disputed_by IS NULL) = (disputed_at IS NULL)
    AND (dispute_reason IS NULL OR char_length(trim(dispute_reason)) >= 3)`),
  check('ic_statement_lines_resolution_fields', sql`(resolution IS NULL) = (resolution_reason IS NULL) AND (resolution IS NULL) = (resolved_by IS NULL)
    AND (resolution IS NULL) = (resolved_at IS NULL) AND (resolution IS NULL OR (resolution IN ('corrected','removed','explained') AND disputed_at IS NOT NULL))
    AND (resolution_reason IS NULL OR char_length(trim(resolution_reason)) >= 3)`),
  check('ic_statement_lines_removed_check', sql`status <> 'removed' OR resolution = 'removed'`),
  check('ic_statement_lines_original_check', sql`original_amount_minor IS NULL OR resolution IN ('corrected','removed')`),
]);

/** Which tickets' time is on a labour line, and how many minutes of each. Written with the line (draft only). */
export const icStatementLineTickets = intercompany.table('ic_statement_line_tickets', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  lineId: bigint('line_id', { mode: 'number' }).notNull(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  minutes: integer('minutes').notNull(),
}, (t) => [
  foreignKey({ name: 'ic_statement_line_tickets_line_company_fk', columns: [t.lineId, t.legalEntityId], foreignColumns: [icStatementLines.id, icStatementLines.legalEntityId] }),
  foreignKey({ name: 'ic_statement_line_tickets_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  unique('ic_statement_line_tickets_unique').on(t.lineId, t.ticketId),
  index('idx_ic_statement_line_tickets_ticket').on(t.ticketId),
  check('ic_statement_line_tickets_minutes_check', sql`minutes > 0`),
]);

/**
 * A correction of a line made after its statement was invoiced: it goes on the agreement's next statement built as a
 * credit line (the line with credit_id). Append-only (trigger).
 */
export const icCredits = intercompany.table('ic_credits', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  agreementId: bigint('agreement_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  lineId: bigint('line_id', { mode: 'number' }).notNull(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  reason: text('reason').notNull(),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t): PgTableExtraConfigValue[] => [
  foreignKey({ name: 'ic_credits_agreement_company_fk', columns: [t.agreementId, t.legalEntityId], foreignColumns: [icAgreements.id, icAgreements.legalEntityId] }),
  foreignKey({ name: 'ic_credits_line_company_fk', columns: [t.lineId, t.legalEntityId], foreignColumns: [icStatementLines.id, icStatementLines.legalEntityId] }),
  unique('ic_credits_id_company_unique').on(t.id, t.legalEntityId),
  index('idx_ic_credits_agreement').on(t.agreementId),
  check('ic_credits_amount_positive', sql`amount_minor > 0`),
  check('ic_credits_currency_check', sql`currency = 'INR'`),
  check('ic_credits_reason_check', sql`char_length(trim(reason)) >= 3`),
]);

/**
 * A statement line's dispute thread: each dispute (the receiver), correction, removal or explanation (the provider) and
 * credit after invoicing, with its reason and the amount before and after. Append-only (trigger, migration 0042).
 */
export const icStatementLineEvents = intercompany.table('ic_statement_line_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  lineId: bigint('line_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  /** the statement's send round the event belongs to */
  round: integer('round').notNull(),
  kind: text('kind').notNull(),
  reason: text('reason').notNull(),
  amountBeforeMinor: bigint('amount_before_minor', { mode: 'number' }),
  amountAfterMinor: bigint('amount_after_minor', { mode: 'number' }),
  byPersonId: bigint('by_person_id', { mode: 'number' }).notNull().references(() => persons.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ic_statement_line_events_line_company_fk', columns: [t.lineId, t.legalEntityId], foreignColumns: [icStatementLines.id, icStatementLines.legalEntityId] }),
  index('idx_ic_statement_line_events_line').on(t.lineId, t.id),
  check('ic_statement_line_events_kind_check', sql`kind IN ('disputed','corrected','removed','explained','credited')`),
  check('ic_statement_line_events_reason_check', sql`char_length(trim(reason)) >= 3`),
  check('ic_statement_line_events_round_check', sql`round >= 1`),
]);
