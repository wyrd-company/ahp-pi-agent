# AHP Pi Agent Provider

TypeScript provider adapter that lets an AHP server run Pi Agent Core.

Package target: `@wyrd-company/ahp-pi-agent`.

This package uses `@earendil-works/pi-agent-core`. It does not include the Pi
Coding Agent tools or session layer; use `@wyrd-company/ahp-pi-coding-agent`
for that package.

## Behavior

- Creates one Pi Agent Core `Agent` per AHP session.
- Sends each AHP user turn through `Agent.prompt(...)`.
- Maps Pi assistant text deltas to AHP markdown response parts and deltas.
- Maps Pi `agent_end` to `session/turnComplete`.
- Maps Pi Agent tool execution events to AHP server-side tool call lifecycle actions.
- Aborts the Pi Agent run when AHP cancels or disposes the session.

## Active-Client Tools

The provider maps AHP active-client tools into Pi Agent `AgentTool` definitions.

- Pi executes those tools through its normal tool runtime.
- The tool implementation routes execution through `ActiveClientToolRouter.reportInvocation(...)`.
- AHP owns session URI, turn id, tool call id, tool name, and active-client identity.
- Only the owning active client can complete the tool through normal AHP `session/toolCallComplete`.
- Unlike the Pi Coding Agent SDK adapter, Pi Agent Core tools are updated on `Agent.state.tools`, so active-client tool changes can be reflected after session creation.

## Session Resume

The provider implements `ResumableAgentProvider`. When `ahp-server` reloads a
persisted AHP session, the adapter recreates the Pi Agent Core `Agent` using the
stored AHP working directory, model/config context, active-client tools, and the
provider-owned Pi `sessionId` previously returned by `AgentSession.getResumeState()`.
For new sessions, the adapter seeds Pi `sessionId` from the AHP session URI unless
you provide an explicit `AgentOptions.sessionId`.

Any deeper memory or transcript continuity comes from the Pi Agent configuration
you provide, such as durable model/session state in `AgentOptions`.

## Usage

```ts
import { AhpServer } from '@wyrd-company/ahp-server';
import { createPiAgentProvider } from '@wyrd-company/ahp-pi-agent';

const server = new AhpServer({
  providers: [
    createPiAgentProvider({
      modelProvider: 'opencode-go',
      modelId: process.env.PI_AGENT_MODEL ?? 'deepseek-v4-flash',
      systemPrompt: 'You are the orchestrator agent.',
      tools: [mySpecializedTool],
    }),
  ],
});
```

You can pass a fully configured Pi model or low-level `AgentOptions` when you
need direct Pi Agent control:

```ts
createPiAgentProvider({
  model: myPiModel,
  agentOptions: {
    toolExecution: 'sequential',
  },
});
```

## Development

```bash
npm install
npm run verify
```
