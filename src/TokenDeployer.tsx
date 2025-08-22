import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey, // class to represent address
  Keypair, // class for keypairs
  Transaction, // class for creating tx
  SystemProgram, // object with methods to create system instructions
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, // address of SPL token program
  createInitializeMintInstruction,
  getAssociatedTokenAddress, // gets token account address for a wallet
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { createCreateMetadataAccountV3Instruction } from "@metaplex-foundation/mpl-token-metadata";
import Raise from "./Raise";
import Auction from "./Auction";

export default function TokenDeployer() {
  const { connection } = useConnection();
  const {
    publicKey,
    connect,
    disconnect,
    connected,
    signTransaction,
    select,
    wallets,
  } = useWallet();

  const [activeTab, setActiveTab] = useState<"deploy" | "raise" | "auction">(
    "deploy"
  );
  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [tokenSupply, setTokenSupply] = useState("1000000");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string>("");

  const deployToken = async () => {
    if (!connected || !publicKey) {
      alert("Please connect wallet first");
      return;
    }

    setLoading(true);
    setResult("");

    try {
      // generate a new keypair for the mint
      const mintKeypair = Keypair.generate();
      const mint = mintKeypair.publicKey; // mint address
      const decimals = 9;

      // calculate rent for mint account (rent exempt has enough sol to live forever)
      const mintRent = await connection.getMinimumBalanceForRentExemption(82);

      const createMintAccountIx = SystemProgram.createAccount({
        fromPubkey: publicKey,
        newAccountPubkey: mint,
        lamports: mintRent,
        space: 82,
        programId: TOKEN_PROGRAM_ID,
      });

      const initializeMintIx = createInitializeMintInstruction(
        mint, // mint address
        decimals,
        publicKey, // mint authority
        null, // freeze authority
        TOKEN_PROGRAM_ID
      );

      const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
        "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
      );

      // get metadata PDA (program derived address)
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("metadata"),
          TOKEN_METADATA_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
        ],
        TOKEN_METADATA_PROGRAM_ID
      );

      // create metadata instruction
      const accounts = {
        metadata: metadataPDA,
        mint: mint,
        mintAuthority: publicKey,
        payer: publicKey,
        updateAuthority: publicKey,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      };

      const args = {
        createMetadataAccountArgsV3: {
          data: {
            name: tokenName,
            symbol: tokenSymbol,
            uri: "",
            sellerFeeBasisPoints: 0,
            creators: null,
            collection: null,
            uses: null,
          },
          isMutable: true,
          collectionDetails: null,
        },
      };

      const createMetadataInstruction =
        createCreateMetadataAccountV3Instruction(accounts, args);

      // ATA for connected wallet
      const associatedTokenAddress = await getAssociatedTokenAddress(
        mint,
        publicKey
      );

      const createATAInstruction = createAssociatedTokenAccountInstruction(
        publicKey, // payer
        associatedTokenAddress, // ata
        publicKey, // owner
        mint
      );

      const mintInstruction = createMintToInstruction(
        mint,
        associatedTokenAddress, // destination
        publicKey, // authority
        Number(tokenSupply) * Math.pow(10, decimals)
      );

      // combine ALL instructions
      const transaction = new Transaction()
        .add(createMintAccountIx)
        .add(initializeMintIx)
        .add(createMetadataInstruction)
        .add(createATAInstruction)
        .add(mintInstruction);

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;

      // partially sign with mint keypair first
      transaction.partialSign(mintKeypair);

      // then sign with wallet
      if (!signTransaction) {
        throw new Error("Wallet does not support transaction signing");
      }
      const signedTx = await signTransaction(transaction);
      const signature = await connection.sendRawTransaction(
        signedTx.serialize()
      );

      await connection.confirmTransaction(signature, "confirmed");

      const resultMessage = `Token deployed successfully
      
Token Name: ${tokenName}
Token Symbol: ${tokenSymbol}
Mint Address: ${mint.toBase58()}
Total Supply: ${tokenSupply} ${tokenSymbol}

Transaction: ${signature}
View on Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`;

      setResult(resultMessage);
    } catch (err) {
      setResult("Error: " + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const connectWallet = async () => {
    const phantomWallet = wallets.find((w) => w.adapter.name === "Phantom");
    if (phantomWallet) {
      select(phantomWallet.adapter.name);
    }

    // small delay to let selection complete
    setTimeout(async () => {
      try {
        await connect();
      } catch (error) {}
    }, 50);
  };

  return (
    <div style={{ maxWidth: "400px", width: "100%" }}>
      <div style={{ textAlign: "right", marginBottom: "20px" }}>
        {connected ? (
          <div>
            <span style={{ marginRight: "10px", fontSize: "14px" }}>
              {publicKey?.toString().slice(0, 4)}...
              {publicKey?.toString().slice(-4)}
            </span>
            <button
              onClick={disconnect}
              style={{
                padding: "8px 16px",
                backgroundColor: "#f44336",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            onClick={connectWallet}
            style={{
              padding: "8px 16px",
              backgroundColor: "#4CAF50",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Connect Phantom
          </button>
        )}
      </div>
      <div style={{ display: "flex", marginBottom: "20px", gap: "20px" }}>
        <button
          onClick={() => setActiveTab("deploy")}
          style={{
            padding: "8px 16px",
            backgroundColor: "transparent",
            border: "none",
            cursor: "pointer",
            fontWeight: activeTab === "deploy" ? "bold" : "normal",
            fontSize: "16px",
          }}
        >
          Deploy Token
        </button>
        <button
          onClick={() => setActiveTab("raise")}
          style={{
            padding: "8px 16px",
            backgroundColor: "transparent",
            border: "none",
            cursor: "pointer",
            fontWeight: activeTab === "raise" ? "bold" : "normal",
            fontSize: "16px",
          }}
        >
          Raise
        </button>
        <button
          onClick={() => setActiveTab("auction")}
          style={{
            padding: "8px 16px",
            backgroundColor: "transparent",
            border: "none",
            cursor: "pointer",
            fontWeight: activeTab === "auction" ? "bold" : "normal",
            fontSize: "16px",
          }}
        >
          Auction
        </button>
      </div>
      {activeTab === "deploy" && (
        <>
          <h2>Deploy SPL Token</h2>

          <div style={{ marginBottom: "15px" }}>
            <label
              style={{
                display: "block",
                marginBottom: "5px",
                fontWeight: "bold",
              }}
            >
              Token Name
            </label>
            <input
              type="text"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              style={{
                width: "100%",
                padding: "8px",
                border: "1px solid #ddd",
                borderRadius: "4px",
              }}
              placeholder="My Token"
            />
          </div>

          <div style={{ marginBottom: "15px" }}>
            <label
              style={{
                display: "block",
                marginBottom: "5px",
                fontWeight: "bold",
              }}
            >
              Token Symbol
            </label>
            <input
              type="text"
              value={tokenSymbol}
              onChange={(e) => setTokenSymbol(e.target.value)}
              style={{
                width: "100%",
                padding: "8px",
                border: "1px solid #ddd",
                borderRadius: "4px",
              }}
              placeholder="MTK"
              maxLength={10}
            />
          </div>

          <div style={{ marginBottom: "15px" }}>
            <label
              style={{
                display: "block",
                marginBottom: "5px",
                fontWeight: "bold",
              }}
            >
              Token Supply
            </label>
            <input
              type="number"
              value={tokenSupply}
              onChange={(e) => setTokenSupply(e.target.value)}
              style={{
                width: "100%",
                padding: "8px",
                border: "1px solid #ddd",
                borderRadius: "4px",
              }}
              min="1"
            />
          </div>

          <button
            onClick={deployToken}
            disabled={!connected || loading || !tokenName || !tokenSymbol}
            style={{
              width: "100%",
              padding: "12px",
              backgroundColor: connected && !loading ? "#4CAF50" : "#ccc",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: connected && !loading ? "pointer" : "not-allowed",
              fontSize: "16px",
              fontWeight: "bold",
            }}
          >
            {loading ? "Deploying Token..." : "Deploy Token"}
          </button>
        </>
      )}

      {activeTab === "raise" && <Raise />}

      {activeTab === "auction" && (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Auction />
        </div>
      )}

      {!connected && (
        <p
          style={{
            color: "#666",
            fontSize: "14px",
            marginTop: "10px",
            textAlign: "center",
          }}
        >
          Please connect Phantom wallet first
        </p>
      )}
      {result && (
        <pre
          style={{
            marginTop: "20px",
            padding: "15px",
            backgroundColor: result.includes("Error") ? "#fee" : "#efe",
            border: result.includes("Error")
              ? "1px solid #fcc"
              : "1px solid #cfc",
            borderRadius: "4px",
            fontSize: "12px",
            wordBreak: "break-all",
            whiteSpace: "pre-wrap",
          }}
        >
          {result}
        </pre>
      )}
    </div>
  );
}
