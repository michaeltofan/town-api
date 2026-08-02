import { Type, type Static } from '@sinclair/typebox';

export const LiveResponseSchema = Type.Object(
  {
    status: Type.Literal('ok'),
  },
  {
    additionalProperties: false,
    $id: 'LiveResponse',
  },
);

/**
 * Internal readiness component checks. Used by the readiness route for
 * decisions and logging; not returned on the public /health/ready body.
 */
export const HealthChecksSchema = Type.Object(
  {
    config: Type.Union([Type.Literal('ok'), Type.Literal('fail')]),
    database: Type.Union([Type.Literal('ok'), Type.Literal('fail'), Type.Literal('timeout')]),
    migrations: Type.Union([Type.Literal('ok'), Type.Literal('fail'), Type.Literal('unknown')]),
  },
  {
    additionalProperties: false,
    $id: 'HealthChecks',
  },
);

export const ReadyResponseSchema = Type.Object(
  {
    status: Type.Literal('ready'),
  },
  {
    additionalProperties: false,
    $id: 'ReadyResponse',
  },
);

export const NotReadyResponseSchema = Type.Object(
  {
    status: Type.Literal('not_ready'),
  },
  {
    additionalProperties: false,
    $id: 'NotReadyResponse',
  },
);

/** Public build identity — omits nodeVersion / migration count / timestamps. */
export const BuildResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        service: Type.Literal('town-api'),
        version: Type.String({ minLength: 1 }),
        commitSha: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        environment: Type.Union([
          Type.Literal('development'),
          Type.Literal('test'),
          Type.Literal('staging'),
          Type.Literal('production'),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  {
    additionalProperties: false,
    $id: 'BuildResponse',
  },
);

export type LiveResponse = Static<typeof LiveResponseSchema>;
export type ReadyResponse = Static<typeof ReadyResponseSchema>;
export type NotReadyResponse = Static<typeof NotReadyResponseSchema>;
export type HealthChecks = Static<typeof HealthChecksSchema>;
export type BuildResponse = Static<typeof BuildResponseSchema>;
