import { useEffect, useMemo, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

// ==== IDL ====
import auctionIDL from "./idl/auction_program.json";

// ======= CONSTS =======
const USDC_MINT_DEVNET = new PublicKey(
  "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
);
const RENT_SYSVAR = new PublicKey(
  "SysvarRent111111111111111111111111111111111"
);

// ======= HELPERS =======
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
async function fetchMintDecimals(connection: any, mint: PublicKey) {
  const info = await connection.getParsedAccountInfo(mint);
  const parsed = (info.value?.data as any)?.parsed;
  const decimals: number | undefined = parsed?.info?.decimals;
  if (typeof decimals !== "number")
    throw new Error("Unable to read mint decimals");
  return decimals;
}
function bnToHuman(bn: BN, decimals: number) {
  return formatUnits(bn, decimals);
}
function logAccounts(label: string, rec: Record<string, any>) {
  console.group(label);
  Object.entries(rec).forEach(([k, v]) => {
    try {
      if (v instanceof PublicKey) {
        console.log(k, (v as PublicKey).toBase58());
      } else {
        console.log(k, v);
      }
    } catch {
      console.log(k, v);
    }
  });
  console.groupEnd();
}
async function withFailureLogs<T>(
  fn: () => Promise<T>,
  ctx?: {
    connection: any;
    publicKey?: PublicKey | null;
    build?: () => Promise<Transaction>;
  }
) {
  try {
    return await fn();
  } catch (e: any) {
    console.error("TX failed:", e);
    if (e.logs) {
      console.group("Program logs");
      e.logs.forEach((l: string) => console.log(l));
      console.groupEnd();
    }
    // optional simulation for richer logs
    if (ctx?.build && ctx.publicKey) {
      try {
        const tx = await ctx.build();
        tx.feePayer = ctx.publicKey!;
        tx.recentBlockhash = (
          await ctx.connection.getLatestBlockhash()
        ).blockhash;
        const sim = await ctx.connection.simulateTransaction(tx, {
          sigVerify: false,
        });
        console.group("simulateTransaction logs");
        (sim.value.logs || []).forEach((l: string) => console.log(l));
        console.groupEnd();
      } catch (simErr) {
        console.warn("simulateTransaction failed", simErr);
      }
    }
    throw e;
  }
}

// PDAs
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

function bidderAccountPda(
  buyer: PublicKey,
  auctionPda: PublicKey,
  programId: PublicKey
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bidder"), buyer.toBuffer(), auctionPda.toBuffer()],
    programId
  )[0];
}
function programStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("program_state")],
    programId
  );
}
function cliffAccountPda(
  auctionPda: PublicKey,
  index: number,
  programId: PublicKey
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("cliff"), auctionPda.toBuffer(), Buffer.from([index & 0xff])],
    programId
  )[0];
}
function cliffUsdcPda(
  auctionPda: PublicKey,
  index: number,
  programId: PublicKey
) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("cliff_usdc"),
      auctionPda.toBuffer(),
      Buffer.from([index & 0xff]),
    ],
    programId
  )[0];
}
function cliffTokenPda(
  auctionPda: PublicKey,
  index: number,
  programId: PublicKey
) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("cliff_token"),
      auctionPda.toBuffer(),
      Buffer.from([index & 0xff]),
    ],
    programId
  )[0];
}

// ======= COMPONENT =======
export default function Auction() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();

  // Defaults: your mint
  const [mintStr, setMintStr] = useState(
    "7nBpXyTZjs1h1ci3H59WsiKFGBYokfSJx8ff8ZmocvDg"
  );
  const [auctionIdStr, setAuctionIdStr] = useState("1");
  const [tokenAmountStr, setTokenAmountStr] = useState("100000"); // tokens to sell
  const [tokenPriceUSDC, setTokenPriceUSDC] = useState("1"); // price per token (in USDC)

  const [startTime, setStartTime] = useState<string>(() =>
    Math.floor(Date.now() / 1000).toString()
  );
  const [endTime, setEndTime] = useState<string>(() =>
    (Math.floor(Date.now() / 1000) + 3600).toString()
  );
  const [cliffCountStr, setCliffCountStr] = useState("3");
  const [cliffDurationSecStr, setCliffDurationSecStr] = useState("3600");

  // UI state
  const [decimals, setDecimals] = useState<number | null>(null);
  const [auctionInfo, setAuctionInfo] = useState<any>(null);
  const [buyAmountStr, setBuyAmountStr] = useState("10");
  const [cliffIndexStr, setCliffIndexStr] = useState("1");
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
    // @ts-ignore
    return new Program(auctionIDL as any, provider);
  }, [connection, publicKey, signTransaction]);

  const programId = useMemo(() => {
    try {
      // @ts-ignore
      return new PublicKey((auctionIDL as any).address);
    } catch (e) {
      console.error("Failed to parse program ID from IDL", e);
      return null;
    }
  }, []);

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

  // -------- initialize ----------
  const initProgram = async () => {
    if (!publicKey || !program || !programId) {
      setResult("Connect wallet first.");
      return;
    }
    setLoading(true);
    setResult("");
    try {
      const [statePda] = programStatePda(programId);
      const existing = await program.provider.connection.getAccountInfo(
        statePda
      );
      if (existing) {
        setResult(`Program already initialized at: ${statePda.toBase58()}`);
        return;
      }
      const tx = await program.methods
        .initialize()
        .accounts({
          programState: statePda,
          authority: publicKey,
          usdcMint: USDC_MINT_DEVNET,
          systemProgram: SystemProgram.programId,
          rent: RENT_SYSVAR,
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

  // -------- create_auction ----------
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

      // resolve decimals explicitly
      const usdcDecimals = await fetchMintDecimals(
        connection,
        USDC_MINT_DEVNET
      );

      const tokenAmountU64 = parseUnits(tokenAmountStr, decimals);
      // const tokenPriceU64 = parseUnits(tokenPriceUSDC, usdcDecimals);
      const tokenPriceU64 = new BN(1); // == $0.000001 per token
      const start = new BN(parseInt(startTime, 10));
      const end = new BN(parseInt(endTime, 10));
      const cliffCount = Number(cliffCountStr) & 0xff;
      const cliffDuration = new BN(parseInt(cliffDurationSecStr, 10));

      // sanity preview
      const totalUsdcAtPrice = tokenAmountU64
        .mul(tokenPriceU64)
        .div(new BN(10).pow(new BN(decimals)));

      console.group("createAuction payload");
      console.log("programId", program.programId.toBase58());
      console.log("auctionId (u64 raw)", auctionId.toString());
      console.log("token decimals", decimals);
      console.log("USDC decimals", usdcDecimals);

      console.log("tokenAmount raw", tokenAmountU64.toString());
      console.log("tokenAmount human", bnToHuman(tokenAmountU64, decimals));

      console.log("tokenPrice raw (micro-USDC)", tokenPriceU64.toString());
      console.log(
        "tokenPrice human (USDC)",
        bnToHuman(tokenPriceU64, usdcDecimals)
      );

      console.log(
        "totalUsdcAtPrice raw",
        totalUsdcAtPrice.toString(),
        "human",
        bnToHuman(totalUsdcAtPrice, usdcDecimals)
      );

      logAccounts("accounts", {
        auctionCreator: publicKey,
        auction: auctionPda,
        creatorTokenAccount,
        auctionTokenAccount,
        auctionUsdcAccount,
        tokenMint: mint,
        usdcMint: USDC_MINT_DEVNET,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      });
      console.groupEnd();

      const method = program.methods
        .createAuction(
          auctionId,
          tokenAmountU64,
          tokenPriceU64,
          start,
          end,
          cliffCount,
          cliffDuration
        )
        .accounts({
          auctionCreator: publicKey,
          auction: auctionPda,
          creatorTokenAccount,
          auctionTokenAccount,
          auctionUsdcAccount,
          tokenMint: mint,
          usdcMint: USDC_MINT_DEVNET,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: RENT_SYSVAR,
        });

      const txSig = await withFailureLogs(() => method.rpc(), {
        connection,
        publicKey,
        build: async () => {
          const ixs = await method.instructions();
          const tx = new Transaction().add(...ixs);
          return tx;
        },
      });

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

  // -------- buy_tokens ----------
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
      const buyerTokenAccount = await getAssociatedTokenAddress(
        mint,
        publicKey
      );
      const buyerUsdcAccount = await getAssociatedTokenAddress(
        USDC_MINT_DEVNET,
        publicKey
      );
      const preIxs: any[] = [];

      if (!(await connection.getAccountInfo(buyerTokenAccount))) {
        preIxs.push(
          createAssociatedTokenAccountInstruction(
            publicKey,
            buyerTokenAccount,
            publicKey,
            mint
          )
        );
      }
      if (!(await connection.getAccountInfo(buyerUsdcAccount))) {
        preIxs.push(
          createAssociatedTokenAccountInstruction(
            publicKey,
            buyerUsdcAccount,
            publicKey,
            USDC_MINT_DEVNET
          )
        );
      }

      const auctionTokenAccount = auctionTokenPda(auctionPda, programId);
      const auctionUsdcAccount = auctionUsdcPda(auctionPda, programId);
      const bidderPda = bidderAccountPda(publicKey, auctionPda, programId);

      const amountU64 = parseUnits(buyAmountStr, decimals);

      console.group("buyTokens payload");
      console.log(
        "amount raw",
        amountU64.toString(),
        "human",
        bnToHuman(amountU64, decimals)
      );
      logAccounts("accounts", {
        buyer: publicKey,
        auction: auctionPda,
        bidderAccount: bidderPda,
        buyerTokenAccount,
        buyerUsdcAccount,
        auctionTokenAccount,
        auctionUsdcAccount,
        tokenMint: mint,
        usdcMint: USDC_MINT_DEVNET,
      });
      console.groupEnd();

      const method = program.methods.buyTokens(amountU64).accounts({
        buyer: publicKey,
        auction: auctionPda,
        bidderAccount: bidderPda,
        buyerTokenAccount,
        auctionTokenAccount,
        buyerUsdcAccount,
        auctionUsdcAccount,
        usdcMint: USDC_MINT_DEVNET,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: RENT_SYSVAR,
      });

      if (preIxs.length) method.preInstructions(preIxs);

      const txSig = await withFailureLogs(() => method.rpc(), {
        connection,
        publicKey,
        build: async () => {
          const ixs = await method.instructions();
          const tx = new Transaction().add(...ixs);
          return tx;
        },
      });

      setResult(`Bought ${buyAmountStr} tokens.\n\nTx: ${txSig}`);
      await refreshAuction();
    } catch (e: any) {
      setResult("Error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  // -------- end_auction ----------
  const endAuction = async () => {
    if (!publicKey || !program || !auctionPda || !mint || !programId) {
      setResult("Connect wallet and load an existing auction.");
      return;
    }
    setLoading(true);
    setResult("");
    try {
      const creatorTokenAccount = await getAssociatedTokenAddress(
        mint,
        publicKey
      );
      const creatorUsdcAccount = await getAssociatedTokenAddress(
        USDC_MINT_DEVNET,
        publicKey
      );
      const auctionTokenAccount = auctionTokenPda(auctionPda, programId);
      const auctionUsdcAccount = auctionUsdcPda(auctionPda, programId);

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

      console.group("endAuction payload");
      logAccounts("accounts", {
        auction: auctionPda,
        signer: publicKey,
        creatorTokenAccount,
        creatorUsdcAccount,
        usdcAccount: auctionUsdcAccount,
        auctionTokenAccount,
      });
      console.groupEnd();

      const method = program.methods.endAuction().accounts({
        auction: auctionPda,
        signer: publicKey, // IDL: signer
        creatorTokenAccount,
        creatorUsdcAccount,
        usdcAccount: auctionUsdcAccount,
        auctionTokenAccount,
        usdcMint: USDC_MINT_DEVNET,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: RENT_SYSVAR,
      });
      if (preIxs.length) method.preInstructions(preIxs);

      const tx = await withFailureLogs(() => method.rpc(), {
        connection,
        publicKey,
        build: async () => {
          const ixs = await method.instructions();
          const tx = new Transaction().add(...ixs);
          return tx;
        },
      });

      setResult(`Auction ended.\nTx: ${tx}`);
      await refreshAuction();
    } catch (e: any) {
      setResult("Error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  // -------- create_single_cliff_account ----------
  const createCliff = async (index = 0) => {
    if (!publicKey || !program || !auctionPda || !programId || !mint) {
      setResult("Connect wallet and load an ended auction.");
      return;
    }
    setLoading(true);
    setResult("");
    try {
      const auctionUsdcAccount = auctionUsdcPda(auctionPda, programId);
      const cliffAccount = cliffAccountPda(auctionPda, index, programId);
      const cliffUsdc = cliffUsdcPda(auctionPda, index, programId);
      const cliffToken = cliffTokenPda(auctionPda, index, programId);

      console.group("createSingleCliffAccount payload");
      console.log("cliffIndex", index);
      logAccounts("accounts", {
        auctionCreator: publicKey,
        auction: auctionPda,
        auctionUsdcAccount,
        cliffAccount,
        cliffUsdcAccount: cliffUsdc,
        cliffTokenAccount: cliffToken,
        usdcMint: USDC_MINT_DEVNET,
        tokenMint: mint,
      });
      console.groupEnd();

      const method = program.methods.createSingleCliffAccount(index).accounts({
        auctionCreator: publicKey,
        auction: auctionPda,
        auctionUsdcAccount,
        cliffAccount,
        cliffUsdcAccount: cliffUsdc,
        cliffTokenAccount: cliffToken,
        usdcMint: USDC_MINT_DEVNET,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: RENT_SYSVAR,
      });

      const tx = await withFailureLogs(() => method.rpc(), {
        connection,
        publicKey,
        build: async () => {
          const ixs = await method.instructions();
          const tx = new Transaction().add(...ixs);
          return tx;
        },
      });

      setResult(`Cliff #${index} created.\nTx: ${tx}`);
    } catch (e: any) {
      setResult("Error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  // -------- clawback_usdc ----------
  const clawbackUsdc = async () => {
    if (!publicKey || !program || !auctionPda || !mint || !programId) {
      setResult("Connect wallet and load an existing auction.");
      return;
    }

    const cliffIndex = parseInt(cliffIndexStr, 10);
    if (isNaN(cliffIndex) || cliffIndex < 1) {
      setResult("Please enter a valid cliff index (1 or higher).");
      return;
    }

    setLoading(true);
    setResult("");

    try {
      // Get the auction creator from the auction info
      if (!auctionInfo?.creator) {
        setResult(
          "Could not find auction creator. Please refresh auction first."
        );
        return;
      }
      const auctionCreator = auctionInfo.creator as PublicKey;

      // Derive all required accounts
      const bidderAccount = bidderAccountPda(publicKey, auctionPda, programId);
      const bidderUsdcAccount = await getAssociatedTokenAddress(
        USDC_MINT_DEVNET,
        publicKey
      );
      const bidderTokenAccount = await getAssociatedTokenAddress(
        mint,
        publicKey
      );
      const auctionUsdcAccount = auctionUsdcPda(auctionPda, programId);
      const auctionTokenAccount = auctionTokenPda(auctionPda, programId);
      const cliffAccount = cliffAccountPda(auctionPda, cliffIndex, programId);
      const cliffUsdcAccount = cliffUsdcPda(auctionPda, cliffIndex, programId);
      const cliffTokenAccount = cliffTokenPda(
        auctionPda,
        cliffIndex,
        programId
      );
      // get bidder account details
      const bidderAccountDetails = await connection.getAccountInfo(
        bidderAccount
      );

      const bidderTokenAccountDetails = await connection.getAccountInfo(
        bidderTokenAccount
      );
      console.log("bidderTokenAccountDetails", bidderTokenAccountDetails);
      console.log("bidderAccountDetails", bidderAccountDetails);

      // Check if required token accounts exist and create if needed
      const preIxs: any[] = [];
      if (!(await connection.getAccountInfo(bidderUsdcAccount))) {
        preIxs.push(
          createAssociatedTokenAccountInstruction(
            publicKey,
            bidderUsdcAccount,
            publicKey,
            USDC_MINT_DEVNET
          )
        );
      }
      if (!(await connection.getAccountInfo(bidderTokenAccount))) {
        preIxs.push(
          createAssociatedTokenAccountInstruction(
            publicKey,
            bidderTokenAccount,
            publicKey,
            mint
          )
        );
      }

      console.group("clawbackUsdc payload");
      console.log("cliffIndex", cliffIndex);
      logAccounts("accounts", {
        bidder: publicKey,
        auction: auctionPda,
        auctionCreator,
        bidderAccount,
        bidderUsdcAccount,
        auctionUsdcAccount,
        auctionTokenAccount,
        cliffAccount,
        cliffUsdcAccount,
        cliffTokenAccount,
        bidderTokenAccount,
        usdcMint: USDC_MINT_DEVNET,
        tokenMint: mint,
      });
      console.groupEnd();

      const method = program.methods.clawbackUsdc().accounts({
        bidder: publicKey,
        auction: auctionPda,
        auctionCreator,
        bidderAccount,
        bidderUsdcAccount,
        auctionUsdcAccount,
        auctionTokenAccount,
        cliffAccount,
        cliffUsdcAccount,
        cliffTokenAccount,
        bidderTokenAccount,
        usdcMint: USDC_MINT_DEVNET,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      });

      if (preIxs.length) method.preInstructions(preIxs);

      const txSig = await withFailureLogs(() => method.rpc(), {
        connection,
        publicKey,
        build: async () => {
          const ix = await method.instructions();
          const tx = new Transaction().add(ix);
          return tx;
        },
      });

      setResult(`USDC clawed back from cliff #${cliffIndex}.\n\nTx: ${txSig}`);
      await refreshAuction();
    } catch (e: any) {
      setResult("Error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  // -------- claim_tokens ----------
  const claimTokens = async () => {
    if (!publicKey || !program || !auctionPda || !mint || !programId) {
      setResult("Connect wallet and load an existing auction.");
      return;
    }

    setLoading(true);
    setResult("");

    try {
      // Derive all required accounts
      const bidderAccount = bidderAccountPda(publicKey, auctionPda, programId);
      const bidderTokenAccount = await getAssociatedTokenAddress(
        mint,
        publicKey
      );
      const auctionTokenAccount = auctionTokenPda(auctionPda, programId);

      // Check if required token accounts exist and create if needed
      const preIxs: any[] = [];
      if (!(await connection.getAccountInfo(bidderTokenAccount))) {
        preIxs.push(
          createAssociatedTokenAccountInstruction(
            publicKey,
            bidderTokenAccount,
            publicKey,
            mint
          )
        );
      }

      console.group("claimTokens payload");
      logAccounts("accounts", {
        bidder: publicKey,
        auction: auctionPda,
        bidderAccount,
        bidderTokenAccount,
        auctionTokenAccount,
        tokenMint: mint,
      });
      console.groupEnd();

      const method = program.methods.claimTokens().accounts({
        bidder: publicKey,
        auction: auctionPda,
        bidderAccount,
        bidderTokenAccount,
        auctionTokenAccount,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      });

      if (preIxs.length) method.preInstructions(preIxs);

      const txSig = await withFailureLogs(() => method.rpc(), {
        connection,
        publicKey,
        build: async () => {
          const ixs = await method.instructions();
          const tx = new Transaction().add(...ixs);
          return tx;
        },
      });

      setResult(`Tokens claimed successfully.\n\nTx: ${txSig}`);
      await refreshAuction();
    } catch (e: any) {
      setResult("Error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  // ============ UI ============
  const prettyAuction = () => {
    if (!auctionInfo || decimals == null) return null;
    try {
      const tokenAmountBn = auctionInfo.tokenAmount as BN;
      const tokensSoldBn = (auctionInfo.tokensSold ?? new BN(0)) as BN;
      const remainingBn = tokenAmountBn.sub(tokensSoldBn);

      const tokenAmount = formatUnits(tokenAmountBn, decimals);
      const tokensSold = formatUnits(tokensSoldBn, decimals);
      const remaining = formatUnits(remainingBn, decimals);

      const tokenPrice = auctionInfo.tokenPrice as BN;
      const endTimeBn = auctionInfo.endTime as BN | undefined;

      const pctSold = tokenAmountBn.isZero()
        ? 0
        : Math.min(
            100,
            Number(tokensSoldBn.muln(10000).div(tokenAmountBn).toNumber() / 100)
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
            <strong>Price / Token:</strong> {Number(formatUnits(tokenPrice, 6))}{" "}
            USDC
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
          <p>
            <strong>Cliffs:</strong> {auctionInfo.cliffCount}
          </p>
          <p>
            <strong>Cliff Duration (sec):</strong>{" "}
            {auctionInfo.cliffDuration?.toString?.()}
          </p>
        </div>
      );
    } catch {
      return null;
    }
  };

  return (
    <div style={{ maxWidth: 560 }}>
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

        <div>
          <label
            style={{ display: "block", fontWeight: "bold", marginBottom: 4 }}
          >
            Price / Token (USDC)
          </label>
          <input
            type="number"
            value={tokenPriceUSDC}
            onChange={(e) => setTokenPriceUSDC(e.target.value)}
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
            style={{ display: "block", fontWeight: "bold", marginBottom: 4 }}
          >
            Start Time (unix sec)
          </label>
          <input
            type="number"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
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
            End Time (unix sec)
          </label>
          <input
            type="number"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
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
            Cliff Count (≤4)
          </label>
          <input
            type="number"
            value={cliffCountStr}
            onChange={(e) => setCliffCountStr(e.target.value)}
            min="1"
            max="4"
            step="1"
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
            Cliff Duration (sec)
          </label>
          <input
            type="number"
            value={cliffDurationSecStr}
            onChange={(e) => setCliffDurationSecStr(e.target.value)}
            min="0"
            step="1"
            style={{
              width: "100%",
              padding: 8,
              border: "1px solid #ddd",
              borderRadius: 4,
            }}
          />
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
            !tokenPriceUSDC
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
            <h4>Buy (USDC ➜ Tokens)</h4>
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

          <div
            style={{
              marginTop: 16,
              borderTop: "1px solid #eee",
              paddingTop: 12,
            }}
          >
            <h4>Create Cliff (after end)</h4>
            <button
              onClick={() => {
                createCliff(0).then(() => {
                  createCliff(1).then(() => {
                    createCliff(2).then(() => {
                      createCliff(3);
                    });
                  });
                });
              }}
              disabled={loading || !publicKey}
              style={{
                padding: "10px 12px",
                backgroundColor: !loading && publicKey ? "#6f42c1" : "#ccc",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: !loading && publicKey ? "pointer" : "not-allowed",
                fontWeight: "bold",
              }}
            >
              {loading ? "Processing..." : "Create Cliff #0"}
            </button>
          </div>

          <div
            style={{
              marginTop: 16,
              borderTop: "1px solid #eee",
              paddingTop: 12,
            }}
          >
            <h4>Claim Tokens</h4>
            <p style={{ fontSize: 12, color: "#bbb", marginBottom: 8 }}>
              Claim your purchased tokens from escrow
            </p>
            <button
              onClick={claimTokens}
              disabled={loading || !publicKey || !auctionInfo}
              style={{
                padding: "10px 12px",
                backgroundColor:
                  !loading && publicKey && auctionInfo ? "#28a745" : "#ccc",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor:
                  !loading && publicKey && auctionInfo
                    ? "pointer"
                    : "not-allowed",
                fontWeight: "bold",
              }}
            >
              {loading ? "Processing..." : "Claim Tokens"}
            </button>
          </div>

          <div
            style={{
              marginTop: 16,
              borderTop: "1px solid #eee",
              paddingTop: 12,
            }}
          >
            <h4>Clawback USDC</h4>
            <p style={{ fontSize: 12, color: "#bbb", marginBottom: 8 }}>
              Clawback USDC from a cliff before it vests (cliff 1+ only)
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                value={cliffIndexStr}
                onChange={(e) => setCliffIndexStr(e.target.value)}
                min="1"
                max="4"
                step="1"
                placeholder="Cliff index"
                style={{
                  width: 120,
                  padding: 8,
                  border: "1px solid #ddd",
                  borderRadius: 4,
                }}
              />
              <button
                onClick={clawbackUsdc}
                disabled={loading || !publicKey || !auctionInfo}
                style={{
                  padding: "10px 12px",
                  backgroundColor:
                    !loading && publicKey && auctionInfo ? "#dc3545" : "#ccc",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  cursor:
                    !loading && publicKey && auctionInfo
                      ? "pointer"
                      : "not-allowed",
                  fontWeight: "bold",
                }}
              >
                {loading ? "Processing..." : "Clawback USDC"}
              </button>
            </div>
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
            color: "black",
          }}
        >
          {result}
        </pre>
      )}
    </div>
  );
}
