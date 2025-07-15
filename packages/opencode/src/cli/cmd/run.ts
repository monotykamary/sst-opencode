import type { Argv } from "yargs"
import { Bus } from "../../bus"
import { Provider } from "../../provider/provider"
import { Session } from "../../session"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { Flag } from "../../flag/flag"
import { Config } from "../../config/config"
import { bootstrap } from "../bootstrap"
import { App } from "../../app/app"
import { MCP } from "../../mcp"
import { Auth } from "../../auth"
import { MessageV2 } from "../../session/message-v2"
import { Mode } from "../../session/mode"
import { Identifier } from "../../id/id"

type OutputFormat = "text" | "json" | "stream-json"

interface PrintResult {
  type: "result"
  subtype: "success" | "error"
  is_error: boolean
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  result: string
  session_id: string
  total_cost_usd: number
  usage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
    output_tokens: number
    server_tool_use?: {
      web_search_requests: number
    }
    service_tier: string
  }
}

interface SystemInitEvent {
  type: "system"
  subtype: "init"
  cwd: string
  session_id: string
  tools: string[]
  mcp_servers: string[]
  model: string
  permissionMode: string
  apiKeySource: string
}

interface AssistantMessageEvent {
  type: "assistant"
  message: {
    id: string
    type: "message"
    role: "assistant"
    model: string
    content: Array<{ type: "text"; text: string }>
    stop_reason: string | null
    stop_sequence: string | null
    usage: {
      input_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
      output_tokens: number
      service_tier: string
    }
  }
  parent_tool_use_id: string | null
  session_id: string
}

const TOOL: Record<string, [string, string]> = {
  todowrite: ["Todo", UI.Style.TEXT_WARNING_BOLD],
  todoread: ["Todo", UI.Style.TEXT_WARNING_BOLD],
  bash: ["Bash", UI.Style.TEXT_DANGER_BOLD],
  edit: ["Edit", UI.Style.TEXT_SUCCESS_BOLD],
  glob: ["Glob", UI.Style.TEXT_INFO_BOLD],
  grep: ["Grep", UI.Style.TEXT_INFO_BOLD],
  list: ["List", UI.Style.TEXT_INFO_BOLD],
  read: ["Read", UI.Style.TEXT_HIGHLIGHT_BOLD],
  write: ["Write", UI.Style.TEXT_SUCCESS_BOLD],
  websearch: ["Search", UI.Style.TEXT_DIM_BOLD],
  webfetch: ["Fetch", UI.Style.TEXT_INFO_BOLD],
  lsp_diagnostics: ["LSP", UI.Style.TEXT_DIM_BOLD],
  lsp_hover: ["LSP", UI.Style.TEXT_DIM_BOLD],
  patch: ["Patch", UI.Style.TEXT_SUCCESS_BOLD],
}

// Separate mapping for stream-json output with full descriptive names
const STREAM_TOOL_NAMES: Record<string, string> = {
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  bash: "Bash",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  list: "List",
  read: "Read",
  write: "Write",
  websearch: "WebSearch",
  webfetch: "WebFetch",
  lsp_diagnostics: "LSPDiagnostics",
  lsp_hover: "LSPHover",
  patch: "Patch",
}

async function getAvailableTools(providerID: string): Promise<string[]> {
  const tools = await Provider.tools(providerID)
  const mcpTools = await MCP.tools()

  // Use stream-json specific tool names for full descriptive names
  const toolNames = tools.map((tool) => {
    const streamName = STREAM_TOOL_NAMES[tool.id]
    return streamName || tool.id
  })

  // Add MCP tool names
  const mcpToolNames = Object.keys(mcpTools)

  return [...toolNames, ...mcpToolNames]
}

async function getAvailableMCPServers(): Promise<string[]> {
  const clients = await MCP.clients()
  return Object.keys(clients)
}

async function getAPIKeySource(providerID: string): Promise<string> {
  const authInfo = await Auth.get(providerID)

  if (authInfo?.type === "api") {
    return `${providerID.toUpperCase()}_API_KEY`
  }

  if (authInfo?.type === "oauth") {
    return `${providerID.toUpperCase()}_OAUTH`
  }

  // Check environment variables
  const envVars = [`${providerID.toUpperCase()}_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`]

  for (const envVar of envVars) {
    if (process.env[envVar]) {
      return envVar
    }
  }

  return "UNKNOWN"
}

export const RunCommand = cmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  builder: (yargs: Argv) => {
    return yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("print", {
        alias: ["p"],
        describe: "print mode - output result and exit",
        type: "boolean",
        default: false,
      })
      .option("output-format", {
        describe: "output format (only with --print)",
        type: "string",
        choices: ["text", "json", "stream-json"] as const,
        default: "text" as const,
      })
      .option("verbose", {
        describe: "verbose output (required for stream-json with --print)",
        type: "boolean",
        default: false,
      })
      .option("mode", {
        type: "string",
        describe: "mode to use",
      })
  },
  handler: async (args) => {
    let message = args.message.join(" ")
    const printMode = args.print as boolean
    const outputFormat = args["output-format"] as OutputFormat
    const verbose = args.verbose as boolean

    if (!process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())

    // Validation for print mode
    if (printMode) {
      if (outputFormat === "stream-json" && !verbose) {
        console.error("Error: When using --print, --output-format=stream-json requires --verbose")
        process.exitCode = 1
        return
      }

      if (!message.trim()) {
        if (outputFormat === "json") {
          const errorResult: PrintResult = {
            type: "result",
            subtype: "error",
            is_error: true,
            duration_ms: 0,
            duration_api_ms: 0,
            num_turns: 0,
            result: "No message provided",
            session_id: "",
            total_cost_usd: 0,
            usage: {
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
              service_tier: "standard",
            },
          }
          process.stdout.write(JSON.stringify(errorResult) + "\n")
        } else {
          console.error("Error: No message provided")
        }
        process.exitCode = 1
        return
      }
    }

    const startTime = printMode ? Date.now() : 0
    let apiStartTime = 0
    let apiEndTime = 0

    await bootstrap({ cwd: process.cwd() }, async () => {
      const session = await (async () => {
        if (args.continue) {
          const list = Session.list()
          const first = await list.next()
          await list.return()
          if (first.done) return
          return first.value
        }

        if (args.session) return Session.get(args.session)

        return Session.create()
      })()

      if (!session) {
        UI.error("Session not found")
        return
      }

      const isPiped = !process.stdout.isTTY

      if (!printMode) {
        UI.empty()
        UI.println(UI.logo())
        UI.empty()
        const displayMessage = message.length > 300 ? message.slice(0, 300) + "..." : message
        UI.println(UI.Style.TEXT_NORMAL_BOLD + "> ", displayMessage)
        UI.empty()

        const cfg = await Config.get()
        if (cfg.share === "auto" || Flag.OPENCODE_AUTO_SHARE || args.share) {
          try {
            await Session.share(session.id)
            UI.println(UI.Style.TEXT_INFO_BOLD + "~  https://opencode.ai/s/" + session.id.slice(-8))
          } catch (error) {
            if (error instanceof Error && error.message.includes("disabled")) {
              UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
            } else {
              throw error
            }
          }
        }
        UI.empty()
      }

      const { providerID, modelID } = args.model ? Provider.parseModel(args.model) : await Provider.defaultModel()

      if (!printMode) {
        UI.println(UI.Style.TEXT_NORMAL_BOLD + "@ ", UI.Style.TEXT_NORMAL + `${providerID}/${modelID}`)
        UI.empty()
      }

      // Print mode: output system init for stream-json
      if (printMode && outputFormat === "stream-json" && verbose) {
        const app = App.info()
        const tools = await getAvailableTools(providerID)
        const mcpServers = await getAvailableMCPServers()
        const apiKeySource = await getAPIKeySource(providerID)

        const systemInit: SystemInitEvent = {
          type: "system",
          subtype: "init",
          cwd: app.path.cwd,
          session_id: session.id,
          tools,
          mcp_servers: mcpServers,
          model: `${providerID}-${modelID}`,
          permissionMode: "default",
          apiKeySource,
        }
        process.stdout.write(JSON.stringify(systemInit) + "\n")
      }

      function printEvent(color: string, type: string, title: string) {
        UI.println(
          color + `|`,
          UI.Style.TEXT_NORMAL + UI.Style.TEXT_DIM + ` ${type.padEnd(7, " ")}`,
          "",
          UI.Style.TEXT_NORMAL + title,
        )
      }

      let text = ""
      if (!printMode) {
        Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
          if (evt.properties.part.sessionID !== session.id) return
          if (evt.properties.part.messageID === messageID) return
          const part = evt.properties.part

          if (part.type === "tool" && part.state.status === "completed") {
            const [tool, color] = TOOL[part.tool] ?? [part.tool, UI.Style.TEXT_INFO_BOLD]
            printEvent(color, tool, part.state.title || "Unknown")
          }

          if (part.type === "text") {
            text = part.text

            if (part.time?.end) {
              UI.empty()
              UI.println(UI.markdown(text))
              UI.empty()
              text = ""
              return
            }
          }
        })
      }

      if (printMode) {
        apiStartTime = Date.now()
      }

      let errorMsg: string | undefined
      Bus.subscribe(Session.Event.Error, async (evt) => {
        const { sessionID, error } = evt.properties
        if (sessionID !== session.id || !error) return
        let err = String(error.name)

        if ("data" in error && error.data && "message" in error.data) {
          err = error.data.message
        }
        errorMsg = errorMsg ? errorMsg + "\n" + err : err

        UI.error(err)
      })

      const mode = args.mode ? await Mode.get(args.mode) : await Mode.list().then((x) => x[0])

      const messageID = Identifier.ascending("message")
      const result = await Session.chat({
        sessionID: session.id,
        messageID,
        ...(mode.model
          ? mode.model
          : {
              providerID,
              modelID,
            }),
        mode: mode.name,
        parts: [
          {
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: messageID,
            type: "text",
            text: message,
          },
        ],
      })

      if (printMode) {
        apiEndTime = Date.now()
        const endTime = Date.now()

        const textResult = result.parts.findLast((x) => x.type === "text")?.text || ""
        const assistant = result.metadata.assistant
        const totalCost = assistant?.cost || 0
        const tokens = assistant?.tokens || {
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
        }

        switch (outputFormat) {
          case "text":
            process.stdout.write(textResult + "\n")
            break

          case "json":
            const jsonResult: PrintResult = {
              type: "result",
              subtype: result.metadata.error ? "error" : "success",
              is_error: !!result.metadata.error,
              duration_ms: endTime - startTime,
              duration_api_ms: apiEndTime - apiStartTime,
              num_turns: 1,
              result: textResult,
              session_id: session.id,
              total_cost_usd: totalCost,
              usage: {
                input_tokens: tokens.input,
                cache_creation_input_tokens: tokens.cache.write,
                cache_read_input_tokens: tokens.cache.read,
                output_tokens: tokens.output,
                server_tool_use: {
                  web_search_requests: 0,
                },
                service_tier: "standard",
              },
            }
            process.stdout.write(JSON.stringify(jsonResult) + "\n")
            break

          case "stream-json":
            if (verbose) {
              const assistantMessage: AssistantMessageEvent = {
                type: "assistant",
                message: {
                  id: result.id,
                  type: "message",
                  role: "assistant",
                  model: `${providerID}-${modelID}`,
                  content: [{ type: "text", text: textResult }],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    input_tokens: tokens.input,
                    cache_creation_input_tokens: tokens.cache.write,
                    cache_read_input_tokens: tokens.cache.read,
                    output_tokens: tokens.output,
                    service_tier: "standard",
                  },
                },
                parent_tool_use_id: null,
                session_id: session.id,
              }
              process.stdout.write(JSON.stringify(assistantMessage) + "\n")

              const finalResult: PrintResult = {
                type: "result",
                subtype: result.metadata.error ? "error" : "success",
                is_error: !!result.metadata.error,
                duration_ms: endTime - startTime,
                duration_api_ms: apiEndTime - apiStartTime,
                num_turns: 1,
                result: textResult,
                session_id: session.id,
                total_cost_usd: totalCost,
                usage: {
                  input_tokens: tokens.input,
                  cache_creation_input_tokens: tokens.cache.write,
                  cache_read_input_tokens: tokens.cache.read,
                  output_tokens: tokens.output,
                  server_tool_use: {
                    web_search_requests: 0,
                  },
                  service_tier: "standard",
                },
              }
              process.stdout.write(JSON.stringify(finalResult) + "\n")
            }
            break
        }

        if (result.metadata.error) {
          process.exitCode = 1
        }
      } else {
        if (isPiped) {
          const match = result.parts.findLast((x) => x.type === "text")
          if (match) process.stdout.write(UI.markdown(match.text))
          if (errorMsg) process.stdout.write(errorMsg)
        }
        UI.empty()
      }
    })
  },
})
