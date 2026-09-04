import { handle, type Ctx } from '../_greenroom'

// /greenroom/embed with no trailing slash lands here; the handler treats it as "/"
export const onRequest = (ctx: Ctx) => handle(ctx)
