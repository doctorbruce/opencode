import { HttpApi } from "effect/unstable/httpapi"
import { ConfigApi } from "./groups/config"
import { ControlApi } from "./groups/control"
import { ExperimentalApi } from "./groups/experimental"
import { GlobalApi } from "./groups/global"
import { McpApi } from "./groups/mcp"
import { PermissionApi } from "./groups/permission"
import { QuestionApi } from "./groups/question"
import { SessionApi } from "./groups/session"
import { Authorization } from "./middleware/authorization"
import { SchemaErrorMiddleware } from "./middleware/schema-error"

export const SharedRootHttpApi = HttpApi.make("opencode-root")
  .addHttpApi(ControlApi)
  .addHttpApi(GlobalApi)
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)

export const SharedInstanceHttpApi = HttpApi.make("opencode-instance")
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(McpApi)
  .addHttpApi(PermissionApi)
  .addHttpApi(QuestionApi)
  .addHttpApi(SessionApi)
  .middleware(SchemaErrorMiddleware)
