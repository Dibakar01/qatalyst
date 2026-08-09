// Print the unsubscribe URL for an address: npm run token -- someone@example.com
import { unsubscribeUrl } from '../lib/token.ts'

const email = process.argv[2]
if (!email) throw new Error('usage: npm run token -- someone@example.com')
console.log(unsubscribeUrl(email))
