"use server";

import { prisma } from "@/lib/db";
import { PAGE_SIZE } from "./constants";
import { format_sale_row } from "@/utils/helpers";
import { requireAdmin, AuthError } from "@/lib/auth-guard";
import { range_from_day_strings } from "@/lib/dates";
import { RuleError } from "@/lib/sale-rules";
import { return_stock } from "@/lib/stock";

export type SaleRow = {
  id: string;
  created_at: Date;
  total_amount: number;
  amount_paid: number;
  remaining: number;
  status: string;
  payment_method: string;
  repayment_date: Date;
  notes: string | null;
  items_count: number;
  customer_name: string | null;
  customer_id: string | null;
  items: {
    quantity: number;
    unit_price: number;
    total_price: number;
    product_id: string;
    name: string;
    image: string;
  }[];
  seller_name: string | null;
  seller_id: string | null;
  seller_image: string | null;
};

export type SaleStats = {
  total_sales_count: number;
  total_revenue: number;
  avg_order_value: number;
  last_sale_at: Date | null;
};

export async function get_sales(
  page: number = 1,
  start_date?: string,
  end_date?: string,
): Promise<{ sales: SaleRow[]; total: number }> {
  const where = {
    ...(start_date && end_date
      ? (() => {
          const range = range_from_day_strings(start_date, end_date);
          return { created_at: { gte: range.start, lte: range.end } };
        })()
      : {}),
  };

  const [sales, total] = await Promise.all([
    prisma.sale.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        customer: { select: { name: true, id: true } },
        _count: { select: { sale_items: true } },
        sale_items: {
          select: {
            product_id: true,
            quantity: true,
            unit_price: true,
            total_price: true,
            product: {
              select: {
                name: true,
                image: true,
              },
            },
          },
        },
        seller: {
          select: {
            name: true,
            id: true,
            image: true,
          },
        },
      },
    }),
    prisma.sale.count({ where }),
  ]);

  return {
    sales: sales.map(format_sale_row),
    total,
  };
}

export async function get_sale_stats(
  start_date?: string,
  end_date?: string,
): Promise<SaleStats> {
  const where = {
    ...(start_date && end_date
      ? (() => {
          const range = range_from_day_strings(start_date, end_date);
          return { created_at: { gte: range.start, lte: range.end } };
        })()
      : {}),
  };

  const [agg, lastSale] = await Promise.all([
    prisma.sale.aggregate({
      where,
      _count: { id: true },
      _sum: { total_amount: true },
      _avg: { total_amount: true },
    }),
    prisma.sale.findFirst({
      where,
      orderBy: { created_at: "desc" },
      select: { created_at: true },
    }),
  ]);

  return {
    total_sales_count: agg._count.id,
    total_revenue: agg._sum.total_amount ?? 0,
    avg_order_value: agg._avg.total_amount ?? 0,
    last_sale_at: lastSale?.created_at ?? null,
  };
}

import { revalidatePath } from "next/cache";

export async function delete_sale(
  sale_id: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin();

    await prisma.$transaction(async (tx) => {
      // Lock the sale first. Recording a repayment updates this same row, so
      // a payment can't land between the check below and the delete.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "sales" WHERE id = ${sale_id} FOR UPDATE`;
      if (locked.length === 0) {
        throw new RuleError("Sale not found.");
      }

      const repaymentsCount = await tx.repayment.count({
        where: { sale_id },
      });
      if (repaymentsCount > 0) {
        throw new RuleError(
          "Cannot delete sale with expected repayment tracking.",
        );
      }

      const items = await tx.saleItem.findMany({
        where: { sale_id },
        select: { product_id: true, quantity: true },
      });
      for (const item of items) {
        await return_stock(tx, item.product_id, item.quantity);
      }

      await tx.sale.delete({
        where: { id: sale_id },
      });
    });

    revalidatePath("/sales");
    return { success: true };
  } catch (error: unknown) {
    if (error instanceof AuthError || error instanceof RuleError) {
      return { success: false, error: error.message };
    }
    console.error("Failed to delete sale:", error);
    return {
      success: false,
      error: "An unexpected error occurred while deleting the sale.",
    };
  }
}
