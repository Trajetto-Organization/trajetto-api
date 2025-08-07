import { MailProviderProps } from "../dtos/mail-provider-dto";
import { IMailProvider } from "../IMail-provider";

import nodemailer, { Transporter } from "nodemailer";
import handlebars from "handlebars";

import fs from "node:fs";

class EtherealMailProvider implements IMailProvider {
  private client?: Transporter;
  private isInitializing: boolean = false;

  private initializationPromise?: Promise<void>;

  constructor() {
    // Initialize the client immediately in the constructor
    this.initializeClient();
  }

  private initializeClient(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.isInitializing = true;
    this.initializationPromise = (async () => {
      try {
        const account = await nodemailer.createTestAccount();
        const transporter = nodemailer.createTransport({
          host: account.smtp.host,
          port: account.smtp.port,
          secure: account.smtp.secure,
          auth: {
            user: account.user,
            pass: account.pass,
          },
        });

        this.client = transporter;
        console.log("Ethereal Mail client initialized successfully!");
      } catch (error) {
        console.error("Failed to initialize Ethereal Mail client:", error);
        throw error;
      } finally {
        this.isInitializing = false;
      }
    })();

    return this.initializationPromise;
  }

  async sendMail({
    to,
    subject,
    variables,
    path,
  }: MailProviderProps): Promise<void> {
    try {
      // Ensure the client is initialized
      if (!this.client) {
        if (this.isInitializing) {
          console.log("Waiting for Ethereal Mail client initialization...");
          await this.initializationPromise;
        } else {
          console.log(
            "Ethereal Mail client not initialized. Initializing now...",
          );
          await this.initializeClient();
        }
      }

      // Recheck after boot attempt
      if (!this.client) {
        throw new Error("Failed to initialize email client after retrying");
      }

      const templateFileContent = fs.readFileSync(path).toString("utf-8");
      const templateParse = handlebars.compile(templateFileContent);

      const templateHTML = templateParse(variables);

      const message = await this.client.sendMail({
        to,
        from: "Trajetto <noreply@intrajetto.com>",
        subject,
        html: templateHTML,
      });

      // Get display URL
      const previewUrl = nodemailer.getTestMessageUrl(message);
      console.log("Preview URL: %s", previewUrl || "URL não disponível");
    } catch (error) {
      console.error("Error sending mail:", error);
      throw error;
    }
  }
}

export { EtherealMailProvider };
