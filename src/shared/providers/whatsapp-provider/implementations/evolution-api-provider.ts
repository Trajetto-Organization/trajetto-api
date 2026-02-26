import axios, { AxiosInstance } from "axios";
import { IWhatsAppProvider } from "../IWhatsApp-provider";

import { env } from "@/env";
import {
  CreateInstanceProps,
  WhatsAppResponse,
  ConnectionStatus,
  QRCodeResponse,
  SendMessageProps,
} from "../dtos";

class EvolutionApiProvider implements IWhatsAppProvider {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: env.EVOLUTION_API_URL,
      headers: {
        "Content-Type": "application/json",
        apikey: env.EVOLUTION_API_KEY,
      },
      timeout: 30000,
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    this.client.interceptors.request.use(
      (config) => {
        console.log(
          `[WhatsApp] 📤 ${config.method?.toUpperCase()} ${config.url}`,
        );
        return config;
      },
      (error) => {
        console.error("[WhatsApp] ❌ Request Error:", error.message);
        return Promise.reject(error);
      },
    );

    this.client.interceptors.response.use(
      (response) => {
        console.log(`[WhatsApp] ✅ Response: ${response.status}`);
        return response;
      },
      (error) => {
        console.error("[WhatsApp] ❌ Response Error:", {
          status: error.response?.status,
          message: error.response?.data?.message || error.message,
        });
        return Promise.reject(error);
      },
    );
  }

  async createInstance({
    instanceName,
    phoneNumber,
    webhookUrl,
  }: CreateInstanceProps): Promise<WhatsAppResponse> {
    try {
      console.log(`[WhatsApp] 🆕 Criando instância: ${instanceName}`);

      const normalizedPhone = this.normalizePhoneNumber(phoneNumber);
      const finalWebhookUrl =
        webhookUrl || this.getDefaultWebhookUrl(instanceName);

      const instanceConfig = {
        instanceName,
        token: this.generateToken(instanceName),
        qrcode: true,
        number: normalizedPhone,
        integration: "WHATSAPP-BAILEYS",
        webhook: {
          url: finalWebhookUrl,
          events: [
            "QRCODE_UPDATED",
            "CONNECTION_UPDATE",
            "LOGOUT_INSTANCE",
            "REMOVE_INSTANCE",
          ],
        },
      };

      const response = await this.client.post(
        "/instance/create",
        instanceConfig,
      );

      console.log(`[WhatsApp] ✅ Instância criada: ${instanceName}`);

      return {
        success: true,
        message: "Instância criada com sucesso",
        data: response.data,
      };
    } catch (error: any) {
      console.error(
        `[WhatsApp] ❌ Erro ao criar instância:`,
        error.response?.data,
      );

      return {
        success: false,
        message: error.response?.data?.message || "Erro ao criar a instância",
        data: error.response?.data,
      };
    }
  }

  async deleteInstance(instanceName: string): Promise<WhatsAppResponse> {
    try {
      console.log(`[WhatsApp] 🗑️ Deletando instância: ${instanceName}`);

      await this.client.delete(`/instance/delete/${instanceName}`);

      return {
        success: true,
        message: "Instância deletada com sucesso",
      };
    } catch (error: any) {
      console.error(`[WhatsApp] ❌ Erro ao deletar instância:`, error);

      return {
        success: false,
        message: error.response?.data?.message || "Erro ao deletar a instância",
      };
    }
  }

  async getConnectionStatus(instanceName: string): Promise<ConnectionStatus> {
    try {
      const response = await this.client.get(
        `/instance/connectionState/${instanceName}`,
      );

      const state = response.data.instance?.state || "disconnected";

      return {
        instanceName,
        status: this.mapConnectionState(state),
        phoneNumber: response.data.instance?.number,
      };
    } catch (error: any) {
      if (error.response?.status === 404) {
        return {
          instanceName,
          status: "not_exists",
        };
      }

      return {
        instanceName,
        status: "disconnected",
      };
    }
  }

  async getQRCode(
    instanceName: string,
  ): Promise<WhatsAppResponse<QRCodeResponse>> {
    try {
      console.log(`[WhatsApp] 📱 Obtendo QR Code: ${instanceName}`);

      const response = await this.client.get(
        `/instance/connect/${instanceName}`,
      );

      const qrCodeData = response.data.code;

      if (!qrCodeData) {
        throw new Error("QR Code não foi gerado");
      }

      return {
        success: true,
        message: "QR Code gerado com sucesso",
        data: {
          code: qrCodeData,
        },
      };
    } catch (error: any) {
      console.error(`[WhatsApp] ❌ Erro ao obter o QR Code:`, error);

      return {
        success: false,
        message: error.response?.data?.message || "Erro ao gerar o QR Code",
      };
    }
  }

  async sendMessage({
    instanceName,
    phoneNumber,
    message,
  }: SendMessageProps): Promise<WhatsAppResponse> {
    try {
      console.log(
        `[WhatsApp] 📨 Enviando mensagem via ${instanceName} para ${phoneNumber}`,
      );

      const normalizedPhone = this.normalizePhoneNumber(phoneNumber);

      const response = await this.client.post(
        `/message/sendText/${instanceName}`,
        {
          number: normalizedPhone,
          text: message,
          delay: 1000,
          linkPreview: false,
        },
      );

      console.log(`[WhatsApp] ✅ Mensagem enviada com sucesso`);

      return {
        success: true,
        message: "Mensagem enviada com sucesso",
        data: response.data,
      };
    } catch (error: any) {
      console.error(`[WhatsApp] ❌ Erro ao enviar mensagem:`, error);

      return {
        success: false,
        message: error.response?.data?.message || "Erro ao enviar a mensagem",
      };
    }
  }

  async disconnectInstance(instanceName: string): Promise<WhatsAppResponse> {
    try {
      console.log(`[WhatsApp] 🔌 Desconectando instância: ${instanceName}`);

      await this.client.delete(`/instance/logout/${instanceName}`);

      return {
        success: true,
        message: "Instância desconectada com sucesso",
      };
    } catch (error: any) {
      console.error(`[WhatsApp] ❌ Erro ao desconectar:`, error);

      return {
        success: false,
        message:
          error.response?.data?.message || "Erro ao desconectar a instância",
      };
    }
  }

  async reconnectInstance(instanceName: string): Promise<WhatsAppResponse> {
    try {
      console.log(`[WhatsApp] 🔄 Reconectando instância: ${instanceName}`);

      const response = await this.client.get(
        `/instance/connect/${instanceName}`,
      );

      return {
        success: true,
        message: "Reconexão iniciada",
        data: response.data,
      };
    } catch (error: any) {
      console.error(`[WhatsApp] ❌ Erro ao reconectar:`, error);

      return {
        success: false,
        message:
          error.response?.data?.message || "Erro ao reconectar a instância",
      };
    }
  }

  private normalizePhoneNumber(phone: string): string {
    let cleaned = phone.replace(/\D/g, "");

    // Brazil code
    if (!cleaned.startsWith("55") && cleaned.length === 11) {
      cleaned = "55" + cleaned;
    }

    return cleaned;
  }

  private mapConnectionState(state: string): ConnectionStatus["status"] {
    const stateMap: Record<string, ConnectionStatus["status"]> = {
      open: "connected",
      close: "disconnected",
      connecting: "connecting",
      CONNECTED: "connected",
      DISCONNECTED: "disconnected",
    };

    return stateMap[state] || "disconnected";
  }

  private generateToken(instanceName: string): string {
    return `${instanceName}_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  }

  private getDefaultWebhookUrl(instanceName: string): string {
    const backendUrl =
      env.NODE_ENV === "development"
        ? env.EVOLUTION_HTTP_REQUEST
        : env.API_HTTP_REQUEST;

    return `${backendUrl}/whatsapp/webhook/${instanceName}`;
  }
}

export { EvolutionApiProvider };
