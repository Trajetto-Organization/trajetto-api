interface WhatsAppSettings {
  enabled: boolean;
  phoneNumber?: string;
  instanceConnected: boolean;
  instanceName: string;
}

interface UpdateWhatsAppSettingsProps {
  userId: string;
  enabled: boolean;
  phoneNumber?: string;
}

// ================ CONNECTION ================

interface ConnectionInfo {
  instanceName: string;
  status: "connected" | "disconnected" | "connecting" | "not_exists";
  phoneNumber?: string;
  qrCodeAvailable: boolean;
  pairingCodeAvailable: boolean;
}

interface QRCodeData {
  code: string;
  expiresIn?: number;
}

interface PairingCodeData {
  code: string;
  expiresIn: number;
  instructions: string;
}

interface ConnectViaPairingCodeProps {
  instanceName: string;
  pairingCode: string;
}

// ================ MESSAGES ================

interface SendWhatsAppMessageProps {
  instanceName: string;
  phoneNumber: string;
  message: string;
}

interface MessageTemplate {
  template: "fine_notification" | "user_created" | "custom";
  data: Record<string, any>;
}

interface WhatsAppNotificationData {
  recipientPhone: string;
  message: string;
  instanceName: string;
}

// ================ WEBHOOK ================

interface WebhookEventData {
  event: string;
  instance: string;
  data?: any;
  timestamp: string;
}

interface ConnectionUpdateEvent {
  instanceName: string;
  status: string;
  phoneNumber?: string;
}

interface QRCodeUpdateEvent {
  instanceName: string;
  qrCode?: string;
  base64?: string;
}

interface PairingCodeUpdateEvent {
  instanceName: string;
  pairingCode: string;
}

interface InstanceDeletedEvent {
  instanceName: string;
  reason: string;
}

// ================ ANSWERS ================

interface WhatsAppOperationResult {
  success: boolean;
  message: string;
  data?: any;
}

interface ConnectionResult extends WhatsAppOperationResult {
  connectionInfo?: ConnectionInfo;
}

interface MessageResult extends WhatsAppOperationResult {
  messageId?: string;
  timestamp?: string;
}

// ================ ERRORS ================

interface WhatsAppError {
  code: string;
  message: string;
  details?: any;
}

// ================ USER PERMISSIONS ================

interface UserWhatsAppPermissions {
  canManageSettings: boolean;
  canViewQRCode: boolean;
  canSendMessages: boolean;
  canViewWebhook: boolean;
}

export {
  UserWhatsAppPermissions,
  WhatsAppError,
  MessageResult,
  ConnectionResult,
  WhatsAppOperationResult,
  InstanceDeletedEvent,
  PairingCodeUpdateEvent,
  QRCodeUpdateEvent,
  ConnectionUpdateEvent,
  WebhookEventData,
  WhatsAppNotificationData,
  MessageTemplate,
  SendWhatsAppMessageProps,
  ConnectViaPairingCodeProps,
  PairingCodeData,
  QRCodeData,
  ConnectionInfo,
  UpdateWhatsAppSettingsProps,
  WhatsAppSettings,
};
