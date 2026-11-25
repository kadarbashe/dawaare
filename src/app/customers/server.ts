"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { requireSession, AuthError } from "@/lib/auth-guard";
import {
  is_payment_method,
  round_money,
  RuleError,
  status_after_repayment,
} from "@/lib/sale-rules";

interface ActionResult {
  success: boolean;
  error?: string;
}

export async function createCustomer(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const name = formData.get("name") as string;
  const phone = formData.get("phone") as string;
  const email = formData.get("email") as string | null;
  const address = formData.get("address") as string | null;
  const notes = formData.get("notes") as string | null;

  if (!name || !phone) {
    return {
      success: false,
      error: "Please fill in all required fields (Name and Phone).",
    };
  }

  try {
    await requireSession();

    // Check if phone already exists since it's unique
    const existing = await prisma.customer.findUnique({
      where: { phone },
    });

    if (existing) {
      return {
        success: false,
        error: "A customer with this phone number already exists.",
      };
    }

    await prisma.customer.create({
      data: {
        name,
        phone,
        email: email || null,
        address: address || null,
        notes: notes || null,
      },
    });

    revalidatePath("/customers");
    return { success: true };
  } catch (error) {
    if (error instanceof AuthError) {
      return { success: false, error: error.message };
    }
    console.error("Failed to create customer:", error);

    return {
      success: false,
      error: "Failed to save customer. Please try again.",
    };
  }
}

export async function repayDebt(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const saleId = formData.get("saleId") as string;
  const paymentAmountStr = formData.get("paymentAmount") as string;
  const paymentMethod = formData.get("paymentMethod") as string;

  if (!saleId || !paymentAmountStr || !paymentMethod) {
    return { success: false, error: "Missing required fields." };
  }

  const paymentAmount = round_money(Number(paymentAmountStr));

  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
    return { success: false, error: "Invalid payment amount." };
  }

  if (!is_payment_method(paymentMethod)) {
    return { success: false, error: "Invalid payment method." };
  }

  try {
    await requireSession();

    await prisma.$transaction(async (tx) => {
      // The balance check is part of the update, so two people recording a
      // payment on the same debt at once can't both get through.
      const { count } = await tx.sale.updateMany({
        where: { id: saleId, remaining: { gte: paymentAmount - 0.005 } },
        data: {
          remaining: { decrement: paymentAmount },
          amount_paid: { increment: paymentAmount },
        },
      });

      if (count === 0) {
        const exists = await tx.sale.findUnique({
          where: { id: saleId },
          select: { id: true },
        });
        throw new RuleError(
          exists ? "Payment amount exceeds remaining debt." : "Sale not found.",
        );
      }

      // Clean up float drift and set the status from the new balance.
      const sale = await tx.sale.findUniqueOrThrow({
        where: { id: saleId },
        select: { remaining: true, amount_paid: true },
      });
      const remaining = Math.max(0, round_money(sale.remaining));

      await tx.sale.update({
        where: { id: saleId },
        data: {
          remaining,
          amount_paid: round_money(sale.amount_paid),
          status: status_after_repayment(remaining),
        },
      });

      await tx.repayment.create({
        data: {
          sale_id: saleId,
          repaid_amount: paymentAmount,
          payment_method: paymentMethod,
        },
      });
    });

    revalidatePath("/customers");

    return { success: true };
  } catch (error) {
    if (error instanceof AuthError || error instanceof RuleError) {
      return { success: false, error: error.message };
    }
    console.error("Failed to process payment:", error);

    return {
      success: false,
      error: "Failed to process payment. Please try again.",
    };
  }
}
