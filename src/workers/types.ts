interface EmailWorkerData {
  queueName: string;
  environment: "development" | "production" | "test";
}

interface WhatsAppWorkerData {
  queueName: string;
  environment: "development" | "production" | "test";
}

interface AIVerificationWorkerData {
  queueName: string;
  environment: "development" | "production" | "test";
}

export { EmailWorkerData, WhatsAppWorkerData, AIVerificationWorkerData };
