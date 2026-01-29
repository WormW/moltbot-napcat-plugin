import { z } from "zod";

import { DmPolicySchema } from "clawdbot/plugin-sdk";

const NapcatAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    wsUrl: z.string().optional(),
    httpUrl: z.string().optional(),
    accessToken: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("open"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    mediaMaxMb: z.number().int().positive().optional(),
  })
  .strict();

export const NapcatConfigSchema = NapcatAccountSchemaBase.extend({
  accounts: z.record(z.string(), NapcatAccountSchemaBase.optional()).optional(),
}).strict();
