interface CreateInstanceProps {
  instanceName: string;
  phoneNumber: string;
  webhookUrl?: string;
}

interface QRCodeResponse {
  code: string;
}

interface ConnectionStatus {
  instanceName: string;
  status: "connected" | "disconnected" | "connecting" | "not_exists";
  phoneNumber?: string;
}

interface SendMessageProps {
  instanceName: string;
  phoneNumber: string;
  message: string;
}

interface WhatsAppResponse<T = any> {
  success: boolean;
  message: string;
  data?: T;
}

export {
  CreateInstanceProps,
  QRCodeResponse,
  ConnectionStatus,
  SendMessageProps,
  WhatsAppResponse,
};
