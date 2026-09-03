import { z } from 'zod';

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
});
export type Job = z.infer<typeof JobSchema>;
