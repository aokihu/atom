import { tool } from "ai";
import { z } from "zod";
import type { ContextMemoryBlock } from "../../../types/agent";
import type { ToolExecutionContext } from "./types";
import { createPermissionPolicy } from "./permissions/policy";
import {
  closePersistentMemoryDatabase,
  getPersistentMemoryDbPath,
  openPersistentMemoryDatabase,
} from "../memory/persistent_db";
import { PersistentMemoryStore } from "../memory/persistent_store";

const memoryTierEnum = z.enum(["core", "longterm"]);
const memorySearchModeEnum = z.enum(["auto", "fts", "like"]);

const writeInputSchema = z
  .object({
    block_id: z.string().min(1),
    content: z.string().min(1),
    source_tier: memoryTierEnum.optional(),
    type: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    decay: z.number().min(0).max(1).optional(),
    round: z.number().int().min(1).optional(),
    source_task_id: z.string().optional(),
  })
  .strict();

const searchInputSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).optional(),
    mode: memorySearchModeEnum.optional(),
    hydrate_tag_ref: z.boolean().optional(),
  })
  .strict();

const getInputSchema = z
  .object({
    entry_id: z.number().int().positive().optional(),
    block_id: z.string().min(1).optional(),
    resolve_tag_ref: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.entry_id !== undefined || value.block_id !== undefined, {
    message: "entry_id or block_id is required",
  });

const updateInputSchema = z
  .object({
    entry_id: z.number().int().positive(),
    content: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    decay: z.number().min(0).max(1).optional(),
    status: z.string().nullable().optional(),
    source_tier: memoryTierEnum.optional(),
    content_state: z.enum(["active", "tag_ref"]).optional(),
    tag_id: z.string().nullable().optional(),
    tag_summary: z.string().nullable().optional(),
    source_task_id: z.string().nullable().optional(),
  })
  .strict();

const deleteInputSchema = z
  .object({
    entry_id: z.number().int().positive().optional(),
    block_id: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => value.entry_id !== undefined || value.block_id !== undefined, {
    message: "entry_id or block_id is required",
  });

const feedbackInputSchema = z
  .object({
    entry_id: z.number().int().positive(),
    direction: z.enum(["positive", "negative"]),
  })
  .strict();

const tagResolveInputSchema = z
  .object({
    tag_id: z.string().min(1),
    hydrate_entries: z.boolean().optional(),
  })
  .strict();

const compactInputSchema = z
  .object({})
  .strict();

const listRecentInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const invalidInput = (error: string, detail?: string) => ({
  error,
  ...(detail ? { detail } : {}),
});

const formatZodInputError = (error: z.ZodError) =>
  error.issues[0]?.message ?? "Invalid input";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const toBlockFromEntry = (entry: Record<string, unknown>): ContextMemoryBlock => {
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((item): item is string => typeof item === "string")
    : [];

  return {
    id: String(entry.block_id ?? ""),
    type: typeof entry.type === "string" ? entry.type : "memory_note",
    decay: clamp01(typeof entry.decay === "number" ? entry.decay : 0.2),
    confidence: clamp01(typeof entry.confidence === "number" ? entry.confidence : 0.8),
    round:
      typeof entry.last_seen_round === "number" && Number.isFinite(entry.last_seen_round)
        ? Math.max(1, Math.trunc(entry.last_seen_round))
        : 1,
    tags,
    content: typeof entry.content === "string" ? entry.content : "",
    ...(entry.content_state === "tag_ref" || entry.content_state === "active"
      ? { content_state: entry.content_state }
      : {}),
    ...(typeof entry.tag_id === "string" ? { tag_id: entry.tag_id } : {}),
    ...(typeof entry.tag_summary === "string" ? { tag_summary: entry.tag_summary } : {}),
    ...(typeof entry.rehydrated_at === "number" ? { rehydrated_at: entry.rehydrated_at } : {}),
  };
};

const buildContextPatchFromEntries = (entries: Array<Record<string, unknown>>) => {
  const core: ContextMemoryBlock[] = [];
  const longterm: ContextMemoryBlock[] = [];

  for (const entry of entries) {
    const tier = entry.source_tier === "longterm" ? "longterm" : "core";
    const block = toBlockFromEntry(entry);
    if (!block.id || !block.content) continue;
    if (tier === "longterm") {
      longterm.push(block);
    } else {
      core.push(block);
    }
  }

  const patch: Record<string, unknown> = {};
  if (core.length > 0 || longterm.length > 0) {
    patch.memory = {
      ...(core.length > 0 ? { core } : {}),
      ...(longterm.length > 0 ? { longterm } : {}),
    };
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
};

const getWorkspaceFromContext = (context: ToolExecutionContext) => {
  const workspace = typeof context.workspace === "string" ? context.workspace.trim() : "";
  if (!workspace) {
    return { error: "Workspace unavailable: memory tools require context.workspace" } as const;
  }
  return { workspace } as const;
};

const withAuthorizedMemory = async <T>(
  context: ToolExecutionContext,
  fn: (helpers: {
    useCoordinator: () => NonNullable<ToolExecutionContext["persistentMemoryCoordinator"]>;
    useStoreFallback: () => Promise<T>;
  }) => Promise<T>,
) => {
  const workspaceResult = getWorkspaceFromContext(context);
  if ("error" in workspaceResult) {
    return workspaceResult as T;
  }

  const dbPath = getPersistentMemoryDbPath(workspaceResult.workspace);
  if (!createPermissionPolicy(context).canUseMemory(dbPath)) {
    return { error: "Permission denied: memory path not allowed" } as T;
  }

  const coordinator = context.persistentMemoryCoordinator;
  const hasCoordinator = coordinator?.status.available === true;

  try {
    return await fn({
      useCoordinator: () => {
        if (!hasCoordinator || !coordinator) {
          throw new Error("Persistent memory unavailable");
        }
        return coordinator;
      },
      useStoreFallback: async () => {
        const handle = openPersistentMemoryDatabase(workspaceResult.workspace);
        const store = new PersistentMemoryStore(handle);
        try {
          const entries = await store.listRecent(30);
          return {
            success: true,
            fallback: true,
            entries: entries.map((entry) => ({
              id: entry.id,
              block_id: entry.blockId,
              source_tier: entry.sourceTier,
              type: entry.memoryType,
              summary: entry.summary,
              content: entry.content,
              content_state: entry.contentState,
              tag_id: entry.tagId,
              tag_summary: entry.tagSummary,
              tags: entry.tags,
              confidence: entry.confidence,
              decay: entry.decay,
              status: entry.status,
              first_seen_round: entry.firstSeenRound,
              last_seen_round: entry.lastSeenRound,
              source_task_id: entry.sourceTaskId,
              created_at: entry.createdAt,
              updated_at: entry.updatedAt,
              last_recalled_at: entry.lastRecalledAt,
              rehydrated_at: entry.rehydratedAt,
              recall_count: entry.recallCount,
              feedback_positive: entry.feedbackPositive,
              feedback_negative: entry.feedbackNegative,
            })),
          } as T;
        } finally {
          await closePersistentMemoryDatabase(handle);
        }
      },
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "memory tool failed",
    } as T;
  }
};

export const memoryWriteTool = (context: ToolExecutionContext) =>
  tool({
    description: "Write or update a persistent memory entry",
    inputSchema: writeInputSchema,
    execute: async (input: z.infer<typeof writeInputSchema>) => {
      const parsed = writeInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid memory_write input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedMemory(context, async ({ useCoordinator }) => {
        const coordinator = useCoordinator();
        const upsert = await coordinator.upsert({
          items: [{
            blockId: parsed.data.block_id,
            content: parsed.data.content,
            sourceTier: parsed.data.source_tier,
            type: parsed.data.type,
            tags: parsed.data.tags,
            confidence: parsed.data.confidence,
            decay: parsed.data.decay,
            round: parsed.data.round,
            sourceTaskId: parsed.data.source_task_id ?? null,
          }],
        });
        const entry = await coordinator.get({
          blockId: parsed.data.block_id,
        });
        const contextPatch = entry ? buildContextPatchFromEntries([entry]) : undefined;
        return {
          success: true,
          upsert,
          ...(entry ? { entry } : {}),
          ...(contextPatch ? { context_patch: contextPatch } : {}),
        };
      });
    },
  });

export const memorySearchTool = (context: ToolExecutionContext) =>
  tool({
    description: "Search persistent memory entries by query",
    inputSchema: searchInputSchema,
    execute: async (input: z.infer<typeof searchInputSchema>) => {
      const parsed = searchInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid memory_search input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedMemory(context, async ({ useCoordinator }) => {
        const coordinator = useCoordinator();
        const result = await coordinator.search({
          query: parsed.data.query,
          limit: parsed.data.limit,
          mode: parsed.data.mode,
          hydrateTagRefs: parsed.data.hydrate_tag_ref ?? false,
        });
        return {
          success: true,
          mode: result.modeUsed,
          hits: result.hits,
        };
      });
    },
  });

export const memoryGetTool = (context: ToolExecutionContext) =>
  tool({
    description: "Get a persistent memory entry by entry_id or block_id",
    inputSchema: getInputSchema,
    execute: async (input: z.infer<typeof getInputSchema>) => {
      const parsed = getInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid memory_get input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedMemory(context, async ({ useCoordinator }) => {
        const coordinator = useCoordinator();
        const entry = await coordinator.get({
          entryId: parsed.data.entry_id,
          blockId: parsed.data.block_id,
        });
        if (!entry) {
          return { error: "Memory entry not found" };
        }

        let resolvedTagContent: string | null = null;
        if (
          parsed.data.resolve_tag_ref &&
          entry.content_state === "tag_ref" &&
          typeof entry.tag_id === "string"
        ) {
          const resolved = await coordinator.resolveTag({
            tagId: entry.tag_id,
            hydrateEntries: true,
          });
          resolvedTagContent = typeof resolved.content === "string" ? resolved.content : null;
        }

        const refreshed = await coordinator.get({ entryId: Number(entry.id) });
        const contextPatch = refreshed ? buildContextPatchFromEntries([refreshed]) : undefined;
        return {
          success: true,
          entry: refreshed ?? entry,
          ...(resolvedTagContent !== null ? { resolved_tag_content: resolvedTagContent } : {}),
          ...(contextPatch ? { context_patch: contextPatch } : {}),
        };
      });
    },
  });

export const memoryUpdateTool = (context: ToolExecutionContext) =>
  tool({
    description: "Update a persistent memory entry",
    inputSchema: updateInputSchema,
    execute: async (input: z.infer<typeof updateInputSchema>) => {
      const parsed = updateInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid memory_update input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedMemory(context, async ({ useCoordinator }) => {
        const coordinator = useCoordinator();
        const entry = await coordinator.update({
          entryId: parsed.data.entry_id,
          patch: {
            ...(parsed.data.content !== undefined ? { content: parsed.data.content } : {}),
            ...(parsed.data.summary !== undefined ? { summary: parsed.data.summary } : {}),
            ...(parsed.data.tags !== undefined ? { tags: parsed.data.tags } : {}),
            ...(parsed.data.confidence !== undefined ? { confidence: parsed.data.confidence } : {}),
            ...(parsed.data.decay !== undefined ? { decay: parsed.data.decay } : {}),
            ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
            ...(parsed.data.source_tier !== undefined ? { sourceTier: parsed.data.source_tier } : {}),
            ...(parsed.data.content_state !== undefined ? { contentState: parsed.data.content_state } : {}),
            ...(parsed.data.tag_id !== undefined ? { tagId: parsed.data.tag_id } : {}),
            ...(parsed.data.tag_summary !== undefined ? { tagSummary: parsed.data.tag_summary } : {}),
            ...(parsed.data.source_task_id !== undefined ? { sourceTaskId: parsed.data.source_task_id } : {}),
          },
        });
        if (!entry) {
          return { error: "Memory entry not found" };
        }

        const contextPatch = buildContextPatchFromEntries([entry]);
        return {
          success: true,
          entry,
          ...(contextPatch ? { context_patch: contextPatch } : {}),
        };
      });
    },
  });

export const memoryDeleteTool = (context: ToolExecutionContext) =>
  tool({
    description: "Delete a persistent memory entry by entry_id or block_id",
    inputSchema: deleteInputSchema,
    execute: async (input: z.infer<typeof deleteInputSchema>) => {
      const parsed = deleteInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid memory_delete input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedMemory(context, async ({ useCoordinator }) => {
        const coordinator = useCoordinator();
        const result = await coordinator.delete({
          entryId: parsed.data.entry_id,
          blockId: parsed.data.block_id,
        });
        return {
          success: result.deleted,
        };
      });
    },
  });

export const memoryFeedbackTool = (context: ToolExecutionContext) =>
  tool({
    description: "Submit positive/negative feedback for a memory entry",
    inputSchema: feedbackInputSchema,
    execute: async (input: z.infer<typeof feedbackInputSchema>) => {
      const parsed = feedbackInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid memory_feedback input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedMemory(context, async ({ useCoordinator }) => {
        const coordinator = useCoordinator();
        const result = await coordinator.feedback({
          entryId: parsed.data.entry_id,
          direction: parsed.data.direction,
        });
        return {
          success: result.ok,
        };
      });
    },
  });

export const memoryTagResolveTool = (context: ToolExecutionContext) =>
  tool({
    description: "Resolve tag-ref memory payload by tag_id and optionally rehydrate entries",
    inputSchema: tagResolveInputSchema,
    execute: async (input: z.infer<typeof tagResolveInputSchema>) => {
      const parsed = tagResolveInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid memory_tag_resolve input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedMemory(context, async ({ useCoordinator }) => {
        const coordinator = useCoordinator();
        const resolved = await coordinator.resolveTag({
          tagId: parsed.data.tag_id,
          hydrateEntries: parsed.data.hydrate_entries ?? true,
        });
        const rawHydrated: unknown[] = Array.isArray(resolved.hydrated_entries)
          ? [...resolved.hydrated_entries]
          : [];
        const hydratedEntries = rawHydrated.filter((entry): entry is Record<string, unknown> => (
          typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ));
        const contextPatch = buildContextPatchFromEntries(hydratedEntries);
        return {
          success: typeof resolved.content === "string",
          tag_id: resolved.tag_id,
          content: resolved.content,
          hydrated_entries: hydratedEntries,
          ...(contextPatch ? { context_patch: contextPatch } : {}),
        };
      });
    },
  });

export const memoryCompactTool = (context: ToolExecutionContext) =>
  tool({
    description: "Run manual memory compaction (tagging low-importance reusable memory)",
    inputSchema: compactInputSchema,
    execute: async (input: z.infer<typeof compactInputSchema>) => {
      const parsed = compactInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid memory_compact input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedMemory(context, async ({ useCoordinator }) => {
        const coordinator = useCoordinator();
        const statsBefore = await coordinator.getStats();
        const compact = await coordinator.compactNow();
        const statsAfter = await coordinator.getStats();
        return {
          success: true,
          compact,
          stats_before: statsBefore,
          stats_after: statsAfter,
        };
      });
    },
  });

export const memoryListRecentTool = (context: ToolExecutionContext) =>
  tool({
    description: "List recent persistent memory entries",
    inputSchema: listRecentInputSchema,
    execute: async (input: z.infer<typeof listRecentInputSchema>) => {
      const parsed = listRecentInputSchema.safeParse(input);
      if (!parsed.success) {
        return invalidInput("Invalid memory_list_recent input", formatZodInputError(parsed.error));
      }

      return await withAuthorizedMemory(context, async ({ useCoordinator, useStoreFallback }) => {
        try {
          const coordinator = useCoordinator();
          const entries = await coordinator.listRecent(parsed.data.limit ?? 20);
          return {
            success: true,
            count: entries.length,
            entries,
          };
        } catch {
          return await useStoreFallback();
        }
      });
    },
  });
