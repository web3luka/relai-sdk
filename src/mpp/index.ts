// EVM MPP method — generic for any EVM chain (SKALE, Base, Polygon, etc.)
export { charge as evmChargeMethod } from './evm-method.js'
export { evmCharge as evmChargeServer, type EvmChargeConfig } from './evm-server.js'
export { evmCharge as evmChargeClient, type EvmChargeClientConfig } from './evm-client.js'

// Bridge MPP method — cross-chain payments via RelAI bridge
export { charge as bridgeChargeMethod } from './bridge-method.js'
export { bridgeCharge as bridgeChargeServer, type BridgeChargeConfig } from './bridge-server.js'
export { bridgeCharge as bridgeChargeClient, type BridgeChargeClientConfig } from './bridge-client.js'

// Client-side bridge (transparent cross-chain — server doesn't need bridge config)
export { evmChargeWithBridge, type EvmChargeWithBridgeConfig } from './with-bridge.js'

// Shared utilities
export { verifyErc20Transfer, type VerifyErc20TransferOptions } from './verify-erc20.js'
export { verifySplTransfer, type VerifySplTransferOptions } from './verify-spl.js'
