import { describe, expect, it } from "vitest";
import { convertChunkToResponseEvents } from "../src/stream.js";

describe("stream conversion", () => {
  it("emits ordered output events", () => {
    const events = convertChunkToResponseEvents({
      id: "chunk-1",
      choices: [
        {
          delta: { content: "hello" },
          finish_reason: "stop"
        }
      ]
    });

    expect(events.map((event) => event.type)).toEqual([
      "response.output_item.added",
      "response.output_text.delta",
      "response.completed"
    ]);
  });
});
