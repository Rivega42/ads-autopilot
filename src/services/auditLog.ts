import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { logger } from '../logger.js';

export interface AuditEntry {
  actor: string;
  action: string;
  resource: string;
  ip?: string;
  metadata?: Prisma.InputJsonValue;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({ data: entry });
  } catch (err) {
    logger.error({ err, entry }, 'auditLog: failed to write');
  }
}
