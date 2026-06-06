import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { SplitRouterFactory } from '../artifacts/split_router/SplitRouterClient'

export async function deploy() {
  console.log('=== Deploying SplitRouter (stub) ===')
  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')
  const factory = algorand.client.getTypedAppFactory(SplitRouterFactory, {
    defaultSender: deployer.addr,
  })
  const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })
  console.log(`APP_ID=${appClient.appClient.appId}`)
  console.log(`APP_ADDRESS=${appClient.appAddress}`)
}
