import { Prisma } from "@prisma/client";
import { is_low_stock_qty, RuleError } from "./sale-rules";

type Tx = Prisma.TransactionClient;

/**
 * Takes `quantity` units out of stock. The stock check is part of the
 * update itself, so two terminals selling the last unit at the same moment
 * can't both succeed.
 */
export async function take_stock(
  tx: Tx,
  product_id: string,
  product_name: string,
  quantity: number,
) {
  try {
    const product = await tx.product.update({
      where: { id: product_id, stock_qty: { gte: quantity } },
      data: { stock_qty: { decrement: quantity } },
      select: { stock_qty: true, is_low_stock: true },
    });
    await sync_low_stock(tx, product_id, product);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new RuleError(
        `Not enough stock for "${product_name}". Please refresh and try again.`,
      );
    }
    throw error;
  }
}

export async function return_stock(
  tx: Tx,
  product_id: string,
  quantity: number,
) {
  const product = await tx.product.update({
    where: { id: product_id },
    data: { stock_qty: { increment: quantity } },
    select: { stock_qty: true, is_low_stock: true },
  });
  await sync_low_stock(tx, product_id, product);
}

/** Keeps the stored is_low_stock flag in line with the new stock level. */
async function sync_low_stock(
  tx: Tx,
  product_id: string,
  product: { stock_qty: number; is_low_stock: boolean },
) {
  const low = is_low_stock_qty(product.stock_qty);
  if (low !== product.is_low_stock) {
    await tx.product.update({
      where: { id: product_id },
      data: { is_low_stock: low },
    });
  }
}
