import { pgSchema } from 'drizzle-orm/pg-core';

/**
 * TOWN PostgreSQL Foundation V1 declares only the logical schema namespace.
 * Product tables are intentionally out of scope for this slice.
 */
export const town = pgSchema('town');
