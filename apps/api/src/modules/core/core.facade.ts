import { Injectable } from '@nestjs/common';
import { Tx } from '../../platform/db/db.module';
import { personContacts, persons } from './schema';

export interface NewPerson {
  tenantId: number;
  personType: 'employee' | 'external_worker' | 'contractor_staff';
  displayName: string;
  contacts: { kind: string; value: string; label?: string; isPrimary: boolean }[];
}

/** The only Core entry point other modules may use. */
@Injectable()
export class CoreFacade {
  /** Newest version of a policy in force on a date, most specific scope first. */
  async getPolicy<T>(key: string, _scope: { branchId?: number; departmentId?: number }, _onDate: string, fallback: T): Promise<T> {
    return fallback; // replaced by a real lookup on core.policies in Sprint 2
  }

  /** Creates a person and their contacts inside the caller's transaction. The internal id is for foreign keys only. */
  async createPerson(tx: Tx, p: NewPerson): Promise<{ id: number; publicId: string }> {
    const [person] = await tx.insert(persons)
      .values({ tenantId: p.tenantId, personType: p.personType, displayName: p.displayName, fullName: p.displayName })
      .returning({ id: persons.id, publicId: persons.publicId });
    if (p.contacts.length) {
      await tx.insert(personContacts).values(p.contacts.map((c) => ({ tenantId: p.tenantId, personId: person.id, ...c })));
    }
    return person;
  }
}
