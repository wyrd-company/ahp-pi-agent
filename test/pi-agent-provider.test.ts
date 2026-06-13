import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { Message, StateAction, ToolDefinition } from '@microsoft/agent-host-protocol';
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

import {
  AhpServer,
  FileSystemSessionStore,
  createInMemoryTransportPair,
} from '@wyrd-company/ahp-server';
import {
  createPiAgentProvider,
  type PiAgentLike,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('Pi Agent provider streams Pi Agent Core events as AHP actions', async () => {
  const pi = new FakePiAgent();
  const server = new AhpServer({
    providers: [
      createPiAgentProvider({
        model: fakeModel(),
        createAgent: ({ agentOptions }) => {
          pi.state.tools = agentOptions.initialState?.tools ?? [];
          return pi;
        },
      }),
    ],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'test-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/pi-agent-session';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'pi-agent',
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'turn-1',
    message: userMessage('Hello Pi'),
  } as StateAction);

  await waitFor(() => pi.prompts.length === 1);
  pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Pi ', contentIndex: 0, partial: assistantMessage() }, message: assistantMessage() } as AgentEvent);
  pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'says hi', contentIndex: 0, partial: assistantMessage() }, message: assistantMessage() } as AgentEvent);
  pi.emit({ type: 'agent_end', messages: [assistantMessage()] } as AgentEvent);
  pi.releasePrompt();

  const actions = await collectUntilTerminal(subscription);
  assert.deepEqual(pi.prompts, ['Hello Pi']);
  assert.equal(actions.some(action => action.type === 'session/responsePart'), true);
  assert.equal(
    actions
      .filter((action): action is StateAction & { content: string } => action.type === 'session/delta')
      .map(action => action.content)
      .join(''),
    'Pi says hi',
  );
  assert.equal(actions.at(-1)?.type, 'session/turnComplete');

  await client.request('disposeSession', { channel: sessionUri });
  await client.shutdown();
});

test('Pi Agent provider maps Pi Agent tool events to AHP server-side tool lifecycle', async () => {
  const pi = new FakePiAgent();
  const server = new AhpServer({
    providers: [
      createPiAgentProvider({
        model: fakeModel(),
        tools: [baseTool('read')],
        createAgent: ({ agentOptions }) => {
          pi.state.tools = agentOptions.initialState?.tools ?? [];
          return pi;
        },
      }),
    ],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'test-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/pi-agent-tools';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'pi-agent',
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'turn-tools',
    message: userMessage('Read the file'),
  } as StateAction);

  await waitFor(() => pi.prompts.length === 1);
  pi.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } } as AgentEvent);
  pi.emit({ type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' }, partialResult: { content: [{ type: 'text', text: 'partial' }] } } as AgentEvent);
  pi.emit({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: [{ type: 'text', text: 'contents' }] }, isError: false } as AgentEvent);
  pi.emit({ type: 'agent_end', messages: [assistantMessage()] } as AgentEvent);
  pi.releasePrompt();

  const actions = await collectUntilTerminal(subscription);
  const toolStart = actions.find(action => action.type === 'session/toolCallStart');
  assert.ok(toolStart);
  assert.equal(toolStart.toolCallId, 'tool-1');
  assert.equal(toolStart.toolName, 'read');
  assert.equal(toolStart.contributor, undefined);

  const toolReady = actions.find(action => action.type === 'session/toolCallReady');
  assert.ok(toolReady);
  assert.equal(toolReady.toolInput, JSON.stringify({ path: 'README.md' }));

  const toolComplete = actions.find(action => action.type === 'session/toolCallComplete');
  assert.ok(toolComplete);
  assert.equal(toolComplete.result.success, true);
  assert.deepEqual(toolComplete.result.content, [{ type: 'text', text: 'contents' }]);

  await client.request('disposeSession', { channel: sessionUri });
  await client.shutdown();
});

test('Pi Agent provider exposes active-client tools through Pi Agent state', async () => {
  const pi = new FakePiAgent();
  const server = new AhpServer({
    providers: [
      createPiAgentProvider({
        model: fakeModel(),
        tools: [baseTool('base')],
        createAgent: ({ agentOptions }) => {
          pi.state.tools = agentOptions.initialState?.tools ?? [];
          return pi;
        },
      }),
    ],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'owner-client', protocolVersions: ['0.3.0'] });

  const tool = toolDefinition('searchWorkspace', 'Search Workspace');
  const sessionUri = 'ahp-session:/pi-active-client-tools';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'pi-agent',
    activeClient: {
      clientId: 'owner-client',
      displayName: 'Owner Client',
      tools: [tool],
    },
  });

  assert.deepEqual(pi.state.tools.map(candidate => candidate.name), ['base', 'searchWorkspace']);

  client.dispatch(sessionUri, {
    type: 'session/activeClientChanged',
    activeClient: null,
  } as StateAction);
  await waitFor(() => pi.state.tools.map(candidate => candidate.name).join(',') === 'base');

  await client.request('disposeSession', { channel: sessionUri });
  await client.shutdown();
});

test('Pi Agent provider resumes a persisted AHP session with the same Pi session id', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-pi-agent-resume-'));
  const firstPi = new FakePiAgent();
  const secondPi = new FakePiAgent();
  const sessionUri = 'ahp-session:/pi-agent-resume';
  let resumedSessionId: string | undefined;

  try {
    const firstServer = new AhpServer({
      providers: [
        createPiAgentProvider({
          model: fakeModel(),
          createAgent: ({ agentOptions }) => {
            firstPi.state.tools = agentOptions.initialState?.tools ?? [];
            return firstPi;
          },
        }),
      ],
      store: new FileSystemSessionStore({ directory }),
    });
    const firstClient = createClient(firstServer);
    firstClient.connect();
    await firstClient.initialize({ clientId: 'pi-client', protocolVersions: ['0.3.0'] });
    await firstClient.request('createSession', {
      channel: sessionUri,
      provider: 'pi-agent',
    });
    await firstClient.shutdown();

    const secondServer = new AhpServer({
      providers: [
        createPiAgentProvider({
          model: fakeModel(),
          createAgent: ({ agentOptions }) => {
            resumedSessionId = agentOptions.sessionId;
            secondPi.state.tools = agentOptions.initialState?.tools ?? [];
            return secondPi;
          },
        }),
      ],
      store: new FileSystemSessionStore({ directory }),
    });
    const secondClient = createClient(secondServer);
    secondClient.connect();

    const reconnect = await secondClient.reconnect({
      clientId: 'pi-client',
      lastSeenServerSeq: 0,
      subscriptions: [sessionUri],
    });
    assert.equal(reconnect.type, 'snapshot');
    assert.equal(resumedSessionId, sessionUri);

    const subscription = secondClient.attachSubscription(sessionUri);
    secondClient.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'resume-turn',
      message: userMessage('Continue after reconnect'),
    } as StateAction);

    await waitFor(() => secondPi.prompts.length === 1);
    secondPi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Resumed Pi', contentIndex: 0, partial: assistantMessage() }, message: assistantMessage() } as AgentEvent);
    secondPi.emit({ type: 'agent_end', messages: [assistantMessage()] } as AgentEvent);
    secondPi.releasePrompt();

    const actions = await collectUntilTerminal(subscription);
    assert.deepEqual(secondPi.prompts, ['Continue after reconnect']);
    assert.equal(actions.at(-1)?.type, 'session/turnComplete');

    await secondClient.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakePiAgent implements PiAgentLike {
  readonly prompts: string[] = [];
  readonly state: { tools: AgentTool[] } = { tools: [] };
  private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
  private release: (() => void) | undefined;
  private readonly abortController = new AbortController();

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    await new Promise<void>(resolve => {
      this.release = resolve;
    });
  }

  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      void listener(event, this.abortController.signal);
    }
  }

  releasePrompt(): void {
    this.release?.();
    this.release = undefined;
  }

  abort(): void {
    this.abortController.abort();
    this.releasePrompt();
  }
}

function createClient(server: AhpServer): AhpClient {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));
  return new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
}

async function collectUntilTerminal(subscription: AsyncIterator<unknown>): Promise<StateAction[]> {
  const actions: StateAction[] = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      subscription.next(),
      new Promise<IteratorResult<never>>(resolve => setTimeout(
        () => resolve({ done: true, value: undefined as never }),
        100,
      )),
    ]);
    const value = next.value as { type?: string; params?: { action?: StateAction } };
    if (next.done || value.type !== 'action' || !value.params?.action) {
      continue;
    }
    actions.push(value.params.action);
    const type = value.params.action.type;
    if (type === 'session/turnComplete' || type === 'session/error') {
      break;
    }
  }
  return actions;
}

function assistantMessage(): never {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    provider: 'fake',
    model: 'fake',
    api: 'fake',
    stopReason: 'stop',
    usage: {},
    timestamp: Date.now(),
  } as never;
}

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}

function toolDefinition(name: string, title: string): ToolDefinition {
  return {
    name,
    title,
    description: `${title} test tool`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  };
}

function baseTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} base tool`,
    parameters: { type: 'object' } as never,
    async execute() {
      return {
        content: [{ type: 'text', text: `${name} executed` }],
        details: undefined,
      };
    },
  };
}

function fakeModel(): Model<any> {
  return {
    id: 'fake-model',
    name: 'Fake Model',
    api: 'opencode-go',
    provider: 'opencode-go',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}
