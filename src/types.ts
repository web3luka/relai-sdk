// src/types.ts
export interface RelaiConfig {
  apiKey: string;                      // Required: Your RelayAI API key
  network?: 'solana' | 'solana-devnet'; // Optional: Network to use
  facilitatorUrl?: string;              // Optional: Custom facilitator URL
  apiBaseUrl?: string;                  // Optional: Custom API base URL
}

export type DynamicPrice = number | ((req: any) => number | Promise<number>);

export interface ProtectOptions {
  price: DynamicPrice;                  // Required: Price in USD (number or async function)
  description?: string;                 // Optional: Endpoint description
  maxTimeout?: number;                  // Optional: Payment verification timeout (ms), default 10000
  customRules?: (req: any) => boolean | Promise<boolean>; // Optional: Custom validation
  onPaymentRequired?: (
    req: any,
    info: { price: number; description?: string; facilitatorUrl?: string }
  ) => void;                            // Optional: hook when 402 is returned
  onPaymentVerified?: (req: any, result: PaymentResult) => void; // Optional: hook after successful verification
  onError?: (req: any, error: unknown) => void; // Optional: hook on internal error
}

export interface PaymentResult {
  verified: boolean;
  transactionId?: string;
  amount?: number;
  currency?: string;
  error?: string;
}
