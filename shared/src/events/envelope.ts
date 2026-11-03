/** Every event between modules uses this envelope. */
export interface EventEnvelope<TType extends string, TPayload> {
  eventId: string;          // uuid
  eventType: TType;
  eventVersion: number;
  tenantId: number;
  aggregatePublicId: string;
  aggregateVersion?: number;
  causedBy?: string;        // person public id
  correlationId?: string;
  occurredAt: string;       // ISO time
  payload: TPayload;
}
