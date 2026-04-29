import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './system_prompt';
import { tools, executeTool } from './tools';
import type { Env } from './index';

const MAX_TOOL_ITERATIONS = 10;

export async function handleChat(request: Request, env: Env): Promise<Response> {
  let body: { messages: Anthropic.MessageParam[] };
  try {
    body = await request.json();
  } catch {
    return response({ error: 'Invalid JSON body' }, 400);
  }

  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return response({ error: 'messages array is required' }, 400);
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const conversation: Anthropic.MessageParam[] = [...messages];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages: conversation,
    });

    conversation.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason === 'end_turn') {
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');
      return response({ response: text, messages: conversation });
    }

    if (msg.stop_reason !== 'tool_use') break;

    const toolUseBlocks = msg.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async block => {
        console.log(`Tool call: ${block.name}`, block.input);
        const result = await executeTool(block.name, block.input as Record<string, string>, env);
        return {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      }),
    );

    conversation.push({ role: 'user', content: toolResults });
  }

  return response({ error: 'Max tool iterations reached without a final answer' }, 500);
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
