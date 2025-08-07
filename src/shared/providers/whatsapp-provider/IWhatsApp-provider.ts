import {
  CreateInstanceProps,
  QRCodeResponse,
  SendMessageProps,
  WhatsAppResponse,
  ConnectionStatus,
} from "./dtos";

export interface IWhatsAppProvider {
  // 🏗️ Instance Management
  createInstance(props: CreateInstanceProps): Promise<WhatsAppResponse>;
  deleteInstance(instanceName: string): Promise<WhatsAppResponse>;
  getConnectionStatus(instanceName: string): Promise<ConnectionStatus>;

  // 🔗 Connection Methods
  getQRCode(instanceName: string): Promise<WhatsAppResponse<QRCodeResponse>>;

  // 💬 Sending Messages
  sendMessage(props: SendMessageProps): Promise<WhatsAppResponse>;

  // 🔌 Connection Control
  disconnectInstance(instanceName: string): Promise<WhatsAppResponse>;
  reconnectInstance(instanceName: string): Promise<WhatsAppResponse>;
}
