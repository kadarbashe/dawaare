"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { requireSession, AuthError } from "@/lib/auth-guard";
import {
  is_payment_method,
  parse_cart,
  round_money,
  RuleError,
  settle_payment,
} from "@/lib/sale-rules";
import { take_stock } from "@/lib/stock";

export type ActionState = {
  success?: boolean;
  error?: string;
} | null;

export async function submitSale(
  prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const session = await requireSession();
    const sellerId = session.user.id;

    const lines = parse_cart(formData.get("cart_payload") as string | null);

    const paymentMethod = formData.get("payment_method") || "CASH";
    if (!is_payment_method(paymentMethod)) {
      return { error: "Choose a payment method." };
    }

    const rawCustomerId = formData.get("customer_id");
    const customerId =
      typeof rawCustomerId === "string" && rawCustomerId !== ""
        ? rawCustomerId
        : null;

    const rawNotes = formData.get("notes");
    const notes =
      typeof rawNotes === "string" && rawNotes.trim() !== "" ? rawNotes : null;

    // The cashier may adjust prices at the till, so the price comes from the
    // cart; the cost floor below is checked against the database.
    const grandTotal = round_money(
      lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0),
    );

    const settlement = settle_payment({
      total: grandTotal,
      amount_paid_input: formData.get("amount_paid") as string | null,
      has_customer: customerId !== null,
      repayment_date_input: formData.get("repayment_date") as string | null,
    });

    await prisma.$transaction(
      async (tx) => {
        if (customerId) {
          const customer = await tx.customer.findUnique({
            where: { id: customerId },
            select: { id: true },
          });
          if (!customer) throw new RuleError("Customer not found.");
        }

        const products = await tx.product.findMany({
          where: { id: { in: lines.map((line) => line.product_id) } },
          select: { id: true, name: true, cost_price: true },
        });
        const productsById = new Map(products.map((p) => [p.id, p]));

        for (const line of lines) {
          const product = productsById.get(line.product_id);
          if (!product) {
            throw new RuleError(
              "A product in the cart no longer exists. Refresh and try again.",
            );
          }
          if (line.unit_price < round_money(product.cost_price)) {
            throw new RuleError(
              `"${product.name}" can't be sold below its cost price ($${product.cost_price.toFixed(2)}).`,
            );
          }
        }

        const sale = await tx.sale.create({
          data: {
            seller_id: sellerId,
            customer_id: customerId,
            total_amount: grandTotal,
            amount_paid: settlement.amount_paid,
            remaining: settlement.remaining,
            status: settlement.status,
            payment_method: paymentMethod,
            notes,
            repayment_date: settlement.repayment_date,
          },
        });

        for (const line of lines) {
          const product = productsById.get(line.product_id)!;

          await take_stock(tx, product.id, product.name, line.quantity);

          await tx.saleItem.create({
            data: {
              sale_id: sale.id,
              product_id: product.id,
              product_name: product.name,
              quantity: line.quantity,
              unit_price: line.unit_price,
              total_price: round_money(line.quantity * line.unit_price),
              cost_price: product.cost_price,
            },
          });
        }
      },
      // Each cart line is a few round trips; leave room for large carts.
      { timeout: 15000 },
    );

    // Revalidate paths that show stock and sales
    revalidatePath("/terminal");
    revalidatePath("/inventory");
    revalidatePath("/sales");

    return { success: true };
  } catch (error: unknown) {
    if (error instanceof AuthError || error instanceof RuleError) {
      return { error: error.message };
    }
    console.error("Checkout failed:", error);
    return { error: "An error occurred while finishing the sale." };
  }
}
