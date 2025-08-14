import { PublicKey, Transaction } from '@solana/web3.js';

declare global {
  interface Window {
    solana?: {
      isPhantom?: boolean;
      isConnected?: boolean;
      publicKey?: PublicKey;
      connect(): Promise<{ publicKey: PublicKey }>;
      disconnect(): Promise<void>;
      signTransaction?(transaction: Transaction): Promise<Transaction>;
    };
  }
}

export {};