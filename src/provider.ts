import type {
  AgentInfo,
  Message,
  StateAction,
  ToolCallResult,
  ToolDefinition as AhpToolDefinition,
  ToolResultContent,
} from '@microsoft/agent-host-protocol';
import {
  Agent,
  type AgentEvent,
  type AgentOptions,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import {
  getModel,
  type KnownProvider,
  type Model,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import type {
  ActiveClientTools,
  AgentProvider,
  AgentSession,
  AgentSessionContext,
  AgentTurnSink,
  ResumableAgentProvider,
  ResumableAgentSessionContext,
} from '@wyrd-company/ahp-provider-kit';
import {
  ActiveClientToolRouter,
  MarkdownTurnEmitter,
  singleModelAgentInfo,
  stringOrMarkdown,
} from '@wyrd-company/ahp-provider-kit';

export interface PiAgentLike {
  readonly state: {
    tools: AgentTool[];
  };
  prompt(input: string): Promise<void>;
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
  abort(): void;
  waitForIdle?(): Promise<void>;
}

export interface PiAgentFactoryOptions {
  readonly context: AgentSessionContext;
  readonly agentOptions: AgentOptions;
  readonly activeClientTools?: ActiveClientTools;
}

export type PiAgentFactory = (options: PiAgentFactoryOptions) => PiAgentLike | Promise<PiAgentLike>;

export interface PiAgentCreateSessionOptions {
  readonly model?: Model<any>;
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly systemPrompt?: string;
  readonly tools?: readonly AgentTool[];
  readonly agentOptions?: AgentOptions;
}

export interface PiAgentProviderOptions extends PiAgentCreateSessionOptions {
  readonly providerId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly createAgent?: PiAgentFactory;
  readonly createSessionOptions?: (
    context: AgentSessionContext,
  ) => PiAgentCreateSessionOptions | Promise<PiAgentCreateSessionOptions>;
}

export function createPiAgentProvider(options: PiAgentProviderOptions = {}): ResumableAgentProvider {
  const providerId = options.providerId ?? 'pi-agent';
  const modelProvider = options.modelProvider ?? process.env.PI_AGENT_PROVIDER ?? 'opencode-go';
  const modelId = options.modelId ?? process.env.PI_AGENT_MODEL ?? 'deepseek-v4-flash';
  const agent: AgentInfo = singleModelAgentInfo({
    providerId,
    displayName: options.displayName ?? 'Pi Agent',
    description: options.description ?? 'Pi Agent Core adapter',
    defaultModel: modelId,
  });

  async function createRuntimeSession(context: AgentSessionContext): Promise<AgentSession> {
    const sessionOptions = await options.createSessionOptions?.(context) ?? {};
    const activeClientTools = new ActiveClientToolRouter({
      activeClientTools: context.activeClientTools,
      sink: context.activeClientToolSink,
    });
    const turnState: PiAgentTurnState = {};
    const baseTools = [
      ...(options.tools ?? []),
      ...(sessionOptions.tools ?? []),
    ];
    const agentOptions = createAgentOptions({
      baseOptions: options,
      sessionOptions,
      context,
      baseTools,
      activeClientTools,
      turnState,
      modelProvider,
      modelId,
    });
    const createAgent = options.createAgent ?? defaultPiAgentFactory;
    const piAgent = await createAgent({
      context,
      agentOptions,
      activeClientTools: context.activeClientTools,
    });
    return new PiAhpAgentSession(piAgent, baseTools, activeClientTools, turnState);
  }

  return {
    agent,
    createSession(context: AgentSessionContext): Promise<AgentSession> {
      return createRuntimeSession(context);
    },
    resumeSession(context: ResumableAgentSessionContext): Promise<AgentSession> {
      return createRuntimeSession(context);
    },
  };
}

class PiAhpAgentSession implements AgentSession {
  constructor(
    private readonly piAgent: PiAgentLike,
    private readonly baseTools: readonly AgentTool[],
    private readonly activeClientTools: ActiveClientToolRouter,
    private readonly turnState: PiAgentTurnState,
  ) {}

  async sendUserMessage(message: Message, sink: AgentTurnSink, signal: AbortSignal, turnId?: string): Promise<void> {
    const ahpTurnId = turnId ?? `turn-${Date.now()}`;
    const activeTurn = {
      turnId: ahpTurnId,
      markdown: new MarkdownTurnEmitter(sink, ahpTurnId),
      sink,
      completed: false,
    };
    const unsubscribe = this.piAgent.subscribe(event => {
      this.handlePiEvent(event, activeTurn);
    });
    const abort = (): void => {
      this.piAgent.abort();
    };
    signal.addEventListener('abort', abort, { once: true });

    try {
      this.turnState.turnId = ahpTurnId;
      await this.piAgent.prompt(message.text);
      if (!activeTurn.completed && !signal.aborted) {
        activeTurn.markdown.complete();
        activeTurn.completed = true;
      }
    } catch (error) {
      sink.emit({
        type: 'session/error',
        turnId: ahpTurnId,
        error: {
          errorType: 'pi-agent.error',
          message: error instanceof Error ? error.message : String(error),
        },
      } as StateAction);
    } finally {
      signal.removeEventListener('abort', abort);
      unsubscribe();
      if (this.turnState.turnId === ahpTurnId) {
        this.turnState.turnId = undefined;
      }
    }
  }

  setActiveClientTools(activeClientTools: ActiveClientTools | undefined): void {
    this.activeClientTools.setActiveClientTools(activeClientTools);
    this.piAgent.state.tools = [
      ...this.baseTools,
      ...toPiActiveClientTools(activeClientTools?.tools ?? [], this.activeClientTools, this.turnState),
    ];
  }

  async cancel(): Promise<void> {
    this.piAgent.abort();
    await this.piAgent.waitForIdle?.();
  }

  async dispose(): Promise<void> {
    this.piAgent.abort();
    await this.piAgent.waitForIdle?.();
  }

  private handlePiEvent(
    event: AgentEvent,
    activeTurn: { turnId: string; markdown: MarkdownTurnEmitter; sink: AgentTurnSink; completed: boolean },
  ): void {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      activeTurn.markdown.emitDelta(event.assistantMessageEvent.delta);
      return;
    }
    if (event.type === 'tool_execution_start') {
      if (this.isActiveClientTool(event.toolName)) {
        return;
      }
      activeTurn.sink.emit({
        type: 'session/toolCallStart',
        turnId: activeTurn.turnId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        displayName: event.toolName,
      } as StateAction);
      activeTurn.sink.emit({
        type: 'session/toolCallReady',
        turnId: activeTurn.turnId,
        toolCallId: event.toolCallId,
        invocationMessage: event.toolName,
        toolInput: JSON.stringify(event.args ?? {}),
        confirmed: 'not-needed',
      } as StateAction);
      return;
    }
    if (event.type === 'tool_execution_update') {
      if (this.isActiveClientTool(event.toolName)) {
        return;
      }
      activeTurn.sink.emit({
        type: 'session/toolCallDelta',
        turnId: activeTurn.turnId,
        toolCallId: event.toolCallId,
        content: stringifyUnknown(event.partialResult),
      } as StateAction);
      return;
    }
    if (event.type === 'tool_execution_end') {
      if (this.isActiveClientTool(event.toolName)) {
        return;
      }
      activeTurn.sink.emit({
        type: 'session/toolCallComplete',
        turnId: activeTurn.turnId,
        toolCallId: event.toolCallId,
        result: piToolResultToAhpResult(event.toolName, event.result, event.isError),
      } as StateAction);
      return;
    }
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') {
      activeTurn.sink.emit({
        type: 'session/error',
        turnId: activeTurn.turnId,
        error: {
          errorType: 'pi-agent.error',
          message: event.message.errorMessage ?? 'Pi Agent assistant turn failed',
        },
      } as StateAction);
      activeTurn.completed = true;
      return;
    }
    if (event.type === 'agent_end' && !activeTurn.completed) {
      activeTurn.markdown.complete();
      activeTurn.completed = true;
    }
  }

  private isActiveClientTool(toolName: string): boolean {
    return Boolean(this.activeClientTools.tools?.some(tool => tool.name === toolName));
  }
}

interface CreateAgentOptionsInput {
  readonly baseOptions: PiAgentCreateSessionOptions;
  readonly sessionOptions: PiAgentCreateSessionOptions;
  readonly context: AgentSessionContext;
  readonly baseTools: readonly AgentTool[];
  readonly activeClientTools: ActiveClientToolRouter;
  readonly turnState: PiAgentTurnState;
  readonly modelProvider: string;
  readonly modelId: string;
}

function createAgentOptions(input: CreateAgentOptionsInput): AgentOptions {
  const baseAgentOptions = input.baseOptions.agentOptions ?? {};
  const sessionAgentOptions = input.sessionOptions.agentOptions ?? {};
  return {
    ...baseAgentOptions,
    ...sessionAgentOptions,
    sessionId: sessionAgentOptions.sessionId ?? baseAgentOptions.sessionId ?? input.context.sessionUri,
    initialState: {
      ...baseAgentOptions.initialState,
      ...sessionAgentOptions.initialState,
      model: input.sessionOptions.model ?? input.baseOptions.model ?? resolveModel(
        input.sessionOptions.modelProvider ?? input.baseOptions.modelProvider ?? input.modelProvider,
        input.sessionOptions.modelId ?? input.baseOptions.modelId ?? input.modelId,
      ),
      systemPrompt: input.sessionOptions.systemPrompt ??
        input.baseOptions.systemPrompt ??
        sessionAgentOptions.initialState?.systemPrompt ??
        baseAgentOptions.initialState?.systemPrompt ??
        '',
      tools: [
        ...input.baseTools,
        ...toPiActiveClientTools(input.context.activeClientTools?.tools ?? [], input.activeClientTools, input.turnState),
      ],
    },
  };
}

function toPiActiveClientTools(
  tools: readonly AhpToolDefinition[],
  activeClientTools: ActiveClientToolRouter,
  turnState: PiAgentTurnState,
): AgentTool[] {
  return tools.map(tool => ({
    name: tool.name,
    label: tool.title ?? tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema ?? { type: 'object' }),
    execute: async (toolCallId, params) => {
      const result = await activeClientTools.reportInvocation({
        turnId: turnState.turnId ?? 'turn-unknown',
        toolCallId,
        toolName: tool.name,
        toolInput: JSON.stringify(params ?? {}),
      });
      if (!result.success) {
        throw new Error(result.error?.message ?? stringOrMarkdown(result.pastTenseMessage));
      }
      return {
        content: ahpToolResultToPiContent(result),
        details: result,
      };
    },
  }));
}

interface PiAgentTurnState {
  turnId?: string;
}

function ahpToolResultToPiContent(result: ToolCallResult): Array<{ type: 'text'; text: string }> {
  if (result.content?.length) {
    return result.content.map(content => ({ type: 'text' as const, text: ahpToolContentToText(content) }));
  }
  if (result.structuredContent) {
    return [{ type: 'text', text: JSON.stringify(result.structuredContent) }];
  }
  if (result.error?.message) {
    return [{ type: 'text', text: result.error.message }];
  }
  return [{ type: 'text', text: stringOrMarkdown(result.pastTenseMessage) }];
}

function ahpToolContentToText(content: ToolResultContent): string {
  if (content.type === 'text') {
    return content.text;
  }
  return JSON.stringify(content);
}

function piToolResultToAhpResult(toolName: string, result: unknown, isError: boolean): ToolCallResult {
  const content = piToolResultContent(result);
  return {
    success: !isError,
    pastTenseMessage: isError ? `${toolName} failed` : `${toolName} completed`,
    ...(content ? { content: [{ type: 'text', text: content } as ToolResultContent] } : {}),
    ...(isError ? { error: { message: content || `${toolName} failed` } } : {}),
  };
}

function piToolResultContent(result: unknown): string | undefined {
  if (isRecord(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      const text = content.map(piContentPartToText).filter(Boolean).join('\n');
      return text || undefined;
    }
    if (typeof result.message === 'string') {
      return result.message;
    }
  }
  return result === undefined ? undefined : stringifyUnknown(result);
}

function piContentPartToText(content: unknown): string {
  if (isRecord(content) && content.type === 'text' && typeof content.text === 'string') {
    return content.text;
  }
  return stringifyUnknown(content);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function resolveModel(provider: string, modelId: string): Model<any> {
  const model = getModel(provider as KnownProvider, modelId as never) as Model<any> | undefined;
  if (!model) {
    throw new Error(`Pi model not found: ${provider}/${modelId}`);
  }
  return model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function defaultPiAgentFactory(options: PiAgentFactoryOptions): PiAgentLike {
  return new Agent(options.agentOptions);
}
