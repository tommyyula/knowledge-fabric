import { z } from "zod";

const operationParameterSchema = z.object({
  name: z.string(),
  value: z.string(),
  source: z.string(),
  description: z.string().optional().default(""),
});

const operationContextSchema = z.object({
  environment: z.string().optional().default(""),
  windowTitle: z.string().optional().default(""),
  layout: z.string().optional().default(""),
  visibleContent: z.string().optional().default(""),
});

export const videoOperationSchema = z.object({
  seq: z.coerce.number().int().nonnegative(),
  screen: z.coerce.number().int().nonnegative(),
  systemPath: z.string(),
  operation: z.string(),
  startSecond: z.coerce.number().nonnegative(),
  endSecond: z.coerce.number().nonnegative(),
  context: operationContextSchema.nullable().optional().default(null),
  parameters: z.array(operationParameterSchema).optional().default([]),
});

const operationArraySchema = z.array(videoOperationSchema).min(1);

export const videoAnalysisResponseSchema = z.union([
  operationArraySchema,
  z.object({ operations: operationArraySchema }),
]);

export type VideoOperation = z.infer<typeof videoOperationSchema>;

export function normalizeVideoOperations(
  value: z.infer<typeof videoAnalysisResponseSchema>,
  videoCount: number,
): VideoOperation[] {
  const operations = Array.isArray(value) ? value : value.operations;
  if (operations.some((operation) => operation.screen >= videoCount)) {
    throw new Error("The model returned an invalid screen index.");
  }
  return [...operations]
    .sort(
      (left, right) =>
        left.startSecond - right.startSecond ||
        left.screen - right.screen ||
        left.endSecond - right.endSecond,
    )
    .map((operation, index) => ({
      ...operation,
      seq: index + 1,
      endSecond: Math.max(operation.startSecond, operation.endSecond),
    }));
}

const sopParameterSchema = z.object({
  name: z.string(),
  value: z.string(),
  source: z.string(),
  description: z.string().optional().default(""),
  required: z.boolean().optional().default(false),
});

const sopStepSchema = z.object({
  stepNumber: z.coerce.number().int().positive(),
  action: z.string(),
  system: z.string(),
  page: z.string(),
  details: z.string(),
  parameters: z.array(sopParameterSchema).optional().default([]),
});

export const sopResultSchema = z.object({
  ticketId: z.string().nullable().optional().default(null),
  ticketInference: z.enum(["provided", "detected", "not_found"]).optional().default("not_found"),
  inferenceNote: z.string().optional().default(""),
  title: z.string(),
  summary: z.string(),
  category: z.string(),
  systems_involved: z.array(z.string()).optional().default([]),
  preconditions: z.array(z.string()).optional().default([]),
  steps: z.array(sopStepSchema).min(1),
  notes: z.array(z.string()).optional().default([]),
  cross_screen_operations: z.array(z.string()).optional().default([]),
});

export type SopResult = z.infer<typeof sopResultSchema>;

export function normalizeSopResult(result: SopResult): SopResult {
  return {
    ...result,
    steps: result.steps.map((step, index) => ({
      ...step,
      stepNumber: index + 1,
    })),
  };
}
