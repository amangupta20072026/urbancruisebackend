// Random UUID v4 (node:crypto).
import { randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();
