"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { requireSession, AuthError } from "@/lib/auth-guard";
import type { Prisma } from "@prisma/client";
import {
  is_low_stock_qty,
  parse_product_numbers,
  RuleError,
} from "@/lib/sale-rules";

interface ActionResult {
  status: string;
  message: string;
}

// Uploaded images are not deleted here when saving fails. The product modals
// keep the upload so the form can be resubmitted, and delete it themselves
// if it is closed unsaved. Deleting here used to remove a product's live
// image whenever an edit failed.

export async function createProduct(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const name = formData.get("name") as string;
  const sku = formData.get("sku") as string;
  const category = formData.get("category") as string;
  const image = formData.get("image") as string;
  const public_id = formData.get("public_id") as string;

  if (!name || !sku || !category || !image) {
    return { status: "error", message: "Please fill in all required fields." };
  }

  try {
    const { price, cost_price, stock_qty } = parse_product_numbers(
      formData.get("price"),
      formData.get("cost_price"),
      formData.get("stock_qty"),
    );

    await requireSession();

    const existingProduct = await prisma.product.findUnique({
      where: { sku },
    });

    if (existingProduct) {
      return {
        status: "error",
        message: "Product with this SKU already exists.",
      };
    }

    const categoryRow = await prisma.itemsCategory.findUnique({
      where: { name: category },
    });
    if (!categoryRow) {
      return { status: "error", message: "Choose a valid category." };
    }

    await prisma.$transaction([
      prisma.product.create({
        data: {
          name,
          sku,
          category,
          price,
          cost_price,
          stock_qty,
          is_low_stock: is_low_stock_qty(stock_qty),
          image,
          public_id,
        },
      }),
      prisma.itemsCategory.update({
        where: { id: categoryRow.id },
        data: { count: { increment: 1 } },
      }),
    ]);

    revalidatePath("/inventory");
    return { status: "success", message: "Product created successfully" };
  } catch (error) {
    if (error instanceof AuthError || error instanceof RuleError) {
      return { status: "error", message: error.message };
    }
    console.error("Failed to create product:", error);

    return {
      status: "error",
      message: "Failed to save product. Please try again.",
    };
  }
}

export async function updateProduct(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const id = formData.get("id") as string;
  const name = formData.get("name") as string;
  const sku = formData.get("sku") as string;
  const category = formData.get("category") as string;
  const image = formData.get("image") as string;
  const public_id = formData.get("public_id") as string;

  if (!id || !name || !sku || !category || !image) {
    return { status: "error", message: "Please fill in all required fields." };
  }

  try {
    const { price, cost_price, stock_qty } = parse_product_numbers(
      formData.get("price"),
      formData.get("cost_price"),
      formData.get("stock_qty"),
    );

    await requireSession();

    const existing = await prisma.product.findUnique({
      where: { id },
      select: { sku: true, category: true },
    });
    if (!existing) {
      return { status: "error", message: "Product not found." };
    }

    if (sku !== existing.sku) {
      const skuTaken = await prisma.product.findUnique({
        where: { sku },
        select: { id: true },
      });
      if (skuTaken) {
        return {
          status: "error",
          message: "Another product already uses this SKU.",
        };
      }
    }

    const updates: Prisma.PrismaPromise<unknown>[] = [
      prisma.product.update({
        where: { id },
        data: {
          name,
          sku,
          category,
          price,
          cost_price,
          stock_qty,
          is_low_stock: is_low_stock_qty(stock_qty),
          image,
          public_id,
        },
      }),
    ];

    // Category counts move only when the category actually changes, judged
    // against what is stored rather than what the form claims.
    if (category !== existing.category) {
      const newCategory = await prisma.itemsCategory.findUnique({
        where: { name: category },
      });
      if (!newCategory) {
        return { status: "error", message: "Choose a valid category." };
      }

      updates.push(
        prisma.itemsCategory.updateMany({
          where: { name: existing.category, count: { gt: 0 } },
          data: { count: { decrement: 1 } },
        }),
        prisma.itemsCategory.update({
          where: { id: newCategory.id },
          data: { count: { increment: 1 } },
        }),
      );
    }

    await prisma.$transaction(updates);

    revalidatePath("/inventory");
    return { status: "success", message: "Product updated successfully" };
  } catch (error) {
    if (error instanceof AuthError || error instanceof RuleError) {
      return { status: "error", message: error.message };
    }
    console.error("Failed to update product:", error);

    return {
      status: "error",
      message: "Failed to update product. Please try again.",
    };
  }
}
