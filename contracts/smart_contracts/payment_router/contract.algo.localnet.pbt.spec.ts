import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AlgorandClient, microAlgo } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import * as fc from 'fast-check'
import { afterAll, beforeAll, describe, test } from 'vitest'
import {
  APP_SPEC,
  type PaymentRouterClient,
  PaymentRouterFactory,
} from '../artifacts/payment_router/PaymentRouterClient'
import {
  type Call,
  type Coverage,
  expectCoverage,
  type Globals,
  initArb,
  type Label,
  Model,
  type Outcome,
  type Snap,
  type Sut,
  stepArb,
} from './pbt-model'

// Runs the same random sequences as the emulator test against the compiled app on a local
// node. It needs algod on localhost:4001 and kmd on localhost:4002, so the normal test run
// skips it. Run it with AUPM_LOCALNET=1. The node makes a block about every 2.5 seconds and
// each command waits for one, so the sequences run in parallel workers.
const enabled = process.env.AUPM_LOCALNET === '1'
const RUNS = Number(process.env.AUPM_LOCALNET_RUNS ?? 300)
const WORKERS = Number(process.env.AUPM_LOCALNET_WORKERS ?? 12)
const MAX_COMMANDS = Number(process.env.AUPM_LOCALNET_COMMANDS ?? 12)

// Blocks arrive on their own, so a test cannot place a call in a chosen round. The delay is
// short and the window is long: a call that waits long enough succeeds, whatever the round.
const DELAY = 2n
const WINDOW = 1_000_000n

const SHARED_LABELS = ['admin', 'crediter', 'c2', 'stranger', 'ghost'] as const
const FRESH_LABELS = ['alice', 'bob', 'ops', 'treasury', 'ops2', 'trs2'] as const
const TRACKED = [...FRESH_LABELS, 'payTo'] as const

type TestAccount = ReturnType<AlgorandClient['account']['random']>
type Shared = {
  algorand: AlgorandClient
  usdc: bigint
  accounts: Record<(typeof SHARED_LABELS)[number], TestAccount>
  approval: Uint8Array
  clear: Uint8Array
}

let shared: Shared
let note = 0

const noteBytes = () => new TextEncoder().encode(`pbt${note++}`)

// Puya assembles the program with the test's release timing in place of the template values.
// The node does not offer the compile endpoint, so the test cannot use the checked-in TEAL.
const compileProgram = (): { approval: Uint8Array; clear: Uint8Array } => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pbt-router-'))
  execFileSync(
    'pnpm',
    [
      'exec',
      'puya-ts',
      'smart_contracts/payment_router/contract.algo.ts',
      '--output-bytecode',
      '--out-dir',
      out,
      '--cli-template-definitions',
      `RELEASE_DELAY_ROUNDS=${DELAY}`,
      `RELEASE_WINDOW_ROUNDS=${WINDOW}`,
    ],
    { stdio: 'pipe' },
  )
  return {
    approval: new Uint8Array(fs.readFileSync(path.join(out, 'PaymentRouter.approval.bin'))),
    clear: new Uint8Array(fs.readFileSync(path.join(out, 'PaymentRouter.clear.bin'))),
  }
}

describe.runIf(enabled)('PaymentRouter stateful property tests (LocalNet)', () => {
  beforeAll(async () => {
    const algorand = AlgorandClient.defaultLocalNet()
    const dispenser = await algorand.account.localNetDispenser()
    const accounts = {} as Shared['accounts']
    const funding = algorand.newGroup()
    for (const label of SHARED_LABELS) {
      accounts[label] = algorand.account.random()
      funding.addPayment({
        sender: dispenser.addr,
        receiver: accounts[label].addr,
        amount: microAlgo(label === 'admin' ? 1_000_000_000_000 : 10_000_000),
      })
    }
    await funding.send()
    const created = await algorand.send.assetCreate({
      sender: accounts.admin.addr,
      total: 10n ** 15n,
      decimals: 6,
      assetName: 'TESTUSDC',
    })
    shared = { algorand, usdc: created.assetId, accounts, ...compileProgram() }
  }, 300_000)

  const coverage: Coverage = {}

  afterAll(() => {
    console.log('localnet pbt coverage', JSON.stringify(coverage))
    expectCoverage(coverage, ['credit', 'setCrediter', 'lowerPayoutCap', 'announceChange'])
  })

  const oneWorker = (runs: number, seed: number) =>
    fc.assert(
      fc.asyncProperty(
        initArb(),
        fc.commands([stepArb({ hasGhost: true, canJumpPeriod: false }, coverage)], {
          maxCommands: MAX_COMMANDS,
          size: 'large',
        }),
        async (init, cmds) => {
          await fc.asyncModelRun(async () => {
            const real = await LocalNetSut.create(init)
            const model = new Model({
              carryIn: init.carryIn,
              cap: init.cap,
              startRound: real.startRound,
              delay: DELAY,
              window: WINDOW,
              movesUsdc: true,
              hasGhost: true,
            })
            await real.deposit(init.arrived)
            model.deposit(init.arrived)
            return { model, real }
          }, cmds)
        },
      ),
      { numRuns: runs, seed },
    )

  test('random command sequences keep every invariant on the compiled app', async () => {
    const perWorker = Math.ceil(RUNS / WORKERS)
    const seed = Date.now() % 1_000_000
    console.log(`localnet pbt: ${perWorker * WORKERS} sequences, base seed ${seed}`)
    await Promise.all(Array.from({ length: WORKERS }, (_, i) => oneWorker(perWorker, seed + i)))
  }, 7_200_000)
})

const STATE_KEYS: Record<string, string> = {
  crd: 'crediter',
  bsq: 'lastSeq',
  pin: 'poolIn',
  pot: 'poolOut',
  dct: 'declared',
  pdt: 'paid',
  ops: 'ops',
  trs: 'treasury',
  cap: 'cap',
  cpi: 'periodIndex',
  pip: 'paidInPeriod',
  pky: 'pendingKey',
  pvl: 'pendingValue',
  prn: 'pendingRound',
  ato: 'announcedTo',
  arn: 'announcedRound',
  ret: 'retired',
  rdl: 'delay',
  rwn: 'window',
}

const NO_POPULATE = { populateAppCallResources: false, coverAppCallInnerTransactionFees: false }

class LocalNetSut implements Sut {
  readonly movesUsdc = true
  readonly hasGhost = true
  readonly canJumpPeriod = false

  private readonly labels = new Map<string, Label>()

  private constructor(
    private readonly client: PaymentRouterClient,
    private readonly fresh: Record<(typeof TRACKED)[number], TestAccount>,
    readonly startRound: bigint,
  ) {
    for (const l of SHARED_LABELS) this.labels.set(this.addr(l), l)
    for (const l of TRACKED) this.labels.set(this.addr(l), l)
    this.labels.set(client.appAddress.toString(), 'app')
  }

  static async create(init: { carryIn: bigint; cap: bigint }): Promise<LocalNetSut> {
    const { algorand, usdc, accounts } = shared
    const fresh = {} as Record<(typeof TRACKED)[number], TestAccount>
    const setup = algorand.newGroup()
    for (const l of TRACKED) {
      fresh[l] = algorand.account.random()
      setup.addPayment({
        sender: accounts.admin.addr,
        receiver: fresh[l].addr,
        amount: microAlgo(l === 'payTo' ? 1_000_000 : 300_000),
      })
      setup.addAssetOptIn({ sender: fresh[l].addr, assetId: usdc })
    }
    setup.addAssetTransfer({
      sender: accounts.admin.addr,
      receiver: fresh.payTo.addr,
      assetId: usdc,
      amount: init.carryIn,
      note: noteBytes(),
    })
    await setup.send()
    const create = await algorand.send.appCreateMethodCall({
      sender: accounts.admin.addr,
      approvalProgram: shared.approval,
      clearStateProgram: shared.clear,
      schema: {
        globalInts: APP_SPEC.state.schema.global.ints,
        globalByteSlices: APP_SPEC.state.schema.global.bytes,
        localInts: 0,
        localByteSlices: 0,
      },
      extraProgramPages: Math.max(0, Math.ceil(shared.approval.length / 2048) - 1),
      method: algosdk.ABIMethod.fromSignature(
        'createApplication(address,uint64,uint64,address,address,uint64)void',
      ),
      args: [fresh.payTo.addr, usdc, init.carryIn, fresh.ops.addr, fresh.treasury.addr, init.cap],
      note: noteBytes(),
    })
    const appClient = new PaymentRouterFactory({ algorand }).getAppClientById({
      appId: create.appId,
      defaultSender: accounts.admin.addr,
    })
    await appClient.send.setCrediter({
      args: { addr: accounts.crediter.addr.toString() },
      note: noteBytes(),
    })
    await algorand.send.payment({
      sender: fresh.payTo.addr,
      receiver: fresh.payTo.addr,
      amount: microAlgo(0),
      rekeyTo: appClient.appAddress,
    })
    return new LocalNetSut(appClient, fresh, create.confirmation.confirmedRound ?? 0n)
  }

  private account(label: Label): TestAccount {
    if (label === 'app') throw new Error('the app address has no account object')
    return label in this.fresh
      ? this.fresh[label as (typeof TRACKED)[number]]
      : shared.accounts[label as (typeof SHARED_LABELS)[number]]
  }

  private addr(label: Label): string {
    return label === 'app' ? this.client.appAddress.toString() : this.account(label).addr.toString()
  }

  private async holding(label: Label): Promise<bigint> {
    const h = await shared.algorand.client.algod
      .accountAssetInformation(this.addr(label), shared.usdc)
      .do()
    return h.assetHolding?.amount ?? 0n
  }

  private labelOf(addr: string): Label {
    const l = this.labels.get(addr)
    if (!l) throw new Error(`unknown address ${addr}`)
    return l
  }

  async nextRound(): Promise<bigint> {
    const status = await shared.algorand.client.algod.status().do()
    return status.lastRound + 1n
  }

  async deposit(amount: bigint): Promise<void> {
    await shared.algorand.send.assetTransfer({
      sender: shared.accounts.admin.addr,
      receiver: this.fresh.payTo.addr,
      assetId: shared.usdc,
      amount,
      note: noteBytes(),
    })
  }

  async advance(): Promise<void> {
    throw new Error('the LocalNet test does not choose rounds')
  }

  async snapshot(): Promise<Snap> {
    const app = await shared.algorand.client.algod.getApplicationByID(this.client.appId).do()
    const raw: Record<string, bigint | string | boolean> = {
      crediter: 'none',
      lastSeq: 0n,
      pendingKey: '',
      pendingValue: '',
      announcedTo: 'none',
      announcedRound: 0n,
      retired: false,
    }
    let pendingBytes = new Uint8Array()
    for (const kv of app.params.globalState ?? []) {
      const key = Buffer.from(kv.key).toString()
      const name = STATE_KEYS[key]
      if (!name) continue
      if (kv.value.type === 2) raw[name] = kv.value.uint
      else if (key === 'pky') raw[name] = Buffer.from(kv.value.bytes).toString()
      else if (key === 'pvl') pendingBytes = kv.value.bytes
      else raw[name] = this.labelOf(algosdk.encodeAddress(kv.value.bytes))
    }
    if (raw.pendingKey === 'cap') {
      raw.pendingValue = `u:${algosdk.bytesToBigInt(pendingBytes)}`
    } else if (raw.pendingKey !== '') {
      raw.pendingValue = this.labelOf(algosdk.encodeAddress(pendingBytes))
    } else if (pendingBytes.length > 0) {
      raw.pendingValue = 'stale bytes'
    }
    raw.retired = Number(raw.retired) === 1
    const bal: Snap['bal'] = {}
    for (const l of TRACKED) bal[l] = await this.holding(l)
    return { globals: raw as unknown as Globals, bal }
  }

  async exec(call: Call): Promise<Outcome> {
    try {
      return { ok: true, ...(await this.send(call)) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }
    }
  }

  private async send(call: Call): Promise<{ round: bigint; receivers?: Label[] }> {
    const c = this.client
    const sender = shared.accounts[call.sender].addr
    const base = { sender, note: noteBytes(), ...NO_POPULATE }
    const done = (r: { confirmation: { confirmedRound?: bigint } }) => ({
      round: r.confirmation.confirmedRound ?? 0n,
    })
    switch (call.m) {
      case 'setCrediter':
        return done(await c.send.setCrediter({ ...base, args: { addr: this.addr(call.addr) } }))
      case 'lowerPayoutCap':
        return done(await c.send.lowerPayoutCap({ ...base, args: { cap: call.cap } }))
      case 'announceChange':
        return done(
          await c.send.announceChange({
            ...base,
            args: { key: call.key, value: this.valueBytes(call.value) },
          }),
        )
      case 'applyChange':
        return done(await c.send.applyChange({ ...base, args: {} }))
      case 'refs':
        return done(await c.send.refs({ ...base, args: {} }))
      case 'announceRelease':
        return done(await c.send.announceRelease({ ...base, args: { to: this.addr(call.to) } }))
      case 'executeRelease':
        return done(
          await c.send.executeRelease({
            ...base,
            args: {},
            accountReferences: [this.fresh.payTo.addr],
            staticFee: microAlgo(2000),
          }),
        )
      case 'credit':
        return this.credit(call, sender)
    }
  }

  private valueBytes(v: Extract<Call, { m: 'announceChange' }>['value']): Uint8Array {
    if (v.k === 'u64') return new Uint8Array(algosdk.bigIntToBytes(v.v, 8))
    if (v.k === 'addr') return new Uint8Array(algosdk.decodeAddress(this.addr(v.to)).publicKey)
    return new Uint8Array(v.len)
  }

  // One group: credit() and refs() calls that carry the USDC asset and every account that
  // credit() reads or pays, so the group shares them.
  private async credit(
    call: Extract<Call, { m: 'credit' }>,
    sender: algosdk.Address,
  ): Promise<{ round: bigint; receivers: Label[] }> {
    const c = this.client
    const g = (await this.snapshot()).globals
    const touched = [
      ...new Set([
        this.addr('payTo'),
        this.addr(g.ops),
        this.addr(g.treasury),
        ...call.payouts.map((p) => this.addr(p.to)),
      ]),
    ]
    const group = shared.algorand.newGroup()
    group.addAppCallMethodCall(
      await c.params.credit({
        sender,
        note: noteBytes(),
        staticFee: microAlgo(1000 * (call.payouts.length + 5)),
        args: {
          batchSeq: call.seq,
          newTotal: call.newTotal,
          unattributedTotal: call.unattributed,
          treasuryExtra: call.extra,
          payouts: call.payouts.map((p) => [this.addr(p.to), p.amount] as [string, bigint]),
        },
      }),
    )
    for (let i = 0; i < touched.length; i += 4) {
      group.addAppCallMethodCall(
        await c.params.refs({
          sender,
          note: noteBytes(),
          staticFee: microAlgo(0),
          args: {},
          accountReferences: touched.slice(i, i + 4),
          assetReferences: [shared.usdc],
        }),
      )
    }
    const result = await group.send(NO_POPULATE)
    const inners = result.confirmations[0].innerTxns ?? []
    const receivers = inners
      .map((t) => t.txn.txn.assetTransfer?.receiver)
      .filter((r): r is algosdk.Address => r !== undefined)
      .map((r) => this.labelOf(r.toString()))
    return { round: result.confirmations[0].confirmedRound ?? 0n, receivers }
  }
}
