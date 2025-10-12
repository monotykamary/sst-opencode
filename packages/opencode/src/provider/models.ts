import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import z from "zod/v4"
import { data } from "./models-macro" with { type: "macro" }
import { Installation } from "../installation"

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  const filepath = path.join(Global.Path.cache, "models.json")

  const isoDate = z
    .string()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/, {
      message: "Must be in YYYY-MM or YYYY-MM-DD format",
    })

  export const Model = z
    .object({
      id: z.string(),
      name: z.string().min(1, "Model name cannot be empty"),
      attachment: z.boolean(),
      reasoning: z.boolean(),
      temperature: z.boolean(),
      tool_call: z.boolean(),
      knowledge: isoDate.optional(),
      release_date: isoDate,
      last_updated: isoDate,
      modalities: z.object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      }),
      open_weights: z.boolean(),
      cost: z
        .object({
          input: z.number().min(0, "Input price cannot be negative"),
          output: z.number().min(0, "Output price cannot be negative"),
          reasoning: z.number().min(0, "Reasoning price cannot be negative").optional(),
          cache_read: z.number().min(0, "Cache read price cannot be negative").optional(),
          cache_write: z.number().min(0, "Cache write price cannot be negative").optional(),
          input_audio: z.number().min(0, "Audio input price cannot be negative").optional(),
          output_audio: z.number().min(0, "Audio output price cannot be negative").optional(),
        })
        .optional(),
      limit: z.object({
        context: z.number().min(0, "Context window must be positive"),
        output: z.number().min(0, "Output tokens must be positive"),
      }),
      alpha: z.boolean().optional(),
      beta: z.boolean().optional(),
      experimental: z.boolean().optional(),
      options: z.record(z.string(), z.any()).optional(),
      provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
    })
    .refine(
      (data) => !(data.reasoning === false && data.cost?.reasoning !== undefined),
      {
        message: "Cannot set cost.reasoning when reasoning is false",
        path: ["cost", "reasoning"],
      },
    )
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Provider = z
    .object({
      api: z
        .string()
        .optional(),
      name: z.string().min(1, "Provider name cannot be empty"),
      env: z.array(z.string()).min(1, "Provider env cannot be empty"),
      id: z.string(),
      npm: z.string().min(1, "Provider npm module cannot be empty"),
      doc: z.string().min(1, "Please provide provider documentation link"),
      models: z.record(z.string(), Model),
      options: z.record(z.string(), z.any()).optional(),
    })
    .refine(
      (data) =>
        (data.npm === "@ai-sdk/openai-compatible" && data.api !== undefined) ||
        (data.npm !== "@ai-sdk/openai-compatible" && data.api === undefined),
      {
        message: "'api' field is required if and only if npm is '@ai-sdk/openai-compatible'",
        path: ["api"],
      },
    )
    .meta({
      ref: "Provider",
    })

  export type Provider = z.infer<typeof Provider>

  export async function get() {
    refresh()
    const file = Bun.file(filepath)
    const result = await file.json().catch(() => {})
    if (result) return result as Record<string, Provider>
    const json = await data()
    return JSON.parse(json) as Record<string, Provider>
  }

  export async function refresh() {
    const file = Bun.file(filepath)
    log.info("refreshing", {
      file,
    })
    const result = await fetch("https://models.dev/api.json", {
      headers: {
        "User-Agent": Installation.USER_AGENT,
      },
      signal: AbortSignal.timeout(10 * 1000),
    }).catch((e) => {
      log.error("Failed to fetch models.dev", {
        error: e,
      })
    })
    if (result && result.ok) await Bun.write(file, await result.text())
  }
}

setInterval(() => ModelsDev.refresh(), 60 * 1000 * 60).unref()
