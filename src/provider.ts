import type {
  AgentInfo,
  Message,
  StateAction,
  ToolCallResult,
  ToolDefinition as AhpToolDefinition,
  ToolResultContent,
  UsageInfo,
} from '@microsoft/agent-host-protocol';
import {
  Agent,
  type AgentEvent,
  type AgentOptions,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import {
  getModel,
  type AssistantMessage,
  type KnownProvider,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import type {
  ActiveClientTools,
  AgentProvider,
  AgentSession,
  AgentSessionContext,
  AgentTurnSink,
  ProviderResumeState,
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
  readonly sessionId?: string;
  readonly state: {
    tools: AgentTool[];
  };
  prompt(input: string): Promise<void>;
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
  abort(): void;
  waitForIdle?(): Promise<void>;
}

export interface PiAgentFactoryOptions {
  readonly context: AgentSessionContext | ResumableAgentSessionContext;
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
    context: AgentSessionContext | ResumableAgentSessionContext,
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

  async function createRuntimeSession(context: AgentSessionContext | ResumableAgentSessionContext): Promise<AgentSession> {
    const sessionOptions = await options.createSessionOptions?.(context) ?? {};
    const resumeState = resumeStateFromContext(context);
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
      resumeState,
    });
    const createAgent = options.createAgent ?? defaultPiAgentFactory;
    const piAgent = await createAgent({
      context,
      agentOptions,
      activeClientTools: context.activeClientTools,
    });
    return new PiAhpAgentSession(piAgent, agentOptions.sessionId, agentOptions.initialState?.model, baseTools, activeClientTools, turnState);
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

interface PiAgentResumeState extends ProviderResumeState {
  readonly sessionId?: string;
}

class PiAhpAgentSession implements AgentSession {
  constructor(
    private readonly piAgent: PiAgentLike,
    private readonly configuredSessionId: string | undefined,
    private readonly model: Model<any> | undefined,
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
        this.completeTurn(activeTurn);
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

  getResumeState(): PiAgentResumeState | undefined {
    const sessionId = this.piAgent.sessionId ?? this.configuredSessionId;
    return sessionId ? { sessionId } : undefined;
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
    activeTurn: ActivePiTurn,
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
      activeTurn.usage = usageInfo(event.message, this.model);
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
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      activeTurn.usage = usageInfo(event.message, this.model);
      return;
    }
    if (event.type === 'turn_end' && event.message.role === 'assistant') {
      activeTurn.usage = usageInfo(event.message, this.model);
      return;
    }
    if (event.type === 'agent_end' && !activeTurn.completed) {
      activeTurn.usage ??= latestAssistantUsage(event.messages, this.model);
      this.completeTurn(activeTurn);
    }
  }

  private isActiveClientTool(toolName: string): boolean {
    return Boolean(this.activeClientTools.tools?.some(tool => tool.name === toolName));
  }

  private completeTurn(activeTurn: ActivePiTurn): void {
    activeTurn.sink.emit(usageAction(activeTurn.turnId, activeTurn.usage ?? unavailableUsageInfo(this.model)));
    activeTurn.markdown.complete();
    activeTurn.completed = true;
  }
}

interface ActivePiTurn {
  readonly turnId: string;
  readonly markdown: MarkdownTurnEmitter;
  readonly sink: AgentTurnSink;
  completed: boolean;
  usage?: UsageInfo;
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
  readonly resumeState: PiAgentResumeState;
}

function createAgentOptions(input: CreateAgentOptionsInput): AgentOptions {
  const baseAgentOptions = input.baseOptions.agentOptions ?? {};
  const sessionAgentOptions = input.sessionOptions.agentOptions ?? {};
  return {
    ...baseAgentOptions,
    ...sessionAgentOptions,
    sessionId: input.resumeState.sessionId ?? sessionAgentOptions.sessionId ?? baseAgentOptions.sessionId ?? input.context.sessionUri,
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

function resumeStateFromContext(context: AgentSessionContext | ResumableAgentSessionContext): PiAgentResumeState {
  if (!('resumeState' in context) || !context.resumeState) {
    return {};
  }
  return typeof context.resumeState.sessionId === 'string'
    ? { sessionId: context.resumeState.sessionId }
    : {};
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

function usageAction(turnId: string, usage: UsageInfo): StateAction {
  return {
    type: 'session/usage',
    turnId,
    usage,
  } as StateAction;
}

function latestAssistantUsage(messages: readonly unknown[], model: Model<any> | undefined): UsageInfo | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isAssistantMessage(message)) {
      return usageInfo(message, model);
    }
  }
  return undefined;
}

function usageInfo(message: AssistantMessage, model: Model<any> | undefined): UsageInfo {
  const usage = message.usage;
  const maxContextWindow = finiteNumber(model?.contextWindow);
  const totalTokens = finiteNumber(usage.totalTokens);
  const usageRatio = totalTokens !== undefined && maxContextWindow
    ? totalTokens / maxContextWindow
    : undefined;

  return {
    inputTokens: finiteNumber(usage.input),
    outputTokens: finiteNumber(usage.output),
    model: message.responseModel ?? message.model,
    cacheReadTokens: finiteNumber(usage.cacheRead),
    _meta: {
      wyrdContextUsage: {
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(maxContextWindow !== undefined ? { maxContextWindow } : {}),
        ...(usageRatio !== undefined ? { usageRatio } : {}),
        confidence: 'measured',
        source: 'provider-api',
      },
      piAgentUsage: usage,
    },
  };
}

function unavailableUsageInfo(model: Model<any> | undefined): UsageInfo {
  return {
    ...(model?.id ? { model: model.id } : {}),
    _meta: {
      wyrdContextUsage: {
        ...(finiteNumber(model?.contextWindow) !== undefined ? { maxContextWindow: finiteNumber(model?.contextWindow) } : {}),
        confidence: 'unavailable',
        source: 'unavailable',
        reason: 'Pi Agent Core did not emit assistant message usage for this turn',
      },
    },
  };
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return isRecord(value) && value.role === 'assistant' && isUsage(value.usage);
}

function isUsage(value: unknown): value is Usage {
  return isRecord(value) &&
    typeof value.input === 'number' &&
    typeof value.output === 'number' &&
    typeof value.cacheRead === 'number' &&
    typeof value.totalTokens === 'number';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
