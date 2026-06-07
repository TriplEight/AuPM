import { beforeAll, expect } from 'vitest'
import { addEqualityTesters } from '@algorandfoundation/algorand-typescript-testing'

beforeAll(() => {
  addEqualityTesters({ expect })
})
