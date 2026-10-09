import { SendMessageProps, WhatsAppResponse } from "./dtos";

/**
 * Outbound WhatsApp messaging.
 *
 * The surface is a single send because the official Meta Cloud API has no
 * per-tenant "instance" to create, pair or monitor — one registered business
 * number reaches any opted-in recipient. Anything shaped like connection
 * management here would be a leftover from the unofficial-gateway era.
 */
export interface IWhatsAppProvider {
  /**
   * Whether credentials are present. Environments without WhatsApp configured
   * still boot; sends just fail fast with a clear, non-retryable error.
   */
  isConfigured(): boolean;

  /**
   * Sends one message and reports the outcome.
   *
   * Never throws for a provider-side failure: the rejection comes back as a
   * `WhatsAppResponse` whose `retryable` flag already encodes whether another
   * attempt is worth making. Implementations own that classification because
   * only they can read their own error payloads.
   */
  sendMessage(props: SendMessageProps): Promise<WhatsAppResponse>;

  /**
   * Holds a template's sends for `seconds` (retryable, without calling the
   * provider), as the provider does on its own after a "template paused"
   * refusal. Fed by the provider's template status webhook. Optional: a
   * provider with no such state (test doubles) simply has nothing to hold.
   */
  pauseTemplate?(templateName: string, seconds: number): void;

  /** Lifts a template's pause: the provider reinstated or approved it. */
  resumeTemplate?(templateName: string): void;
}
