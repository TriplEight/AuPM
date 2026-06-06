import { Contract } from '@algorandfoundation/algorand-typescript'

export class SplitRouter extends Contract {
  hello(name: string): string {
    return `Hello, ${name}`
  }
}
