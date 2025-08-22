import { useEffect, useMemo, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import auctionIDL from "./idl/auction_program.json";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

/** ===== Constants ===== */
const USDC_MINT_DEVNET = new PublicKey(
  "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
);

/** ===== Helpers ===== */
function parseUnits(amountStr: string, decimals: number): BN {
  const [wholeRaw, fracRaw = ""] = (amountStr || "0").split(".");
  const whole = wholeRaw.replace(/^0+/, "") || "0";
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  const combined = (whole === "0" ? "" : whole) + frac;
  return new BN(combined === "" ? "0" : combined);
}
function formatUnits(bn: BN, decimals: number): string {
  const s = bn.toString();
  const pad = decimals - s.length;
  if (pad >= 0) return `0.${"0".repeat(pad)}${s}`.replace(/\.$/, "");
  const head = s.slice(0, s.length - decimals);
  const tail = s.slice(s.length - decimals);
  return `${head}.${tail}`.replace(/\.$/, "");
}
function deriveAuctionPda(
  creator: PublicKey,
  auctionId: BN,
  programId: PublicKey
) {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(auctionId.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("auction"), creator.toBuffer(), idBuf],
    programId
  )[0];
}
async function fetchMintDecimals(connection: any, mint: PublicKey) {
  const info = await connection.getParsedAccountInfo(mint);
  const parsed = (info.value?.data as any)?.parsed;
  const decimals: number | undefined = parsed?.info?.decimals;
  if (typeof decimals !== "number")
    throw new Error("Unable to read mint decimals");
  return decimals;
}
const toUSDC = (s: string) => parseUnits(s || "0", 6);

// ProgramState PDA (seed = "program_state")
function programStatePda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("program_state")],
    programId
  )[0];
}

function auctionTokenPda(auctionPda: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("auction_tokens"), auctionPda.toBuffer()],
    programId
  )[0];
}
function auctionUsdcPda(auctionPda: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("auction_usdc"), auctionPda.toBuffer()],
    programId
  )[0];
}

// Creates the ATA if it doesn't exist. Owner may be a PDA (off-curve).
async function ensureAtaIx(
  connection: any,
  mint: PublicKey,
  owner: PublicKey,
  payer: PublicKey
): Promise<{
  ata: PublicKey;
  ix: import("@solana/web3.js").TransactionInstruction | null;
}> {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    const ix = createAssociatedTokenAccountInstruction(payer, ata, owner, mint);
    return { ata, ix };
  }
  return { ata, ix: null };
}

/** ===== Component ===== */
export default function Auction() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();

  // Inputs
  const [mintStr, setMintStr] = useState("");
  const [auctionIdStr, setAuctionIdStr] = useState("0");
  const [tokenAmountStr, setTokenAmountStr] = useState("1000");
  const [minPriceUSDC, setMinPriceUSDC] = useState("0.01");
  const [maxPriceUSDC, setMaxPriceUSDC] = useState("2");

  // UI state
  const [decimals, setDecimals] = useState<number | null>(null);
  const [auctionInfo, setAuctionInfo] = useState<any>(null);
  const [buyAmountStr, setBuyAmountStr] = useState("1");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string>("");

  // Anchor setup
  const program = useMemo(() => {
    if (!connection || !publicKey || !signTransaction) return null;
    const wallet = {
      publicKey,
      signTransaction,
      signAllTransactions: async (txs: any) => txs,
    };
    const provider = new AnchorProvider(connection, wallet as any, {
      commitment: "confirmed",
    });
    // const prog = new Program(auctionIDL as any, provider);
    // console.log("Program ID from IDL:", (auctionIDL as any).address);
    // console.log("Program ID from Program object:", prog.programId.toBase58());

    // @ts-ignore (IDL contains "address")
    return new Program(auctionIDL as any, provider);
  }, [connection, publicKey, signTransaction]);

  console.log("RPC:", (connection as any)._rpcEndpoint);

  const programId = useMemo(() => {
    try {
      // @ts-ignore
      const addr = new PublicKey((auctionIDL as any).address);
      //   console.log("ProgramId from IDL useMemo:", addr.toBase58());
      return addr;
    } catch (e) {
      console.error("Failed to parse program ID from IDL", e);
      return null;
    }
  }, []);

  // Derived values
  const mint = useMemo(() => {
    try {
      return mintStr ? new PublicKey(mintStr) : null;
    } catch {
      return null;
    }
  }, [mintStr]);

  const auctionId = useMemo(() => {
    try {
      return new BN(auctionIdStr || "0");
    } catch {
      return new BN(0);
    }
  }, [auctionIdStr]);

  const auctionPda = useMemo(() => {
    if (!programId || !publicKey) return null;
    return deriveAuctionPda(publicKey, auctionId, programId);
  }, [publicKey, auctionId, programId]);

  useEffect(() => {
    (async () => {
      if (!mint) return;
      try {
        const d = await fetchMintDecimals(connection, mint);
        setDecimals(d);
      } catch (e: any) {
        setResult("Error reading mint decimals: " + e.message);
        setDecimals(null);
      }
    })();
  }, [connection, mint]);

  /** ===== Actions ===== */
  const refreshAuction = async () => {
    if (!program || !auctionPda) return;
    try {
      // @ts-ignore
      const acct = await program.account.auction.fetch(auctionPda);
      setAuctionInfo(acct);
      setResult("");
    } catch (e: any) {
      setAuctionInfo(null);
      setResult("No auction found for the given creator + id (yet).");
    }
  };

  // one-time program init (stores USDC mint in ProgramState)
  //   const initProgram = async () => {
  //     if (!publicKey || !program || !programId) {
  //       setResult("Connect wallet first.");
  //       return;
  //     }
  //     setLoading(true);
  //     setResult("");
  //     // console.log("Using programId:", programId?.toBase58());
  //     try {
  //       const statePda = programStatePda(programId);
  //       const tx = await program.methods
  //         .initialize()
  //         .accounts({
  //           programState: statePda,
  //           authority: publicKey,
  //           usdcMint: USDC_MINT_DEVNET,
  //           systemProgram: SystemProgram.programId,
  //           rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
  //         })
  //         .rpc();
  //       setResult(`Program initialized.\nTx: ${tx}`);
  //     } catch (e: any) {
  //       setResult("Error: " + e.message);
  //     } finally {
  //       setLoading(false);
  //     }
  //   };
  // derive the PDA for program state
  function programStatePda(programId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("program_state")],
      programId
    );
  }

  const initProgram = async () => {
    if (!publicKey || !program || !programId) {
      setResult("Connect wallet first.");
      return;
    }

    setLoading(true);
    setResult("");

    try {
      const [statePda] = programStatePda(programId);

      // check if PDA exists on chain
      const existingAccount = await program.provider.connection.getAccountInfo(
        statePda
      );

      if (existingAccount) {
        setResult(`Program already initialized at: ${statePda.toBase58()}`);
        return; // don’t run initialize again
      }

      // run initialize only if missing
      const tx = await program.methods
        .initialize()
        .accounts({
          programState: statePda,
          authority: publicKey,
          usdcMint: USDC_MINT_DEVNET,
          systemProgram: SystemProgram.programId,
          rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
        })
        .rpc();

      setResult(
        `Program initialized.\nTx: ${tx}\nState PDA: ${statePda.toBase58()}`
      );
    } catch (e: any) {
      setResult("Error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  //   const createAuction = async () => {
  //     if (!publicKey || !program || !mint || decimals == null || !auctionPda) {
  //       setResult("Connect wallet, set Mint, and ensure decimals were read.");
  //       return;
  //     }

  //     setLoading(true);
  //     setResult("");
  //     // console.log("Using programId:", programId?.toBase58());

  //     try {
  //       const creatorTokenAccount = await getAssociatedTokenAddress(
  //         mint,
  //         publicKey
  //       );

  //       const tokenAmountU64 = parseUnits(tokenAmountStr, decimals);
  //       const minPriceU64 = toUSDC(minPriceUSDC);
  //       const maxPriceU64 = toUSDC(maxPriceUSDC);

  //       console.log(
  //         "id:",
  //         auctionId,
  //         "Token Amount:",
  //         tokenAmountU64,
  //         "min price:",
  //         minPriceU64,
  //         "max price:",
  //         maxPriceU64
  //       );

  //       const txSig = await program.methods
  //         .createAuction(auctionId, tokenAmountU64, minPriceU64, maxPriceU64)
  //         .accounts({
  //           auctionCreator: publicKey,
  //           auction: auctionPda,
  //           creatorTokenAccount,
  //           tokenMint: mint,
  //           tokenProgram: new PublicKey(
  //             "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  //           ),
  //           systemProgram: SystemProgram.programId,
  //           rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
  //         })
  //         .rpc();

  //       setResult(
  //         `Auction created\n\nTx: ${txSig}\nAuction PDA: ${auctionPda.toBase58()}\nExplorer: https://explorer.solana.com/tx/${txSig}?cluster=devnet`
  //       );
  //       await refreshAuction();
  //     } catch (e: any) {
  //       setResult("Error: " + e.message);
  //     } finally {
  //       setLoading(false);
  //     }
  //   };

  //   const createAuction = async () => {
  //     if (!publicKey || !program || !mint || decimals == null || !auctionPda) {
  //       setResult("Connect wallet, set Mint, and ensure decimals were read.");
  //       return;
  //     }

  //     setLoading(true);
  //     setResult("");

  //     try {
  //       const creatorTokenAccount = await getAssociatedTokenAddress(
  //         mint,
  //         publicKey
  //       );

  //       // Ensure the AUCTION PDA’s vault ATA exists (owner = auctionPda)
  //       const { ata: auctionTokenAccount, ix: createVaultAtaIx } =
  //         await ensureAtaIx(connection, mint, auctionPda, publicKey);

  //       const tokenAmountU64 = parseUnits(tokenAmountStr, decimals);
  //       const minPriceU64 = toUSDC(minPriceUSDC);
  //       const maxPriceU64 = toUSDC(maxPriceUSDC);

  //       const method = program.methods
  //         .createAuction(auctionId, tokenAmountU64, minPriceU64, maxPriceU64)
  //         .accounts({
  //           auctionCreator: publicKey,
  //           auction: auctionPda,
  //           creatorTokenAccount,
  //           auctionTokenAccount, // ✅ pass the vault ATA
  //           tokenMint: mint,
  //           tokenProgram: new PublicKey(
  //             "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  //           ),
  //           systemProgram: SystemProgram.programId,
  //           rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
  //         });

  //       // If ATA didn’t exist, create it in the same tx as a pre-instruction
  //       if (createVaultAtaIx) method.preInstructions([createVaultAtaIx]);

  //       const txSig = await method.rpc();
  //       setResult(
  //         `Auction created\n\nTx: ${txSig}\nAuction PDA: ${auctionPda.toBase58()}\nExplorer: https://explorer.solana.com/tx/${txSig}?cluster=devnet`
  //       );
  //       await refreshAuction();
  //     } catch (e: any) {
  //       setResult("Error: " + e.message);
  //     } finally {
  //       setLoading(false);
  //     }
  //   };
  const createAuction = async () => {
    if (
      !publicKey ||
      !program ||
      !mint ||
      decimals == null ||
      !auctionPda ||
      !programId
    ) {
      setResult("Connect wallet, set Mint, and ensure decimals were read.");
      return;
    }
    setLoading(true);
    setResult("");
    try {
      const creatorTokenAccount = await getAssociatedTokenAddress(
        mint,
        publicKey
      );
      const auctionTokenAccount = auctionTokenPda(auctionPda, programId);
      const auctionUsdcAccount = auctionUsdcPda(auctionPda, programId);

      const tokenAmountU64 = parseUnits(tokenAmountStr, decimals);
      const minPriceU64 = toUSDC(minPriceUSDC);
      const maxPriceU64 = toUSDC(maxPriceUSDC);

      const txSig = await program.methods
        .createAuction(auctionId, tokenAmountU64, minPriceU64, maxPriceU64)
        .accounts({
          auctionCreator: publicKey,
          auction: auctionPda,
          creatorTokenAccount,
          auctionTokenAccount, // PDA (created by program)
          auctionUsdcAccount, // PDA (created by program)
          tokenMint: mint,
          usdcMint: USDC_MINT_DEVNET,
          tokenProgram: new PublicKey(
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          ),
          systemProgram: SystemProgram.programId,
          rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
        })
        .rpc();

      setResult(
        `Auction created\n\nTx: ${txSig}\nAuction PDA: ${auctionPda.toBase58()}`
      );
      await refreshAuction();
    } catch (e: any) {
      setResult("Error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  //   const buyTokens = async () => {
  //     if (!publicKey || !program || !auctionPda || !mint || decimals == null) {
  //       setResult("Connect wallet and load an existing auction.");
  //       return;
  //     }

  //     setLoading(true);
  //     setResult("");

  //     try {
  //       const buyerTokenAccount = await getAssociatedTokenAddress(
  //         mint,
  //         publicKey
  //       );
  //       const auctionTokenAccount = await getAssociatedTokenAddress(
  //         mint,
  //         auctionPda,
  //         true // off-curve owner
  //       );

  //       const amountU64 = parseUnits(buyAmountStr, decimals);

  //       const txSig = await program.methods
  //         .buyTokens(amountU64)
  //         .accounts({
  //           buyer: publicKey,
  //           auction: auctionPda,
  //           buyerTokenAccount,
  //           auctionTokenAccount,
  //           usdcMint: USDC_MINT_DEVNET, // required in your new IDL
  //           auctionCreator: publicKey, // demo: you're both creator & buyer; replace if buying someone else's
  //           tokenMint: mint,
  //           tokenProgram: new PublicKey(
  //             "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  //           ),
  //           systemProgram: SystemProgram.programId,
  //         })
  //         .rpc();

  //       setResult(
  //         `Bought ${buyAmountStr} tokens.\n\nTx: ${txSig}\nExplorer: https://explorer.solana.com/tx/${txSig}?cluster=devnet`
  //       );
  //       await refreshAuction();
  //     } catch (e: any) {
  //       setResult("Error: " + e.message);
  //     } finally {
  //       setLoading(false);
  //     }
  //   };

  //   const buyTokens = async () => {
  //     if (!publicKey || !program || !auctionPda || !mint || decimals == null) {
  //       setResult("Connect wallet and load an existing auction.");
  //       return;
  //     }

  //     setLoading(true);
  //     setResult("");

  //     try {
  //       // Ensure buyer’s ATA exists (owner = user wallet)
  //       const { ata: buyerTokenAccount, ix: createBuyerAtaIx } =
  //         await ensureAtaIx(connection, mint, publicKey, publicKey);

  //       // Ensure auction vault ATA exists (owner = auction PDA)
  //       const { ata: auctionTokenAccount, ix: createVaultAtaIx } =
  //         await ensureAtaIx(connection, mint, auctionPda, publicKey);

  //       const amountU64 = parseUnits(buyAmountStr, decimals);

  //       const method = program.methods.buyTokens(amountU64).accounts({
  //         buyer: publicKey,
  //         auction: auctionPda,
  //         buyerTokenAccount,
  //         auctionTokenAccount,
  //         usdcMint: USDC_MINT_DEVNET, // (still in your IDL)
  //         auctionCreator: publicKey, // (adjust if needed)
  //         tokenMint: mint,
  //         tokenProgram: new PublicKey(
  //           "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  //         ),
  //         systemProgram: SystemProgram.programId,
  //       });

  //       const preIxs = [];
  //       if (createBuyerAtaIx) preIxs.push(createBuyerAtaIx);
  //       if (createVaultAtaIx) preIxs.push(createVaultAtaIx);
  //       if (preIxs.length) method.preInstructions(preIxs);

  //       const txSig = await method.rpc();
  //       setResult(
  //         `Bought ${buyAmountStr} tokens.\n\nTx: ${txSig}\nExplorer: https://explorer.solana.com/tx/${txSig}?cluster=devnet`
  //       );
  //       await refreshAuction();
  //     } catch (e: any) {
  //       setResult("Error: " + e.message);
  //     } finally {
  //       setLoading(false);
  //     }
  //   };

  const buyTokens = async () => {
    if (
      !publicKey ||
      !program ||
      !auctionPda ||
      !mint ||
      decimals == null ||
      !programId
    ) {
      setResult("Connect wallet and load an existing auction.");
      return;
    }
    setLoading(true);
    setResult("");
    try {
      // buyer’s ATAs (create if missing)
      const buyerTokenAccount = await getAssociatedTokenAddress(
        mint,
        publicKey
      );
      const buyerUsdcAccount = await getAssociatedTokenAddress(
        USDC_MINT_DEVNET,
        publicKey
      );

      const preIxs: any[] = [];
      const info1 = await connection.getAccountInfo(buyerTokenAccount);
      if (!info1)
        preIxs.push(
          createAssociatedTokenAccountInstruction(
            publicKey,
            buyerTokenAccount,
            publicKey,
            mint
          )
        );
      const info2 = await connection.getAccountInfo(buyerUsdcAccount);
      if (!info2)
        preIxs.push(
          createAssociatedTokenAccountInstruction(
            publicKey,
            buyerUsdcAccount,
            publicKey,
            USDC_MINT_DEVNET
          )
        );

      // auction vault PDAs
      const auctionTokenAccount = auctionTokenPda(auctionPda, programId);
      const auctionUsdcAccount = auctionUsdcPda(auctionPda, programId);

      const amountU64 = parseUnits(buyAmountStr, decimals);

      const method = program.methods.buyTokens(amountU64).accounts({
        buyer: publicKey,
        auction: auctionPda,
        buyerTokenAccount,
        auctionTokenAccount, // PDA
        buyerUsdcAccount, // buyer USDC ATA
        auctionUsdcAccount, // PDA
        usdcMint: USDC_MINT_DEVNET,
        auctionCreator: publicKey, // replace if the creator is different
        tokenMint: mint,
        tokenProgram: new PublicKey(
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        ),
        systemProgram: SystemProgram.programId,
      });

      if (preIxs.length) method.preInstructions(preIxs);

      const txSig = await method.rpc();
      setResult(`Bought ${buyAmountStr} tokens.\n\nTx: ${txSig}`);
      await refreshAuction();
    } catch (e: any) {
      setResult("Error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const endAuction = async () => {
    if (!publicKey || !program || !auctionPda || !mint || !programId) {
      setResult("Connect wallet and load an existing auction.");
      return;
    }
    setLoading(true);
    setResult("");
    console.log("TOKEN_PROGRAM_ID:", TOKEN_PROGRAM_ID.toBase58());

    // helpers you already have:
    const auctionTokenAccount = auctionTokenPda(auctionPda, programId);
    const auctionUsdcAccount = auctionUsdcPda(auctionPda, programId);

    console.log("ProgramId (IDL):", programId.toBase58());
    console.log("Auction PDA:", auctionPda.toBase58());
    console.log("Vault token PDA:", auctionTokenAccount.toBase58());
    console.log("Vault USDC  PDA:", auctionUsdcAccount.toBase58());

    const iTok = await connection.getParsedAccountInfo(auctionTokenAccount);
    const iUsdc = await connection.getParsedAccountInfo(auctionUsdcAccount);

    console.log(
      "vault token exists?",
      !!iTok.value,
      iTok.value?.owner?.toBase58()
    );
    console.log(
      "vault usdc  exists?",
      !!iUsdc.value,
      iUsdc.value?.owner?.toBase58()
    );

    // If exists, also check parsed fields:
    const vt = (iTok.value?.data as any)?.parsed?.info;
    const vu = (iUsdc.value?.data as any)?.parsed?.info;

    console.log("vault token owner:", vt?.owner, "mint:", vt?.mint);
    console.log("vault usdc  owner:", vu?.owner, "mint:", vu?.mint);

    try {
      // creator’s ATAs (receiver)
      const creatorTokenAccount = await getAssociatedTokenAddress(
        mint,
        publicKey
      );
      const creatorUsdcAccount = await getAssociatedTokenAddress(
        USDC_MINT_DEVNET,
        publicKey
      );

      // auction vault PDAs (must match seeds in program)
      const auctionTokenAccount = auctionTokenPda(auctionPda, programId); // seeds ["auction_tokens", auctionPda]
      const auctionUsdcAccount = auctionUsdcPda(auctionPda, programId); // seeds ["auction_usdc",  auctionPda]

      // (optional) ensure creator has USDC ATA
      const preIxs: any[] = [];
      if (!(await connection.getAccountInfo(creatorUsdcAccount))) {
        preIxs.push(
          createAssociatedTokenAccountInstruction(
            publicKey,
            creatorUsdcAccount,
            publicKey,
            USDC_MINT_DEVNET
          )
        );
      }

      const method = program.methods.endAuction().accounts({
        auction: auctionPda,
        auctionCreator: publicKey,
        creatorTokenAccount,
        creatorUsdcAccount, // NEW in program
        usdcAccount: auctionUsdcAccount, // PDA vault (NOT ATA)
        auctionTokenAccount, // PDA vault (NOT ATA)
        tokenProgram: new PublicKey(
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        ),
      });

      if (preIxs.length) method.preInstructions(preIxs);

      const tx = await method.rpc();
      setResult(`Auction ended.\nTx: ${tx}`);
      await refreshAuction();
    } catch (e: any) {
      setResult("Error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  /** ===== Render ===== */
  const prettyAuction = () => {
    if (!auctionInfo || decimals == null) return null;
    try {
      const tokenAmountBn = auctionInfo.tokenAmount as BN;
      const tokensSoldBn = (auctionInfo.tokensSold ?? new BN(0)) as BN;
      const remainingBn = tokenAmountBn.sub(tokensSoldBn);

      const tokenAmount = formatUnits(tokenAmountBn, decimals);
      const tokensSold = formatUnits(tokensSoldBn, decimals);
      const remaining = formatUnits(remainingBn, decimals);

      const minPrice = auctionInfo.minPrice as BN;
      const maxPrice = auctionInfo.maxPrice as BN;
      const currentPrice = auctionInfo.currentPrice as BN;
      const endTimeBn = auctionInfo.endTime as BN | undefined;

      // % sold (guard divide-by-zero)
      const pctSold = tokenAmountBn.isZero()
        ? 0
        : Math.min(
            100,
            Number(
              tokensSoldBn.muln(10000).div(tokenAmountBn).toNumber() / 100 // two decimals
            )
          );

      return (
        <div style={{ marginTop: 10, fontSize: 14 }}>
          <p>
            <strong>Creator:</strong>{" "}
            {(auctionInfo.creator as PublicKey).toBase58()}
          </p>
          <p>
            <strong>Auction ID:</strong> {auctionInfo.auctionId?.toString()}
          </p>
          <p>
            <strong>Token Mint:</strong>{" "}
            {(auctionInfo.tokenMint as PublicKey).toBase58()}
          </p>

          <p style={{ marginTop: 8 }}>
            <strong>Total Tokens:</strong> {tokenAmount}
          </p>
          <p>
            <strong>Sold:</strong> {tokensSold}
          </p>
          <p>
            <strong>Remaining:</strong> {remaining}
          </p>

          {/* simple progress bar */}
          <div style={{ margin: "6px 0 12px 0" }}>
            <div
              style={{
                height: 8,
                background: "#333",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${pctSold}%`,
                  height: "100%",
                  background: "#28a745",
                }}
              />
            </div>
            <small style={{ color: "#bbb" }}>{pctSold.toFixed(2)}% sold</small>
          </div>

          <p>
            <strong>Min Price / Token:</strong>{" "}
            {Number(formatUnits(minPrice, 6))} USDC
          </p>
          <p>
            <strong>Max Price / Token:</strong>{" "}
            {Number(formatUnits(maxPrice, 6))} USDC
          </p>
          <p>
            <strong>Current Price / Token:</strong>{" "}
            {Number(formatUnits(currentPrice, 6))} USDC
          </p>

          {endTimeBn && (
            <p>
              <strong>Ends:</strong>{" "}
              {new Date(endTimeBn.toNumber() * 1000).toLocaleString()}
            </p>
          )}
          <p>
            <strong>Active:</strong> {auctionInfo.isActive ? "Yes" : "No"}
          </p>
        </div>
      );
    } catch {
      return null;
    }
  };

  return (
    <div style={{ maxWidth: 520 }}>
      <h2>Auction</h2>

      <div style={{ marginBottom: 8 }}>
        <label
          style={{ display: "block", fontWeight: "bold", marginBottom: 4 }}
        >
          Token Mint
        </label>
        <input
          type="text"
          value={mintStr}
          onChange={(e) => setMintStr(e.target.value)}
          placeholder="Mint address"
          style={{
            width: "100%",
            padding: 8,
            border: "1px solid #ddd",
            borderRadius: 4,
          }}
        />
        {decimals != null && (
          <small style={{ color: "#666" }}>Mint decimals: {decimals}</small>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label
            style={{ display: "block", fontWeight: "bold", marginBottom: 4 }}
          >
            Auction ID (u64)
          </label>
          <input
            type="number"
            value={auctionIdStr}
            onChange={(e) => setAuctionIdStr(e.target.value)}
            style={{
              width: "100%",
              padding: 8,
              border: "1px solid #ddd",
              borderRadius: 4,
            }}
          />
        </div>

        <div>
          <label
            style={{ display: "block", fontWeight: "bold", marginBottom: 4 }}
          >
            Token Amount
          </label>
          <input
            type="number"
            value={tokenAmountStr}
            onChange={(e) => setTokenAmountStr(e.target.value)}
            min="0"
            step="0.000001"
            style={{
              width: "100%",
              padding: 8,
              border: "1px solid #ddd",
              borderRadius: 4,
            }}
          />
        </div>

        <div style={{ gridColumn: "span 2" }}>
          <label
            style={{
              display: "block",
              fontWeight: "bold",
              marginBottom: 4,
            }}
          >
            (USDC)
          </label>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            <div>
              <label
                style={{
                  display: "block",
                  fontWeight: "bold",
                  marginBottom: 4,
                }}
              >
                Min Price / Token
              </label>
              <input
                type="number"
                value={minPriceUSDC}
                onChange={(e) => setMinPriceUSDC(e.target.value)}
                min="0"
                step="0.000001"
                style={{
                  width: "100%",
                  padding: 8,
                  border: "1px solid #ddd",
                  borderRadius: 4,
                }}
              />
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  fontWeight: "bold",
                  marginBottom: 4,
                }}
              >
                Max Price / Token
              </label>
              <input
                type="number"
                value={maxPriceUSDC}
                onChange={(e) => setMaxPriceUSDC(e.target.value)}
                min="0"
                step="0.000001"
                style={{
                  width: "100%",
                  padding: 8,
                  border: "1px solid #ddd",
                  borderRadius: 4,
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button
          onClick={initProgram}
          disabled={loading || !publicKey}
          style={{
            padding: "10px 12px",
            backgroundColor: !loading && publicKey ? "#6c757d" : "#ccc",
            color: "white",
            border: "none",
            borderRadius: 4,
            cursor: !loading && publicKey ? "pointer" : "not-allowed",
            fontWeight: "bold",
          }}
          title="Run once after deploy to set USDC mint"
        >
          Initialize Program
        </button>

        <button
          onClick={createAuction}
          disabled={
            loading ||
            !publicKey ||
            !mintStr ||
            !auctionIdStr ||
            !tokenAmountStr ||
            !minPriceUSDC ||
            !maxPriceUSDC
          }
          style={{
            padding: "10px 12px",
            backgroundColor: !loading && publicKey ? "#4CAF50" : "#ccc",
            color: "white",
            border: "none",
            borderRadius: 4,
            cursor: !loading && publicKey ? "pointer" : "not-allowed",
            fontWeight: "bold",
          }}
        >
          {loading ? "Processing..." : "Create Auction"}
        </button>

        <button
          onClick={refreshAuction}
          disabled={loading || !publicKey}
          style={{
            padding: "10px 12px",
            backgroundColor: !loading && publicKey ? "#007bff" : "#ccc",
            color: "white",
            border: "none",
            borderRadius: 4,
            cursor: !loading && publicKey ? "pointer" : "not-allowed",
            fontWeight: "bold",
          }}
        >
          Refresh
        </button>
      </div>

      {auctionInfo && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            border: "1px solid #ddd",
            borderRadius: 6,
            background: "#141212ff",
            color: "white",
          }}
        >
          <h3 style={{ marginTop: 0 }}>Auction State</h3>
          {prettyAuction()}

          <div
            style={{
              marginTop: 16,
              borderTop: "1px solid #eee",
              paddingTop: 12,
            }}
          >
            <h4>Buy (Instant)</h4>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                value={buyAmountStr}
                onChange={(e) => setBuyAmountStr(e.target.value)}
                min="0"
                step="0.000001"
                placeholder="Amount to buy"
                style={{
                  width: 180,
                  padding: 8,
                  border: "1px solid #ddd",
                  borderRadius: 4,
                }}
              />
              <button
                onClick={buyTokens}
                disabled={loading || !publicKey}
                style={{
                  padding: "10px 12px",
                  backgroundColor: !loading && publicKey ? "#28a745" : "#ccc",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  cursor: !loading && publicKey ? "pointer" : "not-allowed",
                  fontWeight: "bold",
                }}
              >
                {loading ? "Processing..." : "Buy Tokens"}
              </button>
            </div>
          </div>

          <div
            style={{
              marginTop: 16,
              borderTop: "1px solid #eee",
              paddingTop: 12,
            }}
          >
            <h4>End Auction</h4>
            <button
              onClick={endAuction}
              disabled={loading || !publicKey}
              style={{
                padding: "10px 12px",
                backgroundColor: !loading && publicKey ? "#dc3545" : "#ccc",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: !loading && publicKey ? "pointer" : "not-allowed",
                fontWeight: "bold",
              }}
            >
              {loading ? "Processing..." : "End Auction"}
            </button>
          </div>
        </div>
      )}

      {result && (
        <pre
          style={{
            marginTop: 16,
            padding: 12,
            backgroundColor: result.includes("Error") ? "#fee" : "#efe",
            border: result.includes("Error")
              ? "1px solid #fcc"
              : "1px solid #cfc",
            borderRadius: 4,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "black", // always black text as requested
          }}
        >
          {result}
        </pre>
      )}
    </div>
  );
}
