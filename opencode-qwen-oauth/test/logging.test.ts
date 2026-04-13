import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/logging.js";

describe("redaction", () => {
  it("redacts bearer tokens and token fields", () => {
    const input = "Authorization=Bearer abc123 access_token:secret refresh_token=def456";
    const output = redactSecrets(input);
    expect(output).not.toContain("abc123");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("def456");
    expect(output).toContain("[REDACTED]");
  });
});
