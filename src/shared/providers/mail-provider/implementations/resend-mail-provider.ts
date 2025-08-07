import { MailProviderProps } from "../dtos/mail-provider-dto";
import { IMailProvider } from "../IMail-provider";

import nodemailer, { Transporter } from "nodemailer";
import handlebars from "handlebars";

import { env } from "@/env";
import fs from "node:fs";

class ResendMailProvider implements IMailProvider {
  private client?: Transporter;

  constructor() {
    const tranporter = nodemailer.createTransport({
      host: "smtp.resend.com",
      port: 587, // ⚡ CHANGE: Use port 587 (STARTTLS) instead of 465 (SSL)
      auth: {
        user: "resend",
        pass: env.RESEND_SECRET_KEY,
      },
    });

    this.client = tranporter;
  }

  async sendMail({
    to,
    subject,
    variables,
    path,
  }: MailProviderProps): Promise<void> {
    try {
      const templateFileContent = fs.readFileSync(path).toString("utf-8");
      const templateParse = handlebars.compile(templateFileContent);

      const templateHTML = templateParse(variables);

      const message = await this.client?.sendMail({
        to,
        from: env.RESEND_FROM_EMAIL,
        subject,
        html: templateHTML,
        headers: {
          "X-Entity-Ref-ID": "trajetto-notifications",
          "X-Mailer": "Trajetto Fleet Management System",
        },
      });

      console.log("Message sent: %s", message.messageId);
      console.log("Preview URL: %s", nodemailer.getTestMessageUrl(message));
    } catch (error) {
      console.log(error);
    }
  }
}

export { ResendMailProvider };
