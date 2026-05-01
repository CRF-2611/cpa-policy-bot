import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './system_prompt';
import { tools, executeTool, makeSupabaseClient } from './tools';
import type { Env } from './index';

const MAX_TOOL_ITERATIONS = 10;

export async function handleChat(request: Request, env: Env): Promise<Response> {
  let body: { session_id?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { session_id, message } = body;
  if (!session_id?.trim()) return jsonError('session_id is required', 400);
  if (!message?.trim()) return jsonError('message is required', 400);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const emit = (event: string, data: unknown): void => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    writer.write(encoder.encode(chunk));
  };

  runChat(session_id, message, env, emit).finally(() => writer.close());

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

async function runChat(
  sessionId: string,
  userMessage: string,
  env: Env,
  emit: (event: string, data: unknown) => void,
): Promise<void> {
  const supabase = makeSupabaseClient(env);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  try {
    // Load the last 20 turns of conversation history
    const { data: rows, error: loadError } = await supabase
      .from('conversations')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(20);

    if (loadError) throw new Error(`Failed to load history: ${loadError.message}`);

    const conversation: Anthropic.MessageParam[] = (rows ?? []).map(r => ({
      role: r.role as 'user' | 'assistant',
      content: r.content as string,
    }));

    conversation.push({ role: 'user', content: userMessage });

    await supabase
      .from('conversations')
      .insert({ session_id: sessionId, role: 'user', content: userMessage });

    let accumulatedText = '';

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      emit('status', { state: i === 0 ? 'thinking' : 'searching' });

      const stream = client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        // Cache the system prompt — it's 3000+ tokens and identical across every call.
        // After the first request the cached version is reused, cutting input costs ~90%.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools,
        messages: conversation,
      });

      const textParts: string[] = [];
      const toolUseBlocks: Anthropic.ToolUseBlock[] = [];
      let pendingTool: { id: string; name: string; json: string } | null = null;
      let stopReason: string | undefined;

      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              pendingTool = {
                id: event.content_block.id,
                name: event.content_block.name,
                json: '',
              };
            }
            break;

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              emit('delta', { text: event.delta.text });
              textParts.push(event.delta.text);
            } else if (event.delta.type === 'input_json_delta' && pendingTool) {
              pendingTool.json += event.delta.partial_json;
            }
            break;

          case 'content_block_stop':
            if (pendingTool) {
              toolUseBlocks.push({
                type: 'tool_use',
                id: pendingTool.id,
                name: pendingTool.name,
                input: JSON.parse(pendingTool.json || '{}') as Record<string, unknown>,
              });
              pendingTool = null;
            }
            break;

          case 'message_delta':
            stopReason = event.delta.stop_reason ?? undefined;
            break;
        }
      }

      const blockText = textParts.join('');
      if (blockText) accumulatedText += blockText;

      // Append the assistant turn (text + any tool calls) to the working conversation
      const assistantContent: Anthropic.ContentBlock[] = [];
      if (blockText) assistantContent.push({ type: 'text', text: blockText } as Anthropic.ContentBlock);
      for (const tb of toolUseBlocks) assistantContent.push(tb);
      if (assistantContent.length > 0) conversation.push({ role: 'assistant', content: assistantContent });

      if (stopReason === 'end_turn' || toolUseBlocks.length === 0) break;

      // Execute tool calls and feed results back
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async block => {
          console.log(`Tool: ${block.name}`, block.input);
          const result = await executeTool(
            block.name,
            block.input as Record<string, unknown>,
            supabase,
          );
          return {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: JSON.stringify(result),
          };
        }),
      );

      if (toolResults.length > 0) conversation.push({ role: 'user', content: toolResults });
    }

    if (accumulatedText) {
      await supabase.from('conversations').insert({
        session_id: sessionId,
        role: 'assistant',
        content: accumulatedText,
      });
    }

    emit('done', { session_id: sessionId, response: accumulatedText });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('Chat error:', msg);
    emit('error', { error: msg });
  }
}

function jsonError(msg: string, status: number): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
