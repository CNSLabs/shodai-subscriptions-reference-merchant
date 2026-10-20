import { createServer } from 'node:http';
import { createApp } from './app.js';
import { Merchant } from './merchant.js';
import { connectStore } from './store.js';

const port = Number(process.env.PORT || 8787);
const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
const { store, client } = await connectStore(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', process.env.MONGODB_DATABASE || 'shodai_customer_stack');
const merchant = new Merchant(store);
const server = createServer(createApp(merchant, origin));
server.listen(port, '127.0.0.1', () => console.log(`Merchant listening at ${origin}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { server.close(() => void client.close().then(() => process.exit(0))); });
}
