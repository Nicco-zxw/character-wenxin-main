import { z } from 'zod'

export const MemoryLayerSchema = z.enum(['M0', 'M1', 'M2', 'M3', 'M4'])
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>

const UnknownRecordSchema = z.record(z.string(), z.unknown())

export const NarrativeSnapshotSchema = z.object({
  constitution: UnknownRecordSchema,
  truth: UnknownRecordSchema,
  episodes: UnknownRecordSchema,
  evidence: UnknownRecordSchema,
  working: UnknownRecordSchema
}).strict()
export type NarrativeSnapshot = z.infer<typeof NarrativeSnapshotSchema>

export const NarrativeProjectionEnvelopeSchema = z.object({
  schemaVersion: z.number().int().positive(),
  projectId: z.string().trim().min(1),
  ledgerVersion: z.number().int().nonnegative(),
  atChapter: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: NarrativeSnapshotSchema
}).strict()
export type NarrativeProjectionEnvelope = z.infer<typeof NarrativeProjectionEnvelopeSchema>

export const RollbackPlanSchema = z.object({
  projectId: z.string().trim().min(1),
  targetChapter: z.number().int().nonnegative(),
  invalidatedChapters: z.array(z.number().int().nonnegative()),
  retainedChapterIds: z.array(z.string().trim().min(1)),
  baseLedgerVersion: z.number().int().nonnegative()
}).strict().transform((value, ctx) => {
  const invalidatedChapters = [...new Set(value.invalidatedChapters)].sort((a, b) => a - b)
  if (invalidatedChapters.some((chapter) => chapter <= value.targetChapter)) {
    ctx.addIssue({ code: 'custom', message: '失效章节必须晚于回溯目标章' })
    return z.NEVER
  }
  return { ...value, invalidatedChapters }
})
export type RollbackPlan = z.infer<typeof RollbackPlanSchema>
