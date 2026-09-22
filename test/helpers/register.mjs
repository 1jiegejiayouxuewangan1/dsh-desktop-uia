// Test bootstrap: make `@deepseek-ai/dsh-tools` resolve to a local stand-in.
//
// The real package only exists inside a DSH installation, so the suites load a
// stub that mirrors the parts this plugin uses (`defineTool`) while validating
// the tool definitions as strictly as the framework does.
import { register } from 'node:module'

register(new URL('./dsh-tools-resolver.mjs', import.meta.url))
