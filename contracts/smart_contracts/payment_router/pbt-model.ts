// Shared model, command generators and invariant checks for the PaymentRouter
// property tests. The emulator test and the LocalNet test both drive a `Sut`
// (system under test) with the same random command sequences and compare it
// with `Model`, a plain bigint re-statement of the intended behaviour.
import * as fc from 'fast-check'
import { expect } from 'vitest'

export const U64_MAX = (1n << 64n) - 1n
export const CAP_PERIOD = 30_000n
export const OPS_NUM = 50n
export const CUT_NUM = 200n
export const SPLIT_DEN = 1000n

export type Label =
  | 'admin'
  | 'crediter'
  | 'c2'
  | 'stranger'
  | 'alice'
  | 'bob'
  | 'ops'
  | 'treasury'
  | 'ops2'
  | 'trs2'
  | 'ghost'
  | 'payTo'
  | 'app'

export const SENDERS = ['admin', 'crediter', 'c2', 'stranger'] as const
export type Sender = (typeof SENDERS)[number]
const RECEIVERS = ['alice', 'bob', 'ops', 'treasury', 'payTo', 'app', 'admin'] as const
const NEW_ADDRESSES = ['ops2', 'trs2', 'alice', 'bob'] as const
const ADMIN_TARGETS = ['c2', 'stranger', 'crediter', 'crediter', 'crediter', 'alice'] as const
const RAW_LENGTHS = [0, 1, 7, 9, 31, 33] as const

export type Spec = { k: 'abs'; v: bigint } | { k: 'frac'; permille: number; d: bigint }
export type PayoutDraft = { to: Label; amt: Spec }
export type ChangeValue =
  | { k: 'u64'; v: Spec }
  | { k: 'addr'; to: Label }
  | { k: 'raw'; len: number }

export type Draft =
  | { m: 'setCrediter'; sender: Sender; addr: Label }
  | { m: 'lowerPayoutCap'; sender: Sender; cap: Spec }
  | { m: 'announceChange'; sender: Sender; key: string; value: ChangeValue }
  | { m: 'applyChange'; sender: Sender }
  | { m: 'refs'; sender: Sender }
  | { m: 'announceRelease'; sender: Sender; to: Label }
  | { m: 'executeRelease'; sender: Sender }
  | {
      m: 'credit'
      sender: Sender
      seq: 'next' | 'same' | 'skip' | 'zero'
      newTotal: Spec
      unattributed: Spec
      extra: Spec
      payouts: PayoutDraft[]
    }

// A draft with every relative amount turned into a concrete bigint.
export type Call =
  | { m: 'setCrediter'; sender: Sender; addr: Label }
  | { m: 'lowerPayoutCap'; sender: Sender; cap: bigint }
  | { m: 'announceChange'; sender: Sender; key: string; value: CallValue }
  | { m: 'applyChange'; sender: Sender }
  | { m: 'refs'; sender: Sender }
  | { m: 'announceRelease'; sender: Sender; to: Label }
  | { m: 'executeRelease'; sender: Sender }
  | {
      m: 'credit'
      sender: Sender
      seq: bigint
      newTotal: bigint
      unattributed: bigint
      extra: bigint
      payouts: { to: Label; amount: bigint }[]
    }
export type CallValue =
  | { k: 'u64'; v: bigint }
  | { k: 'addr'; to: Label }
  | { k: 'raw'; len: number }

export type Globals = {
  crediter: Label | 'none'
  lastSeq: bigint
  poolIn: bigint
  poolOut: bigint
  declared: bigint
  paid: bigint
  ops: Label
  treasury: Label
  cap: bigint
  periodIndex: bigint
  paidInPeriod: bigint
  pendingKey: string
  pendingValue: string
  pendingRound: bigint
  announcedTo: Label | 'none'
  announcedRound: bigint
  retired: boolean
  delay: bigint
  window: bigint
}

export type Snap = { globals: Globals; bal: Partial<Record<Label, bigint>> }
export type Outcome = { ok: boolean; error?: string; receivers?: Label[]; round?: bigint }

export interface Sut {
  // True when the system moves USDC for inner transfers (a chain does, the emulator does not).
  readonly movesUsdc: boolean
  // True on a chain: the ghost label is an account with no USDC opt-in, rounds advance on
  // their own and the test sets a release delay that no sequence reaches.
  readonly hasGhost: boolean
  readonly canJumpPeriod: boolean
  nextRound(): Promise<bigint>
  exec(call: Call): Promise<Outcome>
  deposit(amount: bigint): Promise<void>
  advance(rounds: bigint): Promise<void>
  snapshot(): Promise<Snap>
}

export type ModelInit = {
  carryIn: bigint
  cap: bigint
  startRound: bigint
  delay: bigint
  window: bigint
  movesUsdc: boolean
  hasGhost: boolean
}

const u64 = (x: bigint): bigint => {
  if (x > U64_MAX || x < 0n) throw new RangeError('uint64 overflow')
  return x
}

const resolveSpec = (s: Spec, base: bigint): bigint => {
  if (s.k === 'abs') return s.v
  const v = (base * BigInt(s.permille)) / 1000n + s.d
  if (v < 0n) return 0n
  return v > U64_MAX ? U64_MAX : v
}

const itobLabel = (v: bigint) => `u:${v}`

export class Model {
  g: Globals
  bal: Partial<Record<Label, bigint>> = {}
  arrivals: bigint
  rekeyed = false

  constructor(readonly init: ModelInit) {
    this.arrivals = init.carryIn
    this.bal.payTo = init.carryIn
    this.g = {
      crediter: 'crediter',
      lastSeq: 0n,
      poolIn: init.carryIn,
      poolOut: 0n,
      declared: init.carryIn,
      paid: 0n,
      ops: 'ops',
      treasury: 'treasury',
      cap: init.cap,
      periodIndex: init.startRound / CAP_PERIOD,
      paidInPeriod: 0n,
      pendingKey: '',
      pendingValue: '',
      pendingRound: 0n,
      announcedTo: 'none',
      announcedRound: 0n,
      retired: false,
      delay: init.delay,
      window: init.window,
    }
  }

  balance(l: Label): bigint {
    return this.bal[l] ?? 0n
  }

  deposit(amount: bigint): void {
    this.bal.payTo = this.balance('payTo') + amount
    this.arrivals += amount
  }

  // Concrete values for the relative amounts of a draft, from the current model state.
  resolve(d: Draft): Call {
    const g = this.g
    const undeclared = this.balance('payTo') + g.paid - g.declared
    const room = g.poolIn - g.poolOut
    switch (d.m) {
      case 'lowerPayoutCap':
        return { ...d, cap: resolveSpec(d.cap, g.cap) }
      case 'announceChange': {
        const v = d.value
        const value: CallValue = v.k === 'u64' ? { k: 'u64', v: resolveSpec(v.v, g.cap) } : v
        return { ...d, value }
      }
      case 'credit': {
        const seq = { next: g.lastSeq + 1n, same: g.lastSeq, skip: g.lastSeq + 2n, zero: 0n }
        const fresh = undeclared > 0n ? undeclared : 0n
        const newTotal = resolveSpec(d.newTotal, fresh)
        const poolRoom = room + (newTotal - (newTotal * (OPS_NUM + CUT_NUM)) / SPLIT_DEN)
        const headroom = g.cap > g.paidInPeriod ? g.cap - g.paidInPeriod : 0n
        const payBase = poolRoom < headroom ? poolRoom : headroom
        return {
          m: 'credit',
          sender: d.sender,
          seq: seq[d.seq],
          newTotal,
          unattributed: resolveSpec(d.unattributed, fresh),
          extra: resolveSpec(d.extra, poolRoom),
          payouts: d.payouts.map((p) => ({ to: p.to, amount: resolveSpec(p.amt, payBase) })),
        }
      }
      default:
        return d
    }
  }

  private isAdmin = (s: Sender) => s === 'admin'

  // Applies the call when the contract should accept it. Returns false and keeps the
  // state when the contract should reject it.
  apply(call: Call, round: bigint): boolean {
    switch (call.m) {
      case 'setCrediter':
        return this.isAdmin(call.sender) && this.set({ crediter: call.addr })
      case 'lowerPayoutCap':
        return this.isAdmin(call.sender) && call.cap <= this.g.cap && this.set({ cap: call.cap })
      case 'announceChange':
        return this.announceChange(call, round)
      case 'applyChange':
        return this.applyChange(call, round)
      case 'refs':
        return true
      case 'announceRelease':
        return (
          this.isAdmin(call.sender) && this.set({ announcedTo: call.to, announcedRound: round })
        )
      case 'executeRelease':
        return this.executeRelease(call, round)
      case 'credit':
        return this.credit(call, round)
    }
  }

  private set(patch: Partial<Globals>): true {
    Object.assign(this.g, patch)
    return true
  }

  private announceChange(c: Extract<Call, { m: 'announceChange' }>, round: bigint): boolean {
    if (!this.isAdmin(c.sender) || !['cap', 'ops', 'trs'].includes(c.key)) return false
    const length = c.value.k === 'u64' ? 8 : c.value.k === 'addr' ? 32 : c.value.len
    if (length !== (c.key === 'cap' ? 8 : 32)) return false
    const pendingValue =
      c.value.k === 'u64' ? itobLabel(c.value.v) : c.value.k === 'addr' ? c.value.to : 'raw'
    return this.set({ pendingKey: c.key, pendingValue, pendingRound: round })
  }

  private applyChange(c: Extract<Call, { m: 'applyChange' }>, round: bigint): boolean {
    const g = this.g
    if (!this.isAdmin(c.sender) || g.pendingKey === '') return false
    const from = g.pendingRound + g.delay
    if (round < from || round >= from + g.window) return false
    const patch: Partial<Globals> =
      g.pendingKey === 'cap'
        ? { cap: BigInt(g.pendingValue.slice(2)) }
        : g.pendingKey === 'ops'
          ? { ops: g.pendingValue as Label }
          : { treasury: g.pendingValue as Label }
    return this.set({ ...patch, pendingKey: '', pendingValue: '', pendingRound: 0n })
  }

  private executeRelease(c: Extract<Call, { m: 'executeRelease' }>, round: bigint): boolean {
    const g = this.g
    if (!this.isAdmin(c.sender) || g.announcedTo === 'none') return false
    const from = g.announcedRound + g.delay
    if (round < from || round >= from + g.window) return false
    // A chain rejects the rekey when payTo no longer belongs to the app.
    if (this.init.movesUsdc && this.rekeyed) return false
    this.rekeyed = true
    return this.set({ retired: true })
  }

  private credit(c: Extract<Call, { m: 'credit' }>, round: bigint): boolean {
    try {
      return this.creditChecked(c, round)
    } catch (e) {
      if (e instanceof RangeError) return false
      throw e
    }
  }

  private creditChecked(c: Extract<Call, { m: 'credit' }>, round: bigint): boolean {
    const g = this.g
    if (g.retired || c.sender !== g.crediter || c.seq !== g.lastSeq + 1n) return false
    let payoutsTotal = 0n
    for (const p of c.payouts) {
      if (p.amount === 0n || p.to === 'payTo' || p.to === 'app') return false
      payoutsTotal = u64(payoutsTotal + p.amount)
    }
    const period = round / CAP_PERIOD
    const paidBefore = period === g.periodIndex ? g.paidInPeriod : 0n
    const paidNow = u64(paidBefore + payoutsTotal)
    if (paidNow > g.cap) return false

    const ops = u64(c.newTotal * OPS_NUM) / SPLIT_DEN
    const cut = u64(c.newTotal * CUT_NUM) / SPLIT_DEN
    const treasuryAmount = u64(u64(cut + c.extra) + c.unattributed)
    const batchTotal = u64(u64(ops + treasuryAmount) + payoutsTotal)
    const held = this.balance('payTo')
    if (batchTotal > held) return false

    const newPoolIn = u64(g.poolIn + (c.newTotal - ops - cut))
    const newPoolOut = u64(u64(g.poolOut + payoutsTotal) + c.extra)
    if (newPoolOut > newPoolIn) return false

    const transfers = this.transfers(c, ops, treasuryAmount)
    if (transfers.some((t) => t.to === 'ghost' && this.init.hasGhost)) return false
    const newPaid = u64(g.paid + batchTotal)
    const newDeclared = u64(u64(g.declared + c.newTotal) + c.unattributed)
    const heldAfter = this.init.movesUsdc ? held - batchTotal : held
    if (newDeclared > u64(heldAfter + newPaid)) return false

    this.moveUsdc(transfers)
    return this.set({
      periodIndex: period,
      paidInPeriod: paidNow,
      poolIn: newPoolIn,
      poolOut: newPoolOut,
      declared: newDeclared,
      paid: newPaid,
      lastSeq: c.seq,
    })
  }

  transfers(
    c: Extract<Call, { m: 'credit' }>,
    ops: bigint,
    treasuryAmount: bigint,
  ): { to: Label; amount: bigint }[] {
    const all = [
      ...c.payouts.map((p) => ({ to: p.to, amount: p.amount })),
      { to: this.g.ops, amount: ops },
      { to: this.g.treasury, amount: treasuryAmount },
    ]
    return all.filter((t) => t.amount > 0n)
  }

  moveUsdc(transfers: { to: Label; amount: bigint }[]): void {
    for (const t of transfers) {
      this.bal.payTo = this.balance('payTo') - t.amount
      this.bal[t.to] = this.balance(t.to) + t.amount
    }
  }
}

// --- generators -------------------------------------------------------------------

const spec = (): fc.Arbitrary<Spec> =>
  fc.oneof(
    {
      weight: 6,
      arbitrary: fc.record({
        k: fc.constant('frac' as const),
        permille: fc.oneof(fc.constant(1000), fc.constant(0), fc.integer({ min: 0, max: 1100 })),
        d: fc.constantFrom(-1n, 0n, 0n, 1n),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        k: fc.constant('abs' as const),
        v: fc.oneof(fc.bigInt({ min: 0n, max: 3n }), fc.bigInt({ min: 0n, max: 2_000_000n })),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        k: fc.constant('abs' as const),
        v: fc.constantFrom(U64_MAX, 1n << 63n, U64_MAX / 50n, U64_MAX / 50n + 1n),
      }),
    },
  )

export const commandDrafts = (opts: { hasGhost: boolean }): fc.Arbitrary<Draft> => {
  const sender = fc.constantFrom<Sender>(...SENDERS)
  const adminSender = fc.oneof(
    { weight: 6, arbitrary: fc.constant<Sender>('admin') },
    { weight: 1, arbitrary: sender },
  )
  const creditSender = fc.oneof(
    { weight: 6, arbitrary: fc.constant<Sender>('crediter') },
    { weight: 1, arbitrary: sender },
  )
  const receivers = [
    ...RECEIVERS.filter((r) => !opts.hasGhost || r !== 'admin'),
    ...(opts.hasGhost ? (['ghost'] as const) : []),
  ]
  const addresses = [...NEW_ADDRESSES, ...(opts.hasGhost ? (['ghost'] as const) : [])]
  const payout: fc.Arbitrary<PayoutDraft> = fc.record({
    to: fc.oneof(
      { weight: 5, arbitrary: fc.constantFrom<Label>('alice', 'bob') },
      { weight: 1, arbitrary: fc.constantFrom<Label>(...receivers) },
    ),
    amt: spec(),
  })
  const changeValue: fc.Arbitrary<ChangeValue> = fc.oneof(
    { weight: 3, arbitrary: spec().map((v): ChangeValue => ({ k: 'u64', v })) },
    {
      weight: 3,
      arbitrary: fc.constantFrom<Label>(...addresses).map((to): ChangeValue => ({ k: 'addr', to })),
    },
    {
      weight: 1,
      arbitrary: fc.constantFrom(...RAW_LENGTHS).map((len): ChangeValue => ({ k: 'raw', len })),
    },
  )
  const tame = (max: number): fc.Arbitrary<Spec> =>
    fc.record({
      k: fc.constant('frac' as const),
      permille: fc.integer({ min: 1, max }),
      d: fc.constant(0n),
    })
  const tameCredit: fc.Arbitrary<Draft> = fc.record({
    m: fc.constant('credit' as const),
    sender: fc.constant<Sender>('crediter'),
    seq: fc.constant('next' as const),
    newTotal: tame(1000),
    unattributed: tame(100),
    extra: tame(100),
    payouts: fc.array(fc.record({ to: fc.constantFrom<Label>('alice', 'bob'), amt: tame(300) }), {
      maxLength: 3,
    }),
  })
  return fc.oneof(
    { weight: 14, arbitrary: tameCredit },
    {
      weight: 6,
      arbitrary: fc.record({
        m: fc.constant('credit' as const),
        sender: creditSender,
        seq: fc.constantFrom(
          'next',
          'next',
          'next',
          'next',
          'next',
          'next',
          'next',
          'same',
          'skip',
          'zero',
        ),
        newTotal: spec(),
        unattributed: spec(),
        extra: spec(),
        payouts: fc.array(payout, { maxLength: 4 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        m: fc.constant('setCrediter' as const),
        sender: adminSender,
        addr: fc.constantFrom<Label>(...ADMIN_TARGETS),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        m: fc.constant('lowerPayoutCap' as const),
        sender: adminSender,
        cap: spec(),
      }),
    },
    {
      weight: 6,
      arbitrary: fc.record({
        m: fc.constant('announceChange' as const),
        sender: adminSender,
        key: fc.constantFrom(
          'cap',
          'cap',
          'ops',
          'trs',
          'xyz',
          '',
          'abc',
          'ca',
          'op',
          'tr',
          'capx',
        ),
        value: changeValue,
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({ m: fc.constant('applyChange' as const), sender: adminSender }),
    },
    { weight: 1, arbitrary: fc.record({ m: fc.constant('refs' as const), sender }) },
    {
      weight: 2,
      arbitrary: fc.record({
        m: fc.constant('announceRelease' as const),
        sender: adminSender,
        to: fc.constantFrom<Label>('c2', 'stranger', 'alice'),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ m: fc.constant('executeRelease' as const), sender: adminSender }),
    },
  )
}

export type EnvDraft =
  | { e: 'deposit'; amount: bigint }
  | { e: 'advance'; rounds: bigint }
  | { e: 'jump'; edge: 'before' | 'at' }
  | { e: 'seek'; what: 'change' | 'release'; k: bigint; run: boolean; sender: Sender }
  | { e: 'call'; d: Draft }

export const envDrafts = (opts: {
  hasGhost: boolean
  canJumpPeriod: boolean
}): fc.Arbitrary<EnvDraft> =>
  fc.oneof(
    { weight: 22, arbitrary: commandDrafts(opts).map((d): EnvDraft => ({ e: 'call', d })) },
    {
      weight: 4,
      arbitrary: fc
        .oneof(fc.bigInt({ min: 0n, max: 3_000_000n }), fc.constantFrom(1n, 1000n, 100_000n))
        .map((amount): EnvDraft => ({ e: 'deposit', amount })),
    },
    ...(opts.hasGhost
      ? []
      : [
          {
            weight: 6,
            arbitrary: fc
              .oneof(fc.bigInt({ min: 1n, max: 2n }), fc.bigInt({ min: 1n, max: 6n }))
              .map((rounds): EnvDraft => ({ e: 'advance', rounds })),
          },
          {
            weight: 12,
            arbitrary: fc
              .record({
                what: fc.constantFrom<'change' | 'release'>('change', 'release'),
                k: fc.bigInt({ min: -1n, max: 4n }),
                run: fc.boolean(),
                sender: fc.oneof(
                  { weight: 3, arbitrary: fc.constant<Sender>('admin') },
                  { weight: 1, arbitrary: fc.constantFrom<Sender>(...SENDERS) },
                ),
              })
              .map((v): EnvDraft => ({ e: 'seek', ...v })),
          },
        ]),
    ...(opts.canJumpPeriod
      ? [
          {
            weight: 2,
            arbitrary: fc
              .constantFrom<'before' | 'at'>('before', 'at')
              .map((edge): EnvDraft => ({ e: 'jump', edge })),
          },
        ]
      : []),
  )

// --- commands and invariants -------------------------------------------------------

export type Coverage = Record<string, { ok: number; fail: number }>

const windowOpen = (round: bigint, since: bigint, g: Globals) =>
  round >= since + g.delay && round < since + g.delay + g.window

function checkTransition(
  call: Call,
  out: Outcome,
  before: Globals,
  after: Globals,
  round: bigint,
  app: Label,
): void {
  // 1. The pool never pays out more than it took in.
  expect(after.poolOut, 'poolOut <= poolIn').toBeLessThanOrEqual(after.poolIn)
  // 8. A failed call changes nothing.
  if (!out.ok) {
    expect(after, `failed ${call.m} changed global state`).toEqual(before)
    return
  }
  if (call.m === 'credit') {
    // 3. A successful credit leaves the period total under the cap.
    expect(after.paidInPeriod, 'paidInPeriod <= payoutCap').toBeLessThanOrEqual(after.cap)
    // 4. The batch number moves by exactly one.
    expect(after.lastSeq).toBe(before.lastSeq + 1n)
    // 5. No payout goes to payTo or to the app address.
    for (const r of out.receivers ?? []) expect(['payTo', app]).not.toContain(r)
  } else {
    expect(after.lastSeq).toBe(before.lastSeq)
  }
  // 6. A cap rise or an address change applies only after the delay, inside the window.
  const changed =
    after.cap > before.cap || after.ops !== before.ops || after.treasury !== before.treasury
  if (changed) {
    expect(call.m, 'cap rise or address change outside applyChange').toBe('applyChange')
    expect(windowOpen(round, before.pendingRound, before)).toBe(true)
  }
  // 7. Release runs only for the admin and only inside the window.
  if (after.retired && !before.retired) {
    expect(call).toMatchObject({ m: 'executeRelease', sender: 'admin' })
    expect(before.announcedTo).not.toBe('none')
    expect(windowOpen(round, before.announcedRound, before)).toBe(true)
  }
  if (before.retired) expect(after.retired).toBe(true)
}

class Step implements fc.AsyncCommand<Model, Sut> {
  constructor(
    readonly env: EnvDraft,
    readonly coverage: Coverage,
  ) {}

  check(): boolean {
    return true
  }

  async run(m: Model, sut: Sut): Promise<void> {
    const env = this.env
    if (env.e === 'deposit') {
      await sut.deposit(env.amount)
      m.deposit(env.amount)
    } else if (env.e === 'advance') {
      await sut.advance(env.rounds)
    } else if (env.e === 'seek') {
      const since = env.what === 'change' ? m.g.pendingRound : m.g.announcedRound
      const behind = since + m.g.delay + env.k - (await sut.nextRound())
      if (behind > 0n) await sut.advance(behind)
      if (env.run) {
        const m2 = env.what === 'change' ? 'applyChange' : 'executeRelease'
        await this.runCall(m, sut, { m: m2, sender: env.sender })
      }
    } else if (env.e === 'jump') {
      const r = await sut.nextRound()
      const edge = (r / CAP_PERIOD + 1n) * CAP_PERIOD - (env.edge === 'before' ? 1n : 0n)
      await sut.advance(edge - r)
    } else {
      await this.runCall(m, sut, m.resolve(env.d))
    }
    await this.checkState(m, sut)
  }

  private async runCall(m: Model, sut: Sut, call: Call): Promise<void> {
    const before = (await sut.snapshot()).globals
    const attempt = await sut.nextRound()
    const out = await sut.exec(call)
    const round = out.round ?? attempt
    const expected = m.apply(call, round)
    expect(
      out.ok,
      `${call.m} accepted=${out.ok} (${out.error ?? ''}), model says ${expected}`,
    ).toBe(expected)
    const after = (await sut.snapshot()).globals
    const cov = this.coverage[call.m] ?? { ok: 0, fail: 0 }
    this.coverage[call.m] = cov
    if (out.ok) cov.ok++
    else cov.fail++
    const why = `${call.m}!${(out.error ?? '').slice(0, 40)}`
    if (!out.ok) this.coverage[why] = { ok: 0, fail: (this.coverage[why]?.fail ?? 0) + 1 }
    checkTransition(call, out, before, after, round, 'app')
  }

  private async checkState(m: Model, sut: Sut): Promise<void> {
    const snap = await sut.snapshot()
    expect(snap.globals).toEqual(m.g)
    for (const l of Object.keys(m.bal) as Label[]) {
      expect(snap.bal[l] ?? 0n, `balance of ${l}`).toBe(m.balance(l))
    }
    if (sut.movesUsdc) {
      // 2b. The declared total never exceeds the USDC that arrived at payTo.
      expect(snap.globals.declared).toBeLessThanOrEqual(m.arrivals)
      // 2. The declared total never exceeds the USDC in payTo plus the USDC paid out.
      expect(snap.globals.declared).toBeLessThanOrEqual(m.balance('payTo') + snap.globals.paid)
    }
  }

  toString(): string {
    return JSON.stringify(this.env, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))
  }
}

export const stepArb = (
  opts: { hasGhost: boolean; canJumpPeriod: boolean },
  coverage: Coverage,
): fc.Arbitrary<fc.AsyncCommand<Model, Sut>> =>
  envDrafts(opts).map((env) => new Step(env, coverage))

export const initArb = (): fc.Arbitrary<{ carryIn: bigint; cap: bigint; arrived: bigint }> =>
  fc.record({
    arrived: fc.constantFrom(0n, 2_000_000n, 2_000_000n, 8_000_000n),
    carryIn: fc.constantFrom(0n, 0n, 1_000_000n, 5_000_000n),
    cap: fc.constantFrom(0n, 400_000n, 3_000_000n, U64_MAX),
  })

export const expectCoverage = (coverage: Coverage, succeeds: string[]): void => {
  for (const m of succeeds) {
    expect(coverage[m]?.ok ?? 0, `${m} never succeeded`).toBeGreaterThan(0)
  }
  for (const m of ['credit', 'setCrediter', 'lowerPayoutCap', 'announceChange', 'applyChange']) {
    expect(coverage[m]?.fail ?? 0, `${m} never failed`).toBeGreaterThan(0)
  }
}

export const EMULATOR_SUCCESSES = [
  'credit',
  'setCrediter',
  'lowerPayoutCap',
  'announceChange',
  'applyChange',
  'announceRelease',
  'executeRelease',
]
