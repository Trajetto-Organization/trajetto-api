interface WhatsAppSettings {
  enabled: boolean;
  phoneNumber?: string;

  /**
   * Whether the server has Meta Cloud API credentials. Users can save their
   * preference either way — delivery starting to work is an ops concern —
   * but the UI uses this to explain why nothing will arrive yet.
   */
  serviceConfigured: boolean;
}

interface UpdateWhatsAppSettingsProps {
  userId: string;
  enabled: boolean;
  phoneNumber?: string;
}

export { WhatsAppSettings, UpdateWhatsAppSettingsProps };
