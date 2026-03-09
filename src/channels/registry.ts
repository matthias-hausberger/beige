export interface SendMessageOptions {
  parseMode?: "html" | "markdown";
}

export interface ChannelAdapter {
  sendMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
    options?: SendMessageOptions
  ): Promise<void>;
  
  supportsMessaging(): boolean;
}

export class ChannelRegistry {
  private channels = new Map<string, ChannelAdapter>();
  
  register(channel: string, adapter: ChannelAdapter): void {
    this.channels.set(channel, adapter);
    console.log(`[CHANNELS] Registered channel adapter: ${channel}`);
  }
  
  get(channel: string): ChannelAdapter | undefined {
    return this.channels.get(channel);
  }
  
  has(channel: string): boolean {
    return this.channels.has(channel);
  }
}
