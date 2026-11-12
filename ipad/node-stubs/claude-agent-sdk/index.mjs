// Stands in for @anthropic-ai/claude-agent-sdk inside the iPad app (ipad/ci/make-node-project.sh
// puts it in the app's node_modules).
//
// The real package runs the Claude Code CLI, which an iPad cannot do, and its files do not even
// load on nodejs-mobile: that Node is built without ICU, so a regular expression with a Unicode
// property (\p{...}) is a syntax error. server/embedded.js sets ai.backend to "api", so nothing
// here is called; server/ai/agent-sdk-backend.js only needs the names to exist.
const unavailable = () => {
  throw new Error('The Claude Code login is not available when Lumen runs on an iPad');
};

export class AbortError extends Error {}
export const USAGE_LIMIT_ERROR_PREFIXES = [];
export const createSdkMcpServer = unavailable;
export const query = unavailable;
export const tool = unavailable;
