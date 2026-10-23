import { z } from 'zod';

const symbols = z.array(z.string().min(1).max(20)).max(100).default([]);
const magics = z.array(z.number().int().nonnegative()).max(100).default([]);
const comment = z.string().max(100).default('');

export const accountCreate = z
  .object({
    name: z.string().min(1).max(60),
    login: z.string().min(1).max(30),
    server: z.string().min(1).max(100),
    provider: z.enum(['mock', 'bridge']).default('mock'),
    password: z.string().max(200).optional(),
    active: z.boolean().default(true),
  })
  .strict();

export const accountUpdate = accountCreate.partial().strict();

export const closeBody = z.object({ volume: z.number().positive().optional() }).strict();
export const modifyBody = z
  .object({ sl: z.number().nonnegative().optional(), tp: z.number().nonnegative().optional() })
  .strict()
  .refine((v) => v.sl !== undefined || v.tp !== undefined, 'sl or tp required');
export const beBody = z.object({ offsetPoints: z.number().nonnegative().default(0) }).strict();

export const beConfig = z
  .object({
    mode: z.enum(['points', 'pips', 'money']),
    threshold: z.number().positive(),
    offsetPoints: z.number().nonnegative().default(0),
    symbols,
    magics,
    commentContains: comment,
    cooldownSec: z.number().int().min(5).max(86400).default(60),
  })
  .strict();

export const autoSltpConfig = z
  .object({
    unit: z.enum(['points', 'pips']),
    slDistance: z.number().nonnegative().default(0),
    tpDistance: z.number().nonnegative().default(0),
    riskPercent: z.number().min(0).max(100).default(0),
    overwrite: z.boolean().default(false),
    symbols,
    magics,
    commentContains: comment,
    session: z
      .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(24) })
      .nullable()
      .default(null),
  })
  .strict();

export const ruleBody = (configSchema) => z.object({ enabled: z.boolean(), config: configSchema }).strict();
export const ruleSchemas = { be: ruleBody(beConfig), autosltp: ruleBody(autoSltpConfig) };

export const copyConfig = z
  .object({
    multiplier: z.number().positive().max(100).default(1),
    minLot: z.number().positive().default(0.01),
    maxLot: z.number().positive().default(100),
    symbols,
    inverse: z.boolean().default(false),
  })
  .strict()
  .refine((c) => c.minLot <= c.maxLot, 'minLot must be <= maxLot');

export const linkCreate = z
  .object({
    sourceAccountId: z.number().int().positive(),
    destAccountId: z.number().int().positive(),
    enabled: z.boolean().default(true),
    config: copyConfig.default({}),
  })
  .strict();
export const linkUpdate = z.object({ enabled: z.boolean().optional(), config: copyConfig.optional() }).strict();

export const settingsBody = z.object({ killSwitch: z.boolean().optional(), dryRun: z.boolean().optional() }).strict();
export const loginBody = z.object({ password: z.string().min(1).max(500) }).strict();
