import { run } from "@opencode-ai/tui"
import { TuiConfig } from "@opencode-ai/tui/config"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"

export function runTui(transport: { url: string; headers: RequestInit["headers"] }) {
  const config = TuiConfig.resolve({}, { terminalSuspend: false })
  return run({
    ...transport,
    args: {},
    config,
    fetch: gracefulFetch,
    pluginHost: {
      async start() {},
      async dispose() {},
    },
  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}

const legacyDefaults: Record<string, unknown> = {
  "/config/providers": { providers: [], default: {} },
  "/provider": { all: [], default: {}, connected: [] },
  "/agent": [],
  "/config": {},
}

// The TUI still reads these v1 routes, which the v2 daemon does not serve. Empty stubs kept it
// rendering but left onboarding blind to providers the daemon already knows (an env key shows as
// a connection in /api/integration). Answer them from the v2 API in the v1 shapes the TUI
// expects; the empty stub stays as the fallback when an adapter call fails.
const legacyAdapters: Record<
  string,
  (origin: string, directory: string | null, headers?: HeadersInit) => Promise<unknown>
> = {
  "/provider": async (origin, directory, headers) => {
    const { providers, connected } = await v1Providers(origin, directory, headers)
    return { all: providers, default: {}, connected }
  },
  "/config/providers": async (origin, directory, headers) => {
    const { providers } = await v1Providers(origin, directory, headers)
    return { providers, default: {} }
  },
  // v1 agents are keyed by name; v2 agents by id.
  "/agent": async (origin, directory, headers) =>
    ((await v2(origin, "/api/agent", directory, headers)) as any[]).map((agent) => ({
      name: agent.id,
      mode: "primary",
      builtIn: true,
      permission: { edit: "allow", bash: {} },
      tools: {},
      options: {},
    })),
}

async function v1Providers(origin: string, directory: string | null, headers?: HeadersInit) {
  const [providers, models, integrations] = (await Promise.all([
    v2(origin, "/api/provider", directory, headers),
    v2(origin, "/api/model", directory, headers),
    v2(origin, "/api/integration", directory, headers),
  ])) as [any[], any[], any[]]
  const methods = new Map(integrations.map((item) => [item.id, item]))
  const mapped = providers.map((provider) => ({
    id: provider.id,
    name: provider.name ?? provider.id,
    source: "env",
    env:
      (methods.get(provider.id)?.methods ?? [])
        .filter((method: any) => method.type === "env")
        .flatMap((method: any) => method.names ?? []) ?? [],
    options: {},
    models: Object.fromEntries(
      models.filter((m) => m.providerID === provider.id).map((m) => [m.id, v1Model(m)]),
    ),
  }))
  const connected = new Set(integrations.filter((item) => item.connections?.length).map((item) => item.id))
  return {
    providers: mapped,
    connected: mapped.map((p) => p.id).filter((id) => connected.has(id)),
  }
}

function v1Model(m: any) {
  const cost = Array.isArray(m.cost) ? (m.cost[0] ?? {}) : (m.cost ?? {})
  const io = (kinds: unknown) => {
    const list: string[] = Array.isArray(kinds) ? kinds : []
    return {
      text: list.some((k) => k.startsWith("text")),
      audio: list.includes("audio"),
      image: list.includes("image"),
      video: list.includes("video"),
      pdf: list.includes("pdf"),
    }
  }
  return {
    id: m.id,
    providerID: m.providerID,
    api: { id: m.api?.id ?? m.id, url: m.api?.url ?? "", npm: m.api?.package ?? "" },
    name: m.name ?? m.id,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: io(m.capabilities?.input).image,
      toolcall: m.capabilities?.tools ?? true,
      input: io(m.capabilities?.input),
      output: io(m.capabilities?.output),
    },
    cost: {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cache: { read: cost.cache?.read ?? 0, write: cost.cache?.write ?? 0 },
    },
    limit: { context: m.limit?.context ?? 0, output: m.limit?.output ?? 0 },
    status: m.status ?? "active",
    options: {},
    headers: {},
  }
}

async function v2(origin: string, path: string, directory: string | null, headers?: HeadersInit) {
  const url = new URL(origin + path)
  if (directory) url.searchParams.set("location[directory]", directory)
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`${path} responded ${response.status}`)
  const body = (await response.json()) as { data?: unknown }
  return body.data ?? []
}

const gracefulFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init)
    const url = new URL(input instanceof Request ? input.url : input)
    if (response.status !== 404) return response
    const fallback = legacyDefaults[url.pathname]
    if (fallback === undefined) return response
    const adapt = legacyAdapters[url.pathname]
    if (adapt === undefined) return Response.json(fallback)
    // The SDK may carry auth on a Request object rather than in init.
    const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined)
    const directory = url.searchParams.get("directory") ?? url.searchParams.get("workspace")
    return adapt(url.origin, directory, headers).then(
      (body) => Response.json(body),
      () => Response.json(fallback),
    )
  },
  { preconnect: fetch.preconnect },
)
