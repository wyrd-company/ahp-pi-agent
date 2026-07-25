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

## Releasing

[Intentional](https://github.com/wyrd-company/intentional) is the version and
release-intent authority for this repository. `.intentional/config.yml` defines
the single `ahp-pi-agent` release unit, `package.json` is a projection of that state,
and Git tags are the released-version record. Do not hand-edit the version in
`package.json`.

Continuous integration runs `intentional check` on every pull request and on
`main`. It validates only; it never releases.

### Record a change

Author an intent alongside the implementation it describes:

```bash
intentional add --release-unit ahp-pi-agent:minor --message "Add a user-visible capability."
```

Use `major`, `minor`, or `patch` for the compatibility impact of the change.
While the package is below `1.0.0`, the configured `compatibility` mapping
shifts each bump down one position: a `major` intent moves the minor number and
both `minor` and `patch` intents move the patch number. Commit the generated
file in `.intentional/intents/` with the code change.

### Cut a release

Releasing is a deliberate, human-authorized action. Nothing below happens
automatically.

```bash
intentional status
intentional check
intentional plan > release-plan.json
intentional apply --dry-run
intentional apply

git add -A
git commit -m "chore: release"
```

`apply` writes the new version into `package.json`, updates `CHANGELOG.md`, and
consumes the included intents.

`main` accepts changes only through a pull request, so open one for the release
commit and merge it. Then tag the merged commit on `main`:

```bash
git switch main && git pull
intentional tag --plan release-plan.json
```

`tag` creates the annotated release record using the plain `N.N.N` tag name that
the CD workflow expects. Pushing that tag starts publication and is the point of
no return:

```bash
git push origin <version>
```

`.github/workflows/cd.yml` reacts to the tag: it verifies the tag matches
`package.json`, builds, publishes to npmjs and GitHub Packages, and creates the
GitHub release. Delete `release-plan.json` once the release is tagged; it is
working material, not repository state.
