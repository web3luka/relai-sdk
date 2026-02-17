'use client';

import { useState } from 'react';
import { ethers } from 'ethers';
import { createX402Client } from '@relai-fi/x402/client';

const SKALE_BITE_CHAIN_ID = 103698795;
const SKALE_BITE_RPC = 'https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox';

export default function Home() {
  const [status, setStatus] = useState<string>('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string>('');

  // Connect wallet
  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        setError('MetaMask not installed');
        return;
      }

      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      setWalletAddress(address);
      setStatus(`Connected: ${address.slice(0, 6)}...${address.slice(-4)}`);
      
      // Switch to SKALE BITE
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${SKALE_BITE_CHAIN_ID.toString(16)}` }],
        });
      } catch (switchError: any) {
        // Chain not added, add it
        if (switchError.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: `0x${SKALE_BITE_CHAIN_ID.toString(16)}`,
              chainName: 'SKALE BITE V2 Sandbox',
              nativeCurrency: { name: 'sFUEL', symbol: 'sFUEL', decimals: 18 },
              rpcUrls: [SKALE_BITE_RPC],
              blockExplorerUrls: ['https://base-sepolia-testnet-explorer.skalenodes.com:10032'],
            }],
          });
        }
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Test payment flow using SDK client (with auto-approve)
  const testPayment = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    setStatus('Starting payment test...');

    try {
      if (!window.ethereum) {
        throw new Error('MetaMask not installed');
      }

      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();

      // Create x402 client
      setStatus('Creating x402 client...');
      const facilitatorUrl = 'http://localhost:3001/facilitator';
      console.log('🔧 Using facilitator:', facilitatorUrl);
      const client = createX402Client({
        wallets: {
          evm: {
            address,
            signTypedData: (params: any) => signer.signTypedData(params.domain, params.types, params.message),
          },
        },
        facilitatorUrl, // Local facilitator for BITE testing
        evmRpcUrls: {
          'skale-bite': SKALE_BITE_RPC,
        },
        verbose: true,
      });

      // Make payment request - SDK handles everything
      setStatus('Fetching premium API (SDK handles payment)...');
      const response = await client.fetch('http://localhost:3000/api/premium');

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `Request failed: ${response.status}`);
      }

      const responseData = await response.json();

      setStatus('✅ Payment successful!');
      setResult(responseData);

    } catch (err: any) {
      console.error('Payment error:', err);
      setError(err.message);
      setStatus('❌ Payment failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '40px', maxWidth: '800px', margin: '0 auto', fontFamily: 'system-ui' }}>
      <h1>SKALE BITE x402 Payment Test</h1>
      <p style={{ color: '#666' }}>Test x402 payments on SKALE BITE V2 Sandbox using @relai-fi/x402 SDK</p>

      <div style={{ marginTop: '30px', padding: '20px', border: '1px solid #ddd', borderRadius: '8px' }}>
        <h2>1. Connect Wallet</h2>
        {!walletAddress ? (
          <button 
            onClick={connectWallet}
            style={{ 
              padding: '12px 24px', 
              fontSize: '16px', 
              backgroundColor: '#0070f3', 
              color: 'white', 
              border: 'none', 
              borderRadius: '6px', 
              cursor: 'pointer' 
            }}
          >
            Connect MetaMask
          </button>
        ) : (
          <div style={{ color: 'green' }}>✅ Connected: {walletAddress}</div>
        )}
      </div>

      <div style={{ marginTop: '20px', padding: '20px', border: '1px solid #ddd', borderRadius: '8px' }}>
        <h2>2. Test Payment</h2>
        <p style={{ fontSize: '14px', color: '#666' }}>
          Price: $0.01 USD (0.01 USDC)<br/>
          Network: SKALE BITE V2 Sandbox<br/>
          Facilitator: RelAI (gas-free)<br/>
          <strong>Note:</strong> SDK will automatically request approve if needed (first time only)
        </p>
        <button 
          onClick={testPayment}
          disabled={!walletAddress || loading}
          style={{ 
            padding: '12px 24px', 
            fontSize: '16px', 
            backgroundColor: walletAddress && !loading ? '#10b981' : '#ccc', 
            color: 'white', 
            border: 'none', 
            borderRadius: '6px', 
            cursor: walletAddress && !loading ? 'pointer' : 'not-allowed' 
          }}
        >
          {loading ? 'Processing...' : 'Pay & Access Premium API'}
        </button>
      </div>

      {status && (
        <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#f0f9ff', borderRadius: '6px' }}>
          <strong>Status:</strong> {status}
        </div>
      )}

      {error && (
        <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#fee', borderRadius: '6px', color: '#c00' }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#f0fdf4', borderRadius: '6px' }}>
          <h3>✅ Payment Successful!</h3>
          <pre style={{ backgroundColor: '#fff', padding: '10px', borderRadius: '4px', overflow: 'auto' }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}

      <div style={{ marginTop: '40px', padding: '20px', backgroundColor: '#f9fafb', borderRadius: '8px' }}>
        <h3>How it works:</h3>
        <ol style={{ lineHeight: '1.8' }}>
          <li>Frontend calls <code>/api/premium</code> without payment</li>
          <li>Backend returns <code>402 Payment Required</code> with payment details</li>
          <li>Frontend signs EIP-3009 authorization with MetaMask</li>
          <li>Frontend sends signed payment to backend</li>
          <li>Backend calls RelAI facilitator to settle payment on SKALE BITE</li>
          <li>Backend returns premium data if payment successful</li>
        </ol>
      </div>
    </div>
  );
}
