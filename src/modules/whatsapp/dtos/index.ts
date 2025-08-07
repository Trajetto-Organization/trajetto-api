export interface WhatsAppSettings {
  enabled: boolean;
  phoneNumber?: string;
  instanceConnected: boolean;
  instanceName: string;
}

export interface UpdateWhatsAppSettingsProps {
  userId: string;
  enabled: boolean;
  phoneNumber?: string;
}

// ================ CONEXÃO ================

export interface ConnectionInfo {
  instanceName: string;
  status: "connected" | "disconnected" | "connecting" | "not_exists";
  phoneNumber?: string;
  qrCodeAvailable: boolean;
  pairingCodeAvailable: boolean;
}

export interface QRCodeData {
  code: string;
  expiresIn?: number;
}

export interface PairingCodeData {
  code: string;
  expiresIn: number;
  instructions: string;
}

export interface ConnectViaPairingCodeProps {
  instanceName: string;
  pairingCode: string;
}

// ================ MENSAGENS ================

export interface SendWhatsAppMessageProps {
  instanceName: string;
  phoneNumber: string;
  message: string;
}

export interface MessageTemplate {
  template: "fine_notification" | "user_created" | "custom";
  data: Record<string, any>;
}

export interface WhatsAppNotificationData {
  recipientPhone: string;
  message: string;
  instanceName: string;
}

// ================ WEBHOOK ================

export interface WebhookEventData {
  event: string;
  instance: string;
  data?: any;
  timestamp: string;
}

export interface ConnectionUpdateEvent {
  instanceName: string;
  status: string;
  phoneNumber?: string;
}

export interface QRCodeUpdateEvent {
  instanceName: string;
  qrCode?: string;
  base64?: string;
}

export interface PairingCodeUpdateEvent {
  instanceName: string;
  pairingCode: string;
}

export interface InstanceDeletedEvent {
  instanceName: string;
  reason: string;
}

// ================ RESPOSTAS ================

export interface WhatsAppOperationResult {
  success: boolean;
  message: string;
  data?: any;
}

export interface ConnectionResult extends WhatsAppOperationResult {
  connectionInfo?: ConnectionInfo;
}

export interface MessageResult extends WhatsAppOperationResult {
  messageId?: string;
  timestamp?: string;
}

// ================ ERROS ================

export interface WhatsAppError {
  code: string;
  message: string;
  details?: any;
}

// ================ USUÁRIO PERMISSIONS ================

export interface UserWhatsAppPermissions {
  canManageSettings: boolean;
  canViewQRCode: boolean;
  canSendMessages: boolean;
  canViewWebhook: boolean;
}
