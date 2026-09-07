import { z } from 'zod';

export const OutputKindSchema = z.enum(['image', 'theme', 'component']);
export type OutputKind = z.infer<typeof OutputKindSchema>;

export const NineSliceMarginsSchema = z.object({
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
  left: z.number(),
});
export type NineSliceMargins = z.infer<typeof NineSliceMarginsSchema>;

export const StyleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  created_by: z.string().min(1),
  parameters: z.string(), // JSON-serialized parameters blob
  forked_from: z.string().uuid().nullable(),
  is_deleted: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Style = z.infer<typeof StyleSchema>;

export const AssetSchema = z.object({
  id: z.string().uuid(),
  style_id: z.string().uuid(),
  created_by: z.string().min(1),
  asset_type: z.string().min(1),
  prompt: z.string().min(1),
  image_path: z.string().nullable(),
  created_at: z.number().int(),
  is_deleted: z.union([z.literal(0), z.literal(1)]),
  source_job_id: z.string().uuid().nullable(),
  nine_slice_margins: z.string().nullable(),
  states: z.string(),
  output_kind: OutputKindSchema.default('image'),
});
export type Asset = z.infer<typeof AssetSchema>;

export const JobStatusSchema = z.enum([
  'pending',
  'processing',
  'complete',
  'promoted',
  'discarded',
  'failed',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSchema = z.object({
  id: z.string().uuid(),
  style_id: z.string().uuid(),
  created_by: z.string().min(1),
  asset_type: z.string().min(1),
  prompt: z.string().min(1),
  status: JobStatusSchema,
  result_path: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  options: z.string(), // JSON-serialized options blob
  output_kind: OutputKindSchema.default('image'),
  batch_id: z.string().uuid().nullable().default(null),
});
export type Job = z.infer<typeof JobSchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  is_admin: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int(),
});
export type User = z.infer<typeof UserSchema>;

export const PresetComponentSchema = z.object({
  assetType: z.string().min(1),
  prompt: z.string().min(1),
});
export type PresetComponent = z.infer<typeof PresetComponentSchema>;

export const PresetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  created_by: z.string().min(1),
  prompt: z.string().min(1),
  tech_stack_tags: z.string(), // JSON-serialized string[]
  theme_prompt: z.string().nullable(),
  components: z.string(), // JSON-serialized PresetComponent[]
  is_deleted: z.union([z.literal(0), z.literal(1)]),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Preset = z.infer<typeof PresetSchema>;
