import { useState, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import idl from './idl/simple_raise.json';

const USDC_MINT_DEVNET = new PublicKey('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'); // USDC on devnet

export default function Raise() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  
  const [mintAddress, setMintAddress] = useState('');
  const [tokenAmount, setTokenAmount] = useState('100000');
  const [pricePerToken, setPricePerToken] = useState('1');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string>('');
  
  const [saleInfo, setSaleInfo] = useState<any>(null);
  const [buyAmount, setBuyAmount] = useState('1');
  const [saleMint, setSaleMint] = useState<string>('');
  
  // fetch sale info on wallet connect
  useEffect(() => {
    if (publicKey) {
      fetchSaleInfo();
    }
  }, [publicKey]);

  const fetchSaleInfo = async () => {
    if (!publicKey || !signTransaction) return;
    
    try {
      const wallet = {
        publicKey,
        signTransaction,
        signAllTransactions: async (txs: any) => txs
      };
      
      const provider = new AnchorProvider(
        connection,
        wallet as any,
        { commitment: 'confirmed' }
      );
      
      const program = new Program(idl as any, provider);
      
      // find PDA (program derived address) for accounts needed for sale info
      const [salePDA] = PublicKey.findProgramAddressSync( // stores info on the sale
        [Buffer.from('sale'), publicKey.toBuffer()],
        program.programId
      );
      
      // gets sale info from struct in program
      const sale = await (program.account as any).sale.fetch(salePDA); 
      
      const [saleTokenAccountPDA] = PublicKey.findProgramAddressSync( // vault holding the tokens being sold
        [Buffer.from('sale_tokens'), salePDA.toBuffer()],
        program.programId
      );
      
      const tokenAccountInfo = await connection.getParsedAccountInfo(saleTokenAccountPDA);
      const mintAddress = (tokenAccountInfo.value?.data as any)?.parsed?.info?.mint;
      
      setSaleMint(mintAddress || '');
      setSaleInfo({
        tokenAmount: sale.tokenAmount.toNumber() / 1e9,
        pricePerToken: sale.pricePerToken.toNumber() / 1e6,
        tokensSold: sale.tokensSold.toNumber() / 1e9,
        isActive: sale.isActive,
        tokensRemaining: (sale.tokenAmount.toNumber() - sale.tokensSold.toNumber()) / 1e9,
        mint: mintAddress,
      });
      
    } catch (err) {
      setSaleInfo(null);
      setSaleMint('');
    }
  };

  const createSale = async () => {
    if (!publicKey || !signTransaction) {
      alert('Please connect wallet first');
      return;
    }

    setLoading(true);
    setResult('');

    try {
      const wallet = {
        publicKey,
        signTransaction,
        signAllTransactions: async (txs: any) => txs
      };
      
      const provider = new AnchorProvider( 
        connection,
        wallet as any,
        { commitment: 'confirmed' }
      );
      
      const program = new Program(idl as any, provider);
      
      const mint = new PublicKey(mintAddress);
      
      // find PDAs the program is expecting

      // unique address for the sale account - stores sale info (price, amount, seller)
      // account does not exist yet, when createSale is called it creates at this address if one doesn't exist
      const [salePDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('sale'), publicKey.toBuffer()],
        program.programId
      );
      
      // unique address for the vault that holds the tokens being sold
      const [saleTokenAccountPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('sale_tokens'), salePDA.toBuffer()],
        program.programId
      );
      
      // unique address for the vault that holds USDC payments
      const [saleUsdcAccountPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('sale_usdc'), salePDA.toBuffer()],
        program.programId
      );
      
      // get seller's token account
      const sellerTokenAccount = await getAssociatedTokenAddress(
        mint,
        publicKey
      );
      
      // create token sale
      const tx = await program.methods
        .createSale(
          new BN(Number(tokenAmount) * 1e9), 
          new BN(Number(pricePerToken) * 1e6) 
        )
        .accounts({
          seller: publicKey, // who's creating the sale
          sale: salePDA, // stores sale info
          mint: mint, 
          usdcMint: USDC_MINT_DEVNET,
          sellerTokenAccount: sellerTokenAccount, // personal token account holding the tokens
          saleTokenAccount: saleTokenAccountPDA, // vault for tokens being sold
          saleUsdcAccount: saleUsdcAccountPDA, // vault for usdc earned from sale
          tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // handles transfers
          systemProgram: SystemProgram.programId, // solanas core program (creates accounts/transfers)
          rent: new PublicKey('SysvarRent111111111111111111111111111111111'), // calc storage costs
        })
        .rpc();
      
      setResult(`Sale created successfully
      
Transaction: ${tx}
Sale PDA: ${salePDA.toBase58()}
View on Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
      
      await fetchSaleInfo();
      
    } catch (err) {
      setResult('Error: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const buyTokens = async () => {
    
    if (!publicKey || !signTransaction) {
      alert('Please connect wallet first');
      return;
    }

    setLoading(true);
    setResult('');

    try {
      const wallet = {
        publicKey,
        signTransaction,
        signAllTransactions: async (txs: any) => txs
      };
      
      const provider = new AnchorProvider(
        connection,
        wallet as any,
        { commitment: 'confirmed' }
      );
      
      const program = new Program(idl as any, provider);
      
      const mint = new PublicKey(saleMint || mintAddress);
      
      // since this is a demo - seller is myself
      const sellerPubkey = publicKey; // in production this would be the actual seller
      
      // get all necessary PDAs
      const [salePDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('sale'), sellerPubkey.toBuffer()],
        program.programId
      );
      
      const [saleTokenAccountPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('sale_tokens'), salePDA.toBuffer()],
        program.programId
      );
      
      const [saleUsdcAccountPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('sale_usdc'), salePDA.toBuffer()],
        program.programId
      );
      
      // get buyer's token accounts
      const buyerTokenAccount = await getAssociatedTokenAddress(
        mint,
        publicKey
      );
      
      const buyerUsdcAccount = await getAssociatedTokenAddress(
        USDC_MINT_DEVNET,
        publicKey
      );
      
      // buy the tokens
      const tx = await program.methods
        .buyTokens(
          new BN(Number(buyAmount) * 1e9)
        )
        .accounts({
          buyer: publicKey,
          sale: salePDA,
          mint: mint,
          buyerTokenAccount: buyerTokenAccount,
          buyerUsdcAccount: buyerUsdcAccount,
          usdcMint: USDC_MINT_DEVNET,
          saleTokenAccount: saleTokenAccountPDA,
          saleUsdcAccount: saleUsdcAccountPDA,
          tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        })
        .rpc();
      
      setResult(`Tokens purchased successfully!
      
Transaction: ${tx}
View on Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
      
      await fetchSaleInfo();
      
    } catch (err) {
      setResult('Error: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <h2>Token Raise</h2>
      <p style={{ fontSize: '14px', color: '#666', marginBottom: '20px' }}>
        Create a token raise on Solana Devnet
      </p>
      
      {saleInfo && (
        <div style={{ 
          marginBottom: '30px', 
          padding: '20px', 
          backgroundColor: '#f5f5f5',
          borderRadius: '8px',
          border: '1px solid #ddd'
        }}>
          <h3>
            Active Sale Info
            <button
              onClick={fetchSaleInfo}
              style={{ 
                marginLeft: '10px',
                padding: '5px 10px',
                fontSize: '12px',
                backgroundColor: '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              Refresh
            </button>
          </h3>
          <p><strong>Status:</strong> {saleInfo.isActive ? 'Active' : 'Inactive'}</p>
          <p><strong>Token Mint:</strong> {saleInfo.mint ? `${saleInfo.mint.slice(0, 8)}...` : 'Loading...'}</p>
          <p><strong>Price per Token:</strong> ${saleInfo.pricePerToken} USDC</p>
          <p><strong>Tokens Sold:</strong> {saleInfo.tokensSold.toFixed(2)} / {saleInfo.tokenAmount.toFixed(2)}</p>
          <p><strong>Remaining:</strong> {saleInfo.tokensRemaining.toFixed(2)} tokens</p>
          
          {/* Buy interface */}
          {saleInfo.isActive && saleInfo.tokensRemaining > 0 && (
            <div style={{ marginTop: '20px' }}>
              <h4>Buy Tokens</h4>
              <p style={{ fontSize: '14px', color: '#666', marginBottom: '10px' }}>
                Total cost: {Number(buyAmount) * saleInfo.pricePerToken} USDC
              </p>
              <div style={{ marginBottom: '10px' }}>
                <input
                  type="number"
                  value={buyAmount}
                  onChange={(e) => setBuyAmount(e.target.value)}
                  style={{ 
                    width: '200px', 
                    padding: '8px', 
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    marginRight: '10px'
                  }}
                  placeholder="Amount to buy"
                  min="0.000001"
                  max={saleInfo.tokensRemaining}
                  step="0.000001"
                />
              </div>
              <button
                onClick={buyTokens}
                disabled={loading || !buyAmount || Number(buyAmount) <= 0}
                style={{ 
                  padding: '10px 20px', 
                  backgroundColor: loading ? '#ccc' : '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold'
                }}
              >
                {loading ? 'Processing...' : 'Buy Tokens'}
              </button>
            </div>
          )}
        </div>
      )}
      
      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
          Mint Address
        </label>
        <input
          type="text"
          value={mintAddress}
          onChange={(e) => setMintAddress(e.target.value)}
          style={{ 
            width: '100%', 
            padding: '8px', 
            border: '1px solid #ddd',
            borderRadius: '4px'
          }}
          placeholder="Enter token mint address"
        />
      </div>

      <div style={{ marginBottom: '15px' }}>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
          Token Amount for Sale
        </label>
        <input
          type="number"
          value={tokenAmount}
          onChange={(e) => setTokenAmount(e.target.value)}
          style={{ 
            width: '100%', 
            padding: '8px', 
            border: '1px solid #ddd',
            borderRadius: '4px'
          }}
          placeholder="100000"
        />
      </div>

      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
          Price per Token (USDC)
        </label>
        <input
          type="number"
          value={pricePerToken}
          onChange={(e) => setPricePerToken(e.target.value)}
          style={{ 
            width: '100%', 
            padding: '8px', 
            border: '1px solid #ddd',
            borderRadius: '4px'
          }}
          placeholder="1"
          step="0.01"
        />
      </div>

      <button
        onClick={createSale}
        disabled={loading || !mintAddress || !tokenAmount || !pricePerToken}
        style={{ 
          width: '100%', 
          padding: '12px', 
          backgroundColor: !loading && mintAddress && tokenAmount && pricePerToken ? '#4CAF50' : '#ccc',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: !loading && mintAddress && tokenAmount && pricePerToken ? 'pointer' : 'not-allowed',
          fontSize: '16px',
          fontWeight: 'bold'
        }}
      >
        {loading ? 'Creating Sale...' : 'Create Sale'}
      </button>

      {result && (
        <pre style={{ 
          marginTop: '20px', 
          padding: '15px', 
          backgroundColor: result.includes('Error') ? '#fee' : '#efe',
          border: result.includes('Error') ? '1px solid #fcc' : '1px solid #cfc',
          borderRadius: '4px',
          fontSize: '12px',
          wordBreak: 'break-all',
          whiteSpace: 'pre-wrap'
        }}>
          {result}
        </pre>
      )}
    </>
  );
}