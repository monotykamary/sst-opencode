const OSC9_DEFAULT_MAX_LENGTH = 200

export type Osc9NotificationOptions = {
  fallback?: string
  maxLength?: number
  prefix?: string
}

function normalizeNotificationText(input: string, maxLength: number) {
  const sanitized = input.replace(/[\x07\x1b\x9c]/g, "")
  const collapsed = sanitized.replace(/\s+/g, " ").trim()
  if (!collapsed) return ""

  const limit = Math.max(1, maxLength)
  if (collapsed.length <= limit) return collapsed
  if (limit <= 3) return collapsed.slice(0, limit)
  return collapsed.slice(0, limit - 3) + "..."
}

function wrapForTmux(sequence: string) {
  if (!process.env["TMUX"]) return sequence
  return `\x1bPtmux;\x1b${sequence}\x1b\\`
}

export function buildOsc9Notification(input: string, options?: Osc9NotificationOptions) {
  const maxLength = options?.maxLength ?? OSC9_DEFAULT_MAX_LENGTH
  let message = normalizeNotificationText(input, maxLength)
  if (!message && options?.fallback) {
    message = normalizeNotificationText(options.fallback, maxLength)
  }
  if (!message) return undefined
  if (options?.prefix) {
    message = `${options.prefix} ${message}`
  }
  return wrapForTmux(`\x1b]9;${message}\x07`)
}
