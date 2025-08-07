export function generateWhatsAppInstanceName(email: string, businessId: string): string {
  return `Trajetto-${email}-${businessId}`;
}