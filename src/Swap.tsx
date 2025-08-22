// Swap.tsx
import { useEffect, useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

declare global {
  interface Window {
    Jupiter?: {
      init: (opts: any) => void;
      syncProps?: (opts: any) => void;
    };
  }
}

type Props = {
  inputMint?: string;
  outputMint?: string;
  lockPair?: boolean;
  rpc?: string;
};

export default function Swap({
  inputMint = "So11111111111111111111111111111111111111112", // SOL
  outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  lockPair = false,
  rpc = "https://api.mainnet-beta.solana.com",
}: Props) {
  const wallet = useWallet();

  // strip only the fields Jupiter needs (avoids Proxy issues in some adapters)
  const passthroughWallet = useMemo(
    () => ({
      publicKey: wallet.publicKey ?? null,
      connected: wallet.connected,
      connecting: wallet.connecting,
      disconnect: wallet.disconnect,
      signTransaction: wallet.signTransaction,
      signAllTransactions: wallet.signAllTransactions,
      sendTransaction: wallet.sendTransaction,
    }),
    [
      wallet.publicKey,
      wallet.connected,
      wallet.connecting,
      wallet.disconnect,
      wallet.signTransaction,
      wallet.signAllTransactions,
      wallet.sendTransaction,
    ]
  );

  useEffect(() => {
    // inject the script once
    const id = "jupiter-terminal";
    if (!document.getElementById(id)) {
      const s = document.createElement("script");
      s.id = id;
      s.src = "https://terminal.jup.ag/main-v2.js";
      s.async = true;
      document.head.appendChild(s);
    }

    let attempts = 0;
    const timer = setInterval(() => {
      if (window.Jupiter?.init) {
        clearInterval(timer);

        window.Jupiter.init({
          displayMode: "integrated",
          integratedTargetId: "jupiter-plugin-container",
          endpoint: rpc, // keep this on mainnet-beta if your wallet is mainnet
          enableWalletPassthrough: true,
          // Use *only* your wallet (removes their “Connect” UX)
          // If your version of Terminal supports it, keep this on; otherwise omit.
          enableWalletPassthroughOnly: true,

          // Hand over the wallet
          passthroughWalletContextState: passthroughWallet,

          // Preselect/lock pair if needed
          formProps: {
            initialInputMint: inputMint,
            initialOutputMint: outputMint,
            ...(lockPair ? { fixedMint: inputMint } : {}),
          },

          // Optional: container styling
          containerStyles: {
            width: "100%",
            maxWidth: "420px",
            borderRadius: "16px",
            overflow: "hidden",
          },

          onSuccess: ({ txid }: { txid: string }) =>
            console.log("Swap success:", txid),
          onSwapError: ({ error }: { error: any }) =>
            console.error("Swap error:", error),
        });
      } else if (++attempts > 50) {
        clearInterval(timer);
        console.error("Jupiter Terminal failed to load.");
      }
    }, 100);

    return () => clearInterval(timer);
  }, [rpc, inputMint, outputMint, lockPair]); // init when core props change

  // CRITICAL: keep balances in sync when wallet state changes (connect, disconnect, account change)
  useEffect(() => {
    if (window.Jupiter?.syncProps) {
      window.Jupiter.syncProps({
        passthroughWalletContextState: passthroughWallet,
      });
    }
  }, [passthroughWallet]);

  return (
    <>
      {/* Theme (customize to your brand) */}
      <style>{`
        :root {
          --jupiter-plugin-primary: 59,130,246;
          --jupiter-plugin-background: 17, 24, 39;
          --jupiter-plugin-primaryText: 226, 232, 240;
          --jupiter-plugin-interactive: 31, 41, 55;
          --jupiter-plugin-module: 3, 7, 18;
        }
      `}</style>
      <div id="jupiter-plugin-container" />
    </>
  );
}
