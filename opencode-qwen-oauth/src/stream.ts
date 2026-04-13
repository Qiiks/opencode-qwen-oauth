export interface ChatCompletionChunk {
  id: string;
  choices: Array<{
    delta?: {
      content?: string;
    };
    finish_reason?: string | null;
  }>;
}

export interface ResponseEvent {
  type: string;
  payload: Record<string, unknown>;
}

export function convertChunkToResponseEvents(chunk: ChatCompletionChunk): ResponseEvent[] {
  const events: ResponseEvent[] = [];
  events.push({
    type: "response.output_item.added",
    payload: {
      id: chunk.id
    }
  });

  const delta = chunk.choices[0]?.delta?.content;
  if (delta) {
    events.push({
      type: "response.output_text.delta",
      payload: {
        id: chunk.id,
        delta
      }
    });
  }

  const finishReason = chunk.choices[0]?.finish_reason;
  if (finishReason) {
    events.push({
      type: "response.completed",
      payload: {
        id: chunk.id,
        finishReason
      }
    });
  }

  return events;
}
