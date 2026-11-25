import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  options?: Record<string, string[]>;
}

export interface OrderItem {
  productId: string;
  quantity: number;
  options?: Record<string, string>;
}

export interface Order {
  id: string;
  chatId: string;
  customerName: string;
  address: string;
  items: (OrderItem & { name: string; unitPrice: number })[];
  total: number;
  notes?: string;
  createdAt: string;
  status: "pending";
}

const PRODUCTS_FILE = "data/products.json";
const ORDERS_FILE = "data/orders.json";

export async function loadProducts(): Promise<Product[]> {
  return JSON.parse(await readFile(PRODUCTS_FILE, "utf8")) as Product[];
}

export async function searchProducts(query: string): Promise<Product[]> {
  const products = await loadProducts();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return products;
  return products.filter((p) => {
    const haystack = `${p.name} ${p.description} ${p.id}`.toLowerCase();
    return terms.some((t) => haystack.includes(t));
  });
}

async function loadOrders(): Promise<Order[]> {
  try {
    return JSON.parse(await readFile(ORDERS_FILE, "utf8")) as Order[];
  } catch {
    return [];
  }
}

// Serialize writes so two chats ordering at once don't clobber the file.
let writeChain: Promise<unknown> = Promise.resolve();

export function createOrder(input: {
  chatId: string;
  customerName: string;
  address: string;
  items: OrderItem[];
  notes?: string;
}): Promise<Order> {
  const job = writeChain.then(async () => {
    const products = await loadProducts();
    const items = input.items.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      if (!product) throw new Error(`Unknown product: ${item.productId}`);
      if (product.stock < item.quantity) {
        throw new Error(`Not enough stock for ${product.name} (have ${product.stock})`);
      }
      return { ...item, name: product.name, unitPrice: product.price };
    });

    const order: Order = {
      id: randomUUID().slice(0, 8).toUpperCase(),
      chatId: input.chatId,
      customerName: input.customerName,
      address: input.address,
      items,
      total: items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0),
      notes: input.notes,
      createdAt: new Date().toISOString(),
      status: "pending",
    };

    for (const item of items) {
      const product = products.find((p) => p.id === item.productId)!;
      product.stock -= item.quantity;
    }
    await writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2));
    const orders = await loadOrders();
    orders.push(order);
    await writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2));
    return order;
  });
  writeChain = job.catch(() => undefined);
  return job;
}
