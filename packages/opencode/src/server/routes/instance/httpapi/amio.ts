import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { ConfigRuntime } from "@/config/runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Installation } from "@/installation"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Project } from "@/project/project"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Workspace } from "@/control-plane/workspace"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import type { CorsOptions } from "@opencode-ai/server/cors"
import { Context, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { SharedInstanceHttpApi, SharedRootHttpApi } from "./shared-api"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { experimentalHandlers } from "./handlers/experimental"
import { globalHandlers } from "./handlers/global"
import { mcpHandlers } from "./handlers/mcp"
import { permissionHandlers } from "./handlers/permission"
import { questionHandlers } from "./handlers/question"
import { sessionHandlers } from "./handlers/session"
import { authorizationLayer } from "./middleware/authorization"
import { createInstanceContextLayer } from "./middleware/instance-context"
import { withHttpRuntime } from "./middleware/runtime"
import { schemaErrorLayer } from "./middleware/schema-error"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { ServerAuth } from "@/server/auth"

export const context = Context.makeUnsafe<unknown>(new Map())

const auth = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const workspace = workspaceRoutingLayer.pipe(Layer.provide(layerWebSocketConstructorGlobal))

const rootRoutes = HttpApiBuilder.layer(SharedRootHttpApi).pipe(
  Layer.provide([controlHandlers, globalHandlers]),
  Layer.provide([auth, schemaErrorLayer]),
)

const instanceRoutes = HttpApiBuilder.layer(SharedInstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    experimentalHandlers,
    mcpHandlers,
    permissionHandlers,
    questionHandlers,
    sessionHandlers,
  ]),
  Layer.provide([
    auth,
    workspace,
    createInstanceContextLayer({ skipUnloadedSessionStatusBootstrap: true }),
    schemaErrorLayer,
  ]),
)

const app = LayerNode.group([
  Database.node,
  Account.node,
  Agent.node,
  Auth.node,
  BackgroundJob.node,
  Config.node,
  ConfigRuntime.node,
  EventV2Bridge.node,
  Installation.node,
  InstanceStore.node,
  MCP.node,
  Permission.node,
  Project.node,
  Provider.node,
  Question.node,
  RuntimeFlags.node,
  Session.node,
  SessionProjector.node,
  SessionCompaction.node,
  SessionPrompt.node,
  SessionRevert.node,
  SessionRunState.node,
  SessionShare.node,
  SessionStatus.node,
  SessionSummary.node,
  Todo.node,
  ToolRegistry.node,
  Workspace.node,
  Worktree.node,
  httpClient,
])

export function createRoutes(options?: CorsOptions) {
  return withHttpRuntime(Layer.mergeAll(rootRoutes, instanceRoutes), options).pipe(
    Layer.provide(LayerNode.compile(app)),
  )
}

export * as AmioHttpApiApp from "./amio"
