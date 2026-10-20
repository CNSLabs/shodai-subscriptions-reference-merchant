import { MongoClient, type Collection, type Db } from 'mongodb';

export type Customer = { _id: string; createdAt: Date; note: string };

export class Store {
  readonly customers: Collection<Customer>;

  constructor(readonly db: Db) {
    this.customers = db.collection<Customer>('customers');
  }

  async customer(wallet: string): Promise<Customer> {
    return (await this.customers.findOneAndUpdate(
      { _id: wallet.toLowerCase() },
      { $setOnInsert: { createdAt: new Date(), note: '' } },
      { upsert: true, returnDocument: 'after' },
    ))!;
  }
}

export async function connectStore(uri: string, name: string): Promise<{ store: Store; client: MongoClient }> {
  const client = await new MongoClient(uri).connect();
  return { store: new Store(client.db(name)), client };
}
