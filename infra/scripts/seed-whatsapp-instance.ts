import { env } from "@/env";
import axios from "axios";

class WhatsAppInstanceSeeder {
  private client = axios.create({
    baseURL: env.EVOLUTION_API_URL,
    timeout: 30000,
    headers: {
      "Content-Type": "application/json",
      apikey: env.EVOLUTION_API_KEY,
    },
  });

  async seedBusinessInstance(): Promise<void> {
    const instanceName = env.TRAJETTO_WHATSAPP_INSTANCE_NAME;
    const businessPhone = env.TRAJETTO_WHATSAPP_BUSINESS_PHONE;

    console.log(
      `🔍 [WhatsApp Seed] Checking if instance exists: ${instanceName}`,
    );

    try {
      // Check if instance already exists
      const status = await this.checkInstanceExists(instanceName);

      if (status) {
        console.log(
          `✅ [WhatsApp Seed] Instance already exists: ${instanceName}`,
        );
        console.log(`📞 [WhatsApp Seed] Status: ${status}`);
        return;
      }

      // Instance doesn't exist, create it
      console.log(
        `🚀 [WhatsApp Seed] Creating business instance: ${instanceName}`,
      );
      await this.createBusinessInstance(instanceName, businessPhone);

      console.log(`✅ [WhatsApp Seed] Business instance created successfully!`);
      console.log(`📱 [WhatsApp Seed] Instance: ${instanceName}`);
      console.log(`📞 [WhatsApp Seed] Phone: ${businessPhone}`);
      console.log(
        `🌐 [WhatsApp Seed] Webhook: ${this.getWebhookUrl(instanceName)}`,
      );
    } catch (error) {
      console.error(
        `❌ [WhatsApp Seed] Error seeding business instance:`,
        error,
      );
      throw error;
    }
  }

  private async checkInstanceExists(
    instanceName: string,
  ): Promise<string | null> {
    try {
      const response = await this.client.get(
        `/instance/connectionState/${instanceName}`,
      );

      return response.data?.instance?.state || "unknown";
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null; // Instance doesn't exist
      }
      throw error;
    }
  }

  private async createBusinessInstance(
    instanceName: string,
    phoneNumber: string,
  ): Promise<void> {
    const instanceConfig = {
      instanceName,
      token: this.generateToken(instanceName),
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
      number: this.normalizePhoneNumber(phoneNumber),
      settings: {
        rejectCall: false,
        msgCall: "Suporte Trajetto - Sistema não aceita chamadas",
        groupsIgnore: false,
        alwaysOnline: false,
        readMessages: false,
        readStatus: false,
        syncFullHistory: false,
        phoneClient: "windows",
      },
      webhook: {
        url: this.getWebhookUrl(instanceName),
        webhook_by_events: true,
        webhook_base64: false,
        events: [
          "QRCODE_UPDATED",
          "CONNECTION_UPDATE",
          "LOGOUT_INSTANCE",
          "REMOVE_INSTANCE",
        ],
      },
      auth: {
        authType: "md",
      },
    };

    const response = await this.client.post("/instance/create", instanceConfig);

    if (!response.data) {
      throw new Error("Failed to create instance - no response data");
    }
  }

  private normalizePhoneNumber(phone: string): string {
    let cleaned = phone.replace(/\D/g, "");

    // Add Brazil code if not present
    if (!cleaned.startsWith("55") && cleaned.length === 11) {
      cleaned = "55" + cleaned;
    }

    return cleaned;
  }

  private generateToken(instanceName: string): string {
    return `${instanceName}_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  }

  private getWebhookUrl(instanceName: string): string {
    const backendUrl =
      env.NODE_ENV === "development"
        ? env.EVOLUTION_HTTP_REQUEST
        : env.API_HTTP_REQUEST;
    return `${backendUrl}/whatsapp/webhook/${instanceName}`;
  }
}

// Execute seeding if called directly
async function main() {
  try {
    console.log(`🌱 [WhatsApp Seed] Starting WhatsApp instance seeding...`);

    const seeder = new WhatsAppInstanceSeeder();
    await seeder.seedBusinessInstance();

    console.log(`🎉 [WhatsApp Seed] WhatsApp instance seeding completed!`);
  } catch (error) {
    console.error(`💥 [WhatsApp Seed] Fatal error:`, error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main();
}

export { WhatsAppInstanceSeeder };
