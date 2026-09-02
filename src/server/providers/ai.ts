export interface AIProvider {
  summarize(input: { subject: string; messages: string[] }): Promise<string | null>;
  draftReply(input: { subject: string; messages: string[]; instruction?: string }): Promise<string | null>;
  classify(input: {
    subject: string;
    body: string;
  }): Promise<{ category?: string; sentiment?: string; tags: string[] } | null>;
}

export class DisabledAIProvider implements AIProvider {
  async summarize() {
    return null;
  }
  async draftReply() {
    return null;
  }
  async classify() {
    return null;
  }
}
